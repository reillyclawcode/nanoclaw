/**
 * NanoClaw Web Dashboard Channel
 * Plugs into NanoClaw as a native channel — same agent, same memory, same context.
 *
 * Install: copy this file to /workspace/project/src/channels/web.ts
 * Then add `import './web.js';` to /workspace/project/src/channels/index.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';

import { setRegisteredGroup } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const WEB_JID = 'web:dashboard';
const WEB_SENDER = 'web-user';
const DEFAULT_PORT = 3000;
const CHAT_MAX_MSGS = 500;
const UPLOAD_MAX_MB = 10;

// ── Auth rate limiter ────────────────────────────────────────────────────────
const MAX_ATTEMPTS = 5; // failures before lockout
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5-minute counting window
const LOCKOUT_MS = 15 * 60 * 1000; // 15-minute lockout

interface AttemptRecord {
  count: number;
  windowStart: number;
  lockedUntil: number | null;
}
const authAttempts = new Map<string, AttemptRecord>();

function getForwardedIp(
  headers: Record<string, string | string[] | undefined>,
  fallback: string,
): string {
  const xff = headers['x-forwarded-for'];
  if (xff) return (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
  return fallback;
}

function checkRateLimit(ip: string): { blocked: boolean; secondsLeft: number } {
  const now = Date.now();
  const rec = authAttempts.get(ip);
  if (rec?.lockedUntil && now < rec.lockedUntil) {
    return {
      blocked: true,
      secondsLeft: Math.ceil((rec.lockedUntil - now) / 1000),
    };
  }
  return { blocked: false, secondsLeft: 0 };
}

function recordFailedAttempt(ip: string): {
  blocked: boolean;
  secondsLeft: number;
} {
  const now = Date.now();
  let rec = authAttempts.get(ip);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) {
    rec = { count: 0, windowStart: now, lockedUntil: null };
  }
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    authAttempts.set(ip, rec);
    return { blocked: true, secondsLeft: Math.ceil(LOCKOUT_MS / 1000) };
  }
  authAttempts.set(ip, rec);
  return { blocked: false, secondsLeft: 0 };
}

function clearAttempts(ip: string): void {
  authAttempts.delete(ip);
}

// Clean up stale entries every 30 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, rec] of authAttempts.entries()) {
      if (!rec.lockedUntil && now - rec.windowStart > ATTEMPT_WINDOW_MS)
        authAttempts.delete(ip);
      if (rec.lockedUntil && now > rec.lockedUntil) authAttempts.delete(ip);
    }
  },
  30 * 60 * 1000,
);

// ── Multi-user helpers ───────────────────────────────────────────────────────

interface UserMap {
  [username: string]: string; // username → password
}

function parseUsers(
  usersEnv: string | undefined,
  singlePassEnv: string | undefined,
): UserMap {
  const map: UserMap = {};
  if (usersEnv) {
    // Format: "alice:pass1,bob:pass2"
    for (const pair of usersEnv.split(',')) {
      const colon = pair.indexOf(':');
      if (colon < 1) continue;
      const username = pair.slice(0, colon).trim();
      const password = pair.slice(colon + 1).trim();
      if (username && password) map[username] = password;
    }
  }
  if (Object.keys(map).length === 0 && singlePassEnv) {
    map['user'] = singlePassEnv;
  }
  return map;
}

// ── Channel Implementation ───────────────────────────────────────────────────

export class WebChannel implements Channel {
  name = 'web';

  private opts: ChannelOpts;
  private io: SocketIOServer | null = null;
  private connected = false;
  private users: UserMap;
  private port: number;
  // socketId → username
  private authedSockets = new Map<string, string>();
  private projectRoot: string;

  constructor(opts: ChannelOpts, users: UserMap, port: number) {
    this.opts = opts;
    this.users = users;
    this.port = port;
    // Resolve project root from compiled location: dist/channels/web.js → up 2
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.projectRoot = path.resolve(__dirname, '..', '..');
  }

  // Backward-compat: primary password is first entry
  private get password(): string {
    return Object.values(this.users)[0] ?? '';
  }

  private get authedSocketIds(): Set<string> {
    return new Set(this.authedSockets.keys());
  }

  // Auto-register the web group in-memory + DB, always updating containerConfig
  private ensureGroupRegistered(): void {
    const groups = this.opts.registeredGroups();
    const assistantName =
      readEnvFile(['ASSISTANT_NAME'])['ASSISTANT_NAME'] || 'Andy';
    const existing = groups[WEB_JID];
    const group: RegisteredGroup = {
      name: 'Web Dashboard',
      folder: 'web-dashboard',
      trigger: `@${assistantName}`,
      added_at: existing?.added_at ?? new Date().toISOString(),
      requiresTrigger: false,
      containerConfig: {
        additionalMounts: [
          {
            hostPath: path.join(this.projectRoot, 'dashboard', 'public'),
            containerPath: 'dashboard-public',
            readonly: false,
          },
        ],
      },
    };

    groups[WEB_JID] = group;
    setRegisteredGroup(WEB_JID, group);
    fs.mkdirSync(
      path.join(this.projectRoot, 'groups', 'web-dashboard', 'logs'),
      { recursive: true },
    );

    logger.info({ jid: WEB_JID }, 'Web Dashboard group auto-registered');
  }

  async connect(): Promise<void> {
    this.ensureGroupRegistered();

    const app = express();
    const httpServer = createServer(app);
    const allowedOrigin = (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ): void => {
      if (!origin) {
        callback(null, true);
        return;
      } // same-origin / server-side
      const trusted = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
        /^https?:\/\/100\.\d+\.\d+\.\d+(:\d+)?$/, // Tailscale range
        /\.ngrok-free\.dev$/,
        /\.ngrok-free\.app$/,
        /\.ngrok\.io$/,
      ];
      if (trusted.some((r) => r.test(origin))) {
        callback(null, true);
      } else {
        logger.warn({ origin }, 'Web Dashboard: CORS blocked origin');
        callback(new Error('Not allowed by CORS'));
      }
    };
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: allowedOrigin,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true,
      },
    });

    // ── Static files ─────────────────────────────────────────────────────────
    const publicDir = path.join(this.projectRoot, 'dashboard', 'public');
    app.use(
      express.static(publicDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader(
              'Cache-Control',
              'no-store, no-cache, must-revalidate, max-age=0',
            );
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          }
        },
      }),
    );

    app.use(express.json({ limit: '2mb' }));

    const dataDir = path.join(this.projectRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    // Legacy shared-file paths — kept only for one-time migration
    const projectsFile = path.join(dataDir, 'projects.json');
    const chatFile = path.join(dataDir, 'web-chat-history.json');
    const reportsFile = path.join(dataDir, 'project-reports.json');
    const analyticsFile = path.join(dataDir, 'analytics.json');
    const kanbanFile = path.join(dataDir, 'kanban.json');
    const customCssFile = path.join(dataDir, 'dashboard-custom.css');
    const uploadsDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    // Per-user data directory
    const usersDir = path.join(dataDir, 'users');
    fs.mkdirSync(usersDir, { recursive: true });

    // ── Helpers ───────────────────────────────────────────────────────────────

    interface ChatMsg {
      role: 'user' | 'assistant';
      who: string;
      text: string;
      ts: number;
    }

    interface ThreadMeta {
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
    }

    const loadJson = <T>(file: string, fallback: T): T => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
      } catch {
        return fallback;
      }
    };
    const writeJson = (file: string, data: unknown): void =>
      fs.writeFileSync(file, JSON.stringify(data, null, 2));

    // ── Per-user data helpers ─────────────────────────────────────────────────

    // Primary user is the first entry in WEB_USERS (gets migrated from legacy files)
    const primaryUser = Object.keys(this.users)[0] ?? 'user';

    const userDataDir = (username: string): string => {
      const dir = path.join(usersDir, username);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const userProjectsFile = (u: string) =>
      path.join(userDataDir(u), 'projects.json');
    const userChatFile = (u: string) =>
      path.join(userDataDir(u), 'chat-history.json');
    const userReportsFile = (u: string) =>
      path.join(userDataDir(u), 'project-reports.json');
    const userThreadsDir = (u: string): string => {
      const dir = path.join(userDataDir(u), 'threads');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const userThreadsIndexFile = (u: string) =>
      path.join(userThreadsDir(u), 'index.json');
    const userThreadFile = (u: string, id: string) =>
      path.join(userThreadsDir(u), `${id}.json`);

    // One-time migration: copy legacy shared files → primary user on first access
    const ensureUserMigrated = (username: string): void => {
      if (username !== primaryUser) return;
      const pf = userProjectsFile(username);
      if (!fs.existsSync(pf) && fs.existsSync(projectsFile))
        fs.copyFileSync(projectsFile, pf);
      const cf = userChatFile(username);
      if (!fs.existsSync(cf) && fs.existsSync(chatFile))
        fs.copyFileSync(chatFile, cf);
      const rf = userReportsFile(username);
      if (!fs.existsSync(rf) && fs.existsSync(reportsFile))
        fs.copyFileSync(reportsFile, rf);
      const oldThreadsIdx = path.join(dataDir, 'threads', 'index.json');
      const newThreadsIdx = userThreadsIndexFile(username);
      if (!fs.existsSync(newThreadsIdx) && fs.existsSync(oldThreadsIdx)) {
        try {
          fs.cpSync(path.join(dataDir, 'threads'), userThreadsDir(username), {
            recursive: true,
          });
        } catch { /* non-fatal */ }
      }
    };

    // Broadcast helpers
    const broadcastProjectsUpdated = (): void => {
      for (const sid of this.authedSocketIds)
        this.io?.to(sid).emit('projects_updated');
    };
    const broadcastReportUpdated = (key: string): void => {
      for (const sid of this.authedSocketIds)
        this.io?.to(sid).emit('report_updated', { key });
    };

    // Load a user's own projects only (no shared)
    const loadOwnProjects = (username: string): any[] => {
      ensureUserMigrated(username);
      return loadJson<any[]>(userProjectsFile(username), []);
    };

    // Save a user's own projects and broadcast
    const saveOwnProjects = (username: string, projects: object[]): void => {
      ensureUserMigrated(username);
      writeJson(userProjectsFile(username), projects);
      broadcastProjectsUpdated();
    };

    // Load all projects visible to a user (own + shared-with-me)
    const loadUserProjects = (username: string): any[] => {
      const own = loadOwnProjects(username);
      const merged: any[] = [...own];
      for (const other of Object.keys(this.users)) {
        if (other === username) continue;
        ensureUserMigrated(other);
        const others = loadJson<any[]>(userProjectsFile(other), []);
        for (const p of others) {
          if (Array.isArray(p.sharedWith) && p.sharedWith.includes(username)) {
            merged.push({ ...p, _sharedBy: other });
          }
        }
      }
      return merged;
    };

    // Find which user owns a project key
    const findProjectOwner = (key: string): [string, any[]] | null => {
      for (const u of Object.keys(this.users)) {
        ensureUserMigrated(u);
        const projs = loadJson<any[]>(userProjectsFile(u), []);
        if (projs.some((p: any) => p.key === key)) return [u, projs];
      }
      return null;
    };

    // Reports helpers (scoped to project owner's file)
    const loadOwnReports = (username: string): Record<string, unknown> => {
      ensureUserMigrated(username);
      return loadJson<Record<string, unknown>>(userReportsFile(username), {});
    };

    const loadUserReports = (username: string): Record<string, unknown> => {
      const own = loadOwnReports(username);
      const result: Record<string, unknown> = { ...own };
      // Include reports for projects shared with me
      for (const other of Object.keys(this.users)) {
        if (other === username) continue;
        ensureUserMigrated(other);
        const otherProjs = loadJson<any[]>(userProjectsFile(other), []);
        const otherReports = loadOwnReports(other);
        for (const p of otherProjs) {
          if (Array.isArray(p.sharedWith) && p.sharedWith.includes(username)) {
            if (p.key in otherReports) result[p.key] = otherReports[p.key];
          }
        }
      }
      return result;
    };

    const saveProjectReport = (
      key: string,
      data: unknown,
      requestingUser: string,
    ): void => {
      // Save to owner's reports file
      let ownerUser = requestingUser;
      const ownProjs = loadJson<any[]>(userProjectsFile(requestingUser), []);
      if (!ownProjs.some((p: any) => p.key === key)) {
        const found = findProjectOwner(key);
        if (found) ownerUser = found[0];
      }
      const reports = loadOwnReports(ownerUser);
      reports[key] = data;
      writeJson(userReportsFile(ownerUser), reports);
      broadcastReportUpdated(key);
    };

    // Chat helpers (per user)
    const loadUserChat = (username: string): ChatMsg[] => {
      ensureUserMigrated(username);
      return loadJson<ChatMsg[]>(userChatFile(username), []);
    };
    const appendUserChat = (username: string, msg: ChatMsg): void => {
      ensureUserMigrated(username);
      const history = loadUserChat(username);
      history.push(msg);
      fs.writeFileSync(
        userChatFile(username),
        JSON.stringify(history.slice(-CHAT_MAX_MSGS)),
      );
    };

    const loadCustomCss = (): string => {
      try {
        return fs.readFileSync(customCssFile, 'utf8');
      } catch {
        return '';
      }
    };
    const saveCustomCss = (css: string): void => {
      fs.writeFileSync(customCssFile, css);
      for (const sid of this.authedSocketIds)
        this.io?.to(sid).emit('dashboard_css_updated');
    };

    // Analytics: {date: {sent: N, received: N}}
    const trackAnalytic = (type: 'sent' | 'received'): void => {
      const date = new Date().toISOString().slice(0, 10);
      const data = loadJson<Record<string, { sent: number; received: number }>>(
        analyticsFile,
        {},
      );
      if (!data[date]) data[date] = { sent: 0, received: 0 };
      data[date][type]++;
      writeJson(analyticsFile, data);
    };

    // ── Auth middleware ───────────────────────────────────────────────────────
    const requireRestAuth = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      const ip = getForwardedIp(
        req.headers as Record<string, string | string[] | undefined>,
        req.ip ?? 'unknown',
      );
      const { blocked, secondsLeft } = checkRateLimit(ip);
      if (blocked) {
        logger.warn(
          { ip },
          `Web Dashboard: REST blocked (rate limit, ${secondsLeft}s remaining)`,
        );
        res.status(429).json({
          error: `Too many failed attempts. Try again in ${secondsLeft} seconds.`,
        });
        return;
      }
      const pw = req.headers['x-dashboard-password'] as string;
      // Reverse-lookup username from password so every endpoint knows who's calling
      const found = Object.entries(this.users).find(([, p]) => p === pw);
      if (!found) {
        const result = recordFailedAttempt(ip);
        logger.warn(
          { ip, blocked: result.blocked },
          'Web Dashboard: REST auth failed',
        );
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      res.locals.dashUser = found[0];
      clearAttempts(ip);
      next();
    };

    // ── File upload ───────────────────────────────────────────────────────────
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const id = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(file.originalname) || '';
        cb(null, `${id}${ext}`);
      },
    });
    const upload = multer({
      storage,
      limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = /image\/(jpeg|png|gif|webp)|application\/pdf/;
        cb(null, allowed.test(file.mimetype));
      },
    });

    app.use('/uploads', express.static(uploadsDir));

    app.post(
      '/api/upload',
      requireRestAuth,
      upload.single('file'),
      (req, res) => {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded' });
          return;
        }
        res.json({
          url: `/uploads/${req.file.filename}`,
          name: req.file.originalname,
          mime: req.file.mimetype,
        });
      },
    );

    // ── Projects API ──────────────────────────────────────────────────────────
    app.get('/api/projects', requireRestAuth, (req, res) => {
      res.json(loadUserProjects(res.locals.dashUser as string));
    });
    app.post('/api/projects', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const projects = loadOwnProjects(username);
      const project = { ...req.body, key: Date.now().toString(36) };
      projects.push(project);
      saveOwnProjects(username, projects);
      res.json(project);
    });
    app.put('/api/projects/:key', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
      // Check own projects first
      const ownProjects = loadOwnProjects(username);
      const ownIdx = ownProjects.findIndex((p: any) => p.key === key);
      if (ownIdx >= 0) {
        ownProjects[ownIdx] = { ...req.body, key };
        saveOwnProjects(username, ownProjects);
        res.json(ownProjects[ownIdx]);
        return;
      }
      // Check shared projects — update in owner's file
      const ownerEntry = findProjectOwner(key);
      if (!ownerEntry) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const [owner, ownerProjects] = ownerEntry;
      const existing = ownerProjects.find((p: any) => p.key === key);
      if (!Array.isArray(existing?.sharedWith) || !existing.sharedWith.includes(username)) {
        res.status(403).json({ error: 'Not authorized' });
        return;
      }
      // Preserve sharedWith — only owner can change it via /share endpoint
      const updated = { ...req.body, key, sharedWith: existing.sharedWith };
      const newOwnerProjects = ownerProjects.map((p: any) =>
        p.key === key ? updated : p,
      );
      saveOwnProjects(owner, newOwnerProjects);
      res.json(updated);
    });
    app.delete('/api/projects/:key', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const key = req.params.key;
      const ownProjects = loadOwnProjects(username);
      if (!ownProjects.some((p: any) => p.key === key)) {
        res.status(403).json({ error: 'Only the project owner can delete a project' });
        return;
      }
      saveOwnProjects(username, ownProjects.filter((p: any) => p.key !== key));
      res.json({ ok: true });
    });

    // Share a project with other users: POST /api/projects/:key/share
    // Body: { sharedWith: ["cyrena"] }  — replaces the entire sharedWith list
    app.post('/api/projects/:key/share', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const key = req.params.key;
      const ownProjects = loadOwnProjects(username);
      const idx = ownProjects.findIndex((p: any) => p.key === key);
      if (idx < 0) {
        res.status(403).json({ error: 'Only the project owner can share a project' });
        return;
      }
      const sharedWith: string[] = Array.isArray(req.body?.sharedWith)
        ? req.body.sharedWith
        : [];
      ownProjects[idx] = { ...ownProjects[idx], sharedWith };
      saveOwnProjects(username, ownProjects);
      res.json(ownProjects[idx]);
    });

    // ── Project reports API ───────────────────────────────────────────────────
    app.get('/api/project-reports', requireRestAuth, (req, res) => {
      res.json(loadUserReports(res.locals.dashUser as string));
    });
    app.post('/api/project-reports/:key', requireRestAuth, (req, res) => {
      const key = Array.isArray(req.params.key)
        ? req.params.key[0]
        : req.params.key;
      saveProjectReport(key, req.body, res.locals.dashUser as string);
      res.json({ ok: true });
    });

    // ── Chat history API ──────────────────────────────────────────────────────
    app.get('/api/chat', requireRestAuth, (req, res) => {
      res.json(loadUserChat(res.locals.dashUser as string));
    });
    app.delete('/api/chat', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      try {
        ensureUserMigrated(username);
        fs.writeFileSync(userChatFile(username), '[]');
      } catch {}
      res.json({ ok: true });
    });

    // ── Threads API ───────────────────────────────────────────────────────────
    app.get('/api/threads', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      ensureUserMigrated(username);
      res.json(loadJson<ThreadMeta[]>(userThreadsIndexFile(username), []));
    });

    // Archive current chat as a new named thread
    app.post('/api/threads', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      ensureUserMigrated(username);
      const title = req.body?.title || `Thread ${Date.now()}`;
      const id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const now = new Date().toISOString();
      const current = loadUserChat(username);
      fs.writeFileSync(userThreadFile(username, id), JSON.stringify(current));
      const list = loadJson<ThreadMeta[]>(userThreadsIndexFile(username), []);
      list.unshift({ id, title, createdAt: now, updatedAt: now });
      writeJson(userThreadsIndexFile(username), list);
      res.json({ id, title, createdAt: now, updatedAt: now });
    });

    app.get('/api/threads/:id', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const id = req.params.id as string;
      const messages = loadJson<ChatMsg[]>(userThreadFile(username, id), []);
      res.json(messages);
    });

    app.put('/api/threads/:id', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const id = req.params.id as string;
      ensureUserMigrated(username);
      const list = loadJson<ThreadMeta[]>(userThreadsIndexFile(username), []);
      const t = list.find((x) => x.id === id);
      if (!t) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (req.body?.title) t.title = req.body.title;
      t.updatedAt = new Date().toISOString();
      writeJson(userThreadsIndexFile(username), list);
      res.json(t);
    });

    app.delete('/api/threads/:id', requireRestAuth, (req, res) => {
      const username = res.locals.dashUser as string;
      const id = req.params.id as string;
      ensureUserMigrated(username);
      try {
        fs.unlinkSync(userThreadFile(username, id));
      } catch {}
      const list = loadJson<ThreadMeta[]>(userThreadsIndexFile(username), []);
      writeJson(userThreadsIndexFile(username), list.filter((x) => x.id !== id));
      res.json({ ok: true });
    });

    // ── Analytics API ─────────────────────────────────────────────────────────
    app.get('/api/analytics', requireRestAuth, (_req, res) => {
      res.json(loadJson(analyticsFile, {}));
    });

    // ── Kanban API ────────────────────────────────────────────────────────────
    interface KanbanCard {
      id: string;
      title: string;
      body?: string;
      color?: string;
    }
    interface KanbanBoard {
      todo: KanbanCard[];
      inprogress: KanbanCard[];
      done: KanbanCard[];
    }
    const DEFAULT_BOARD: KanbanBoard = { todo: [], inprogress: [], done: [] };

    app.get('/api/kanban', requireRestAuth, (_req, res) => {
      res.json(loadJson<KanbanBoard>(kanbanFile, DEFAULT_BOARD));
    });
    app.put('/api/kanban', requireRestAuth, (req, res) => {
      writeJson(kanbanFile, req.body);
      for (const sid of this.authedSocketIds)
        this.io?.to(sid).emit('kanban_updated');
      res.json({ ok: true });
    });

    // ── Users API (list usernames only, not passwords) ────────────────────────
    app.get('/api/users', requireRestAuth, (_req, res) => {
      res.json(Object.keys(this.users));
    });

    // ── Custom CSS API ─────────────────────────────────────────────────────────
    app.get('/api/dashboard-css', (_req, res) => {
      res.type('text/css').send(loadCustomCss());
    });
    app.put('/api/dashboard-css', requireRestAuth, (req, res) => {
      const css =
        typeof req.body === 'string' ? req.body : (req.body?.css ?? '');
      saveCustomCss(css);
      res.json({ ok: true, bytes: css.length });
    });
    app.put(
      '/api/dashboard-css/raw',
      requireRestAuth,
      express.text({ type: '*/*', limit: '1mb' }),
      (req, res) => {
        saveCustomCss(req.body || '');
        res.json({ ok: true, bytes: (req.body || '').length });
      },
    );

    // ── Public read-only project share ────────────────────────────────────────
    // /api/public/projects/:key — no auth required, returns project + latest report
    app.get('/api/public/projects/:key', (req, res) => {
      const key = Array.isArray(req.params.key)
        ? req.params.key[0]
        : req.params.key;
      const ownerEntry = findProjectOwner(key);
      if (!ownerEntry) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const [owner, ownerProjects] = ownerEntry;
      const project = ownerProjects.find((p: any) => p.key === key);
      const reports = loadOwnReports(owner);
      const report = (reports[key] as any) || null;
      res.json({ project, report });
    });

    // /p/:key — serves the standalone public share page
    app.get('/p/:key', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(publicDir, 'share.html'));
    });

    // ── SPA fallback ──────────────────────────────────────────────────────────
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });

    // ── Socket.io ─────────────────────────────────────────────────────────────
    this.io.on('connection', (socket) => {
      logger.debug({ socketId: socket.id }, 'Web Dashboard: client connected');

      socket.on(
        'auth',
        ({ password, username }: { password: string; username?: string }) => {
          const ip = getForwardedIp(
            socket.handshake.headers as Record<
              string,
              string | string[] | undefined
            >,
            socket.handshake.address,
          );

          // Rate-limit check
          const { blocked, secondsLeft } = checkRateLimit(ip);
          if (blocked) {
            logger.warn(
              { ip },
              `Web Dashboard: socket auth blocked (rate limit, ${secondsLeft}s remaining)`,
            );
            socket.emit('auth_fail', {
              error: `Too many failed attempts. Try again in ${secondsLeft} seconds.`,
            });
            return;
          }

          // Support both: single-password (legacy) and username+password (multi-user)
          let authedUser: string | null = null;
          if (username && this.users[username] === password) {
            authedUser = username;
          } else {
            // Legacy: match by password alone
            const found = Object.entries(this.users).find(
              ([, p]) => p === password,
            );
            if (found) authedUser = found[0];
          }

          if (authedUser) {
            clearAttempts(ip);
            this.authedSockets.set(socket.id, authedUser);
            socket.emit('auth_ok', { username: authedUser });
            logger.info(
              { socketId: socket.id, user: authedUser, ip },
              'Web Dashboard: authenticated',
            );
          } else {
            const result = recordFailedAttempt(ip);
            const msg = result.blocked
              ? `Too many failed attempts. Try again in ${result.secondsLeft} seconds.`
              : 'Invalid password';
            socket.emit('auth_fail', { error: msg });
            logger.warn(
              {
                socketId: socket.id,
                ip,
                blocked: result.blocked,
                username: username ?? '(none)',
              },
              'Web Dashboard: auth failed',
            );
          }
        },
      );

      socket.on(
        'message',
        ({ text, imageUrl }: { text: string; imageUrl?: string }) => {
          if (!this.authedSockets.has(socket.id)) {
            socket.emit('error_msg', { message: 'Not authenticated' });
            return;
          }
          if (!text?.trim() && !imageUrl) return;

          const who = this.authedSockets.get(socket.id) ?? WEB_SENDER;
          // Combine text + optional image reference
          let content = text?.trim() || '';
          if (imageUrl) {
            content = content
              ? `${content}\n\n[Attached image: ${imageUrl}]`
              : `[Attached image: ${imageUrl}]`;
          }

          const msg: NewMessage = {
            id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: WEB_JID,
            sender: WEB_SENDER,
            sender_name: who,
            content,
            timestamp: new Date().toISOString(),
            is_from_me: false,
          };

          this.opts.onChatMetadata(
            WEB_JID,
            msg.timestamp,
            'Web Dashboard',
            'web',
            false,
          );
          this.opts.onMessage(WEB_JID, msg);

          socket.emit('user_message', { text: content, timestamp: Date.now() });
          appendUserChat(who, { role: 'user', who, text: content, ts: Date.now() });
          trackAnalytic('sent');

          logger.debug(
            { preview: content.slice(0, 80) },
            'Web Dashboard: message received',
          );
        },
      );

      socket.on('disconnect', () => {
        this.authedSockets.delete(socket.id);
        logger.debug(
          { socketId: socket.id },
          'Web Dashboard: client disconnected',
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(this.port, () => {
        logger.info(
          `🌐 NanoClaw Web Dashboard → http://localhost:${this.port}`,
        );
        resolve();
      });
      httpServer.on('error', reject);
    });

    // ── Live dashboard reload ─────────────────────────────────────────────────
    // Watch index.html for changes (e.g. NanoClaw edits it directly) and push
    // a dashboard_updated event so connected browsers reload automatically.
    const indexHtmlPath = path.join(publicDir, 'index.html');
    let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
    fs.watchFile(indexHtmlPath, { interval: 1500 }, () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        logger.info(
          'dashboard/public/index.html changed — pushing reload to clients',
        );
        this.io?.emit('dashboard_updated');
      }, 800);
    });

    this.connected = true;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.io || !text?.trim()) return;
    const trimmed = text.trim();
    const ts = Date.now();
    for (const socketId of this.authedSocketIds) {
      this.io
        .to(socketId)
        .emit('assistant_message', { text: trimmed, timestamp: ts });
    }
    try {
      const dataDir = path.join(this.projectRoot, 'data');
      const analyticsFile = path.join(dataDir, 'analytics.json');

      // Append assistant reply to each currently connected user's chat history
      const activeUsers = new Set(this.authedSockets.values());
      for (const username of activeUsers) {
        const userChatPath = path.join(
          dataDir,
          'users',
          username,
          'chat-history.json',
        );
        try {
          fs.mkdirSync(path.dirname(userChatPath), { recursive: true });
          let history: any[] = [];
          try {
            history = JSON.parse(fs.readFileSync(userChatPath, 'utf8'));
          } catch { /* start fresh */ }
          history.push({ role: 'assistant', who: 'NanoClaw', text: trimmed, ts });
          fs.writeFileSync(
            userChatPath,
            JSON.stringify(history.slice(-CHAT_MAX_MSGS)),
          );
        } catch { /* non-fatal per-user write failure */ }
      }

      const date = new Date().toISOString().slice(0, 10);
      const analytics: any = (() => {
        try {
          return JSON.parse(fs.readFileSync(analyticsFile, 'utf8'));
        } catch {
          return {};
        }
      })();
      if (!analytics[date]) analytics[date] = { sent: 0, received: 0 };
      analytics[date].received++;
      fs.writeFileSync(analyticsFile, JSON.stringify(analytics, null, 2));
    } catch {
      /* non-fatal */
    }
    logger.debug(
      { chars: trimmed.length },
      'Web Dashboard: response delivered',
    );
  }

  async sendToolEvent(
    _jid: string,
    event: { tool: string; input: unknown; id?: string },
  ): Promise<void> {
    if (!this.io) return;
    for (const socketId of this.authedSocketIds) {
      this.io.to(socketId).emit('tool_use', event);
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.io) return;
    for (const socketId of this.authedSocketIds) {
      this.io.to(socketId).emit('typing', { isTyping });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.io?.close();
    this.connected = false;
  }
}

// ── Default project definitions ──────────────────────────────────────────────

const DEFAULT_PROJECTS = [
  {
    key: 'surf',
    name: 'Surf Report',
    icon: '🏄',
    accentBg: 'rgba(56,189,248,0.12)',
    nameColor: '#7dd3fc',
    prompt:
      "Give me the current surf report. Include: wave height (with a short label like '3-5 ft'), wind speed and direction (e.g. '12 mph Offshore'), water temperature (e.g. '62°F'), and swell period (e.g. '14s'). Lead with a one-sentence overall rating. Then give a detailed breakdown.",
    links: [
      { label: 'Surfline', url: 'https://www.surfline.com' },
      { label: 'Magic Seaweed', url: 'https://magicseaweed.com' },
      { label: 'Surf Forecast', url: 'https://www.surf-forecast.com' },
      { label: 'Windy', url: 'https://www.windy.com' },
    ],
    stats: [
      {
        id: 'waves',
        label: 'Wave Height',
        pattern: '(\\d[\\d\\s\\-\\u2013]*(?:ft|feet))',
        flags: 'i',
      },
      { id: 'wind', label: 'Wind', pattern: '(\\d+\\s*mph)', flags: 'i' },
      { id: 'temp', label: 'Water Temp', pattern: '(\\d+°?F)', flags: 'i' },
      {
        id: 'period',
        label: 'Swell Period',
        pattern: '(\\d+s(?:ec)?(?:onds?)?)',
        flags: 'i',
      },
    ],
  },
  {
    key: 'tide',
    name: 'Tide Chart',
    icon: '🌊',
    accentBg: 'rgba(99,102,241,0.12)',
    nameColor: '#a5b4fc',
    prompt:
      "Give me today's tide schedule. List each high and low tide with its time and height in feet. Start with the very next upcoming tide. Format as a clear list.",
    links: [
      { label: 'NOAA Tides', url: 'https://tidesandcurrents.noaa.gov' },
      { label: 'Tides Chart', url: 'https://www.tideschart.com' },
    ],
    stats: [],
  },
  {
    key: 'weather',
    name: 'Weather',
    icon: '⛅',
    accentBg: 'rgba(251,191,36,0.10)',
    nameColor: '#fde68a',
    prompt:
      "Give me a 7-day weather forecast. For today include: conditions (e.g. 'Sunny'), high/low temperatures (e.g. '72°/58°'), wind, and UV index. Then list each of the next 6 days briefly.",
    links: [
      { label: 'NWS Forecast', url: 'https://forecast.weather.gov' },
      { label: 'Weather.com', url: 'https://www.weather.com' },
      { label: 'Windy', url: 'https://www.windy.com' },
    ],
    stats: [],
  },
  {
    key: 'jobs',
    name: 'Job Search',
    icon: '💼',
    accentBg: 'rgba(52,211,153,0.10)',
    nameColor: '#6ee7b7',
    prompt:
      "Give me a job search update. How many new relevant openings are there? How many applications are in progress? Any interviews or callbacks? What's the top recommended opportunity right now? Give a detailed breakdown.",
    links: [
      { label: 'LinkedIn', url: 'https://www.linkedin.com/jobs' },
      { label: 'Indeed', url: 'https://www.indeed.com' },
      { label: 'Wellfound', url: 'https://wellfound.com' },
      { label: 'Remote.co', url: 'https://remote.co/remote-jobs' },
    ],
    stats: [],
  },
];

// ── Self-register ─────────────────────────────────────────────────────────────

registerChannel('web', (opts: ChannelOpts) => {
  const env = readEnvFile(['WEB_DASHBOARD_PASSWORD', 'WEB_USERS', 'WEB_PORT']);
  const users = parseUsers(env['WEB_USERS'], env['WEB_DASHBOARD_PASSWORD']);
  if (Object.keys(users).length === 0) {
    logger.info(
      'WEB_DASHBOARD_PASSWORD / WEB_USERS not set — web dashboard disabled',
    );
    return null;
  }
  const port = parseInt(env['WEB_PORT'] || String(DEFAULT_PORT), 10);
  return new WebChannel(opts, users, port);
});
