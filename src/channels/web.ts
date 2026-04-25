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

  // Auto-register the web group in-memory + DB if not already registered
  private ensureGroupRegistered(): void {
    const groups = this.opts.registeredGroups();
    if (groups[WEB_JID]) return;

    const assistantName =
      readEnvFile(['ASSISTANT_NAME'])['ASSISTANT_NAME'] || 'Andy';
    const group: RegisteredGroup = {
      name: 'Web Dashboard',
      folder: 'web-dashboard',
      trigger: `@${assistantName}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
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
    this.io = new SocketIOServer(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] },
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

    const projectsFile = path.join(dataDir, 'projects.json');
    const chatFile = path.join(dataDir, 'web-chat-history.json');
    const reportsFile = path.join(dataDir, 'project-reports.json');
    const analyticsFile = path.join(dataDir, 'analytics.json');
    const kanbanFile = path.join(dataDir, 'kanban.json');
    const customCssFile = path.join(dataDir, 'dashboard-custom.css');
    const threadsDir = path.join(dataDir, 'threads');
    const threadsIndexFile = path.join(threadsDir, 'index.json');
    const uploadsDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });

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

    const loadChat = (): ChatMsg[] => loadJson<ChatMsg[]>(chatFile, []);
    const appendChat = (msg: ChatMsg): void => {
      const history = loadChat();
      history.push(msg);
      fs.writeFileSync(chatFile, JSON.stringify(history.slice(-CHAT_MAX_MSGS)));
    };

    const loadReports = () =>
      loadJson<Record<string, unknown>>(reportsFile, {});
    const saveReport = (key: string, data: unknown): void => {
      const reports = loadReports();
      reports[key] = data;
      writeJson(reportsFile, reports);
      for (const sid of this.authedSocketIds)
        this.io?.to(sid).emit('report_updated', { key });
    };

    const loadProjects = () =>
      loadJson<object[]>(projectsFile, DEFAULT_PROJECTS);
    const saveProjects = (projects: object[]): void => {
      writeJson(projectsFile, projects);
      for (const sid of this.authedSocketIds)
        this.io?.to(sid).emit('projects_updated');
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

    // Threads
    const loadThreadsIndex = (): ThreadMeta[] =>
      loadJson<ThreadMeta[]>(threadsIndexFile, []);
    const saveThreadsIndex = (list: ThreadMeta[]): void =>
      writeJson(threadsIndexFile, list);
    const threadFile = (id: string) => path.join(threadsDir, `${id}.json`);

    // ── Auth middleware ───────────────────────────────────────────────────────
    const requireRestAuth = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      const pw = req.headers['x-dashboard-password'] as string;
      const valid = Object.values(this.users).some((p) => p === pw);
      if (!valid) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
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
    app.get('/api/projects', requireRestAuth, (_req, res) => {
      res.json(loadProjects());
    });
    app.post('/api/projects', requireRestAuth, (req, res) => {
      const projects = loadProjects() as any[];
      const project = { ...req.body, key: Date.now().toString(36) };
      projects.push(project);
      saveProjects(projects);
      res.json(project);
    });
    app.put('/api/projects/:key', requireRestAuth, (req, res) => {
      const projects = loadProjects() as any[];
      const i = projects.findIndex((p: any) => p.key === req.params.key);
      if (i < 0) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      projects[i] = { ...req.body, key: req.params.key };
      saveProjects(projects);
      res.json(projects[i]);
    });
    app.delete('/api/projects/:key', requireRestAuth, (req, res) => {
      saveProjects(
        (loadProjects() as any[]).filter((p: any) => p.key !== req.params.key),
      );
      res.json({ ok: true });
    });

    // ── Project reports API ───────────────────────────────────────────────────
    app.get('/api/project-reports', requireRestAuth, (_req, res) => {
      res.json(loadReports());
    });
    app.post('/api/project-reports/:key', requireRestAuth, (req, res) => {
      const key = Array.isArray(req.params.key)
        ? req.params.key[0]
        : req.params.key;
      saveReport(key, req.body);
      res.json({ ok: true });
    });

    // ── Chat history API ──────────────────────────────────────────────────────
    app.get('/api/chat', requireRestAuth, (_req, res) => {
      res.json(loadChat());
    });
    app.delete('/api/chat', requireRestAuth, (_req, res) => {
      try {
        fs.writeFileSync(chatFile, '[]');
      } catch {}
      res.json({ ok: true });
    });

    // ── Threads API ───────────────────────────────────────────────────────────
    app.get('/api/threads', requireRestAuth, (_req, res) => {
      res.json(loadThreadsIndex());
    });

    // Archive current chat as a new named thread
    app.post('/api/threads', requireRestAuth, (req, res) => {
      const title = req.body?.title || `Thread ${Date.now()}`;
      const id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const now = new Date().toISOString();
      // Save current chat to new thread file
      const current = loadChat();
      fs.writeFileSync(threadFile(id), JSON.stringify(current));
      // Update index
      const list = loadThreadsIndex();
      list.unshift({ id, title, createdAt: now, updatedAt: now });
      saveThreadsIndex(list);
      res.json({ id, title, createdAt: now, updatedAt: now });
    });

    app.get('/api/threads/:id', requireRestAuth, (req, res) => {
      const id = req.params.id as string;
      const messages = loadJson<ChatMsg[]>(threadFile(id), []);
      res.json(messages);
    });

    app.put('/api/threads/:id', requireRestAuth, (req, res) => {
      const id = req.params.id as string;
      const list = loadThreadsIndex();
      const t = list.find((x) => x.id === id);
      if (!t) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (req.body?.title) t.title = req.body.title;
      t.updatedAt = new Date().toISOString();
      saveThreadsIndex(list);
      res.json(t);
    });

    app.delete('/api/threads/:id', requireRestAuth, (req, res) => {
      const id = req.params.id as string;
      try {
        fs.unlinkSync(threadFile(id));
      } catch {}
      saveThreadsIndex(loadThreadsIndex().filter((x) => x.id !== id));
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
      const projects = loadProjects() as any[];
      const project = projects.find((p: any) => p.key === key);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const reports = loadReports();
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
            this.authedSockets.set(socket.id, authedUser);
            socket.emit('auth_ok', { username: authedUser });
            logger.info(
              { socketId: socket.id, user: authedUser },
              'Web Dashboard: authenticated',
            );
          } else {
            socket.emit('auth_fail', { error: 'Invalid password' });
            logger.warn({ socketId: socket.id }, 'Web Dashboard: auth failed');
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
          appendChat({ role: 'user', who, text: content, ts: Date.now() });
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
      const chatFile = path.join(dataDir, 'web-chat-history.json');
      const analyticsFile = path.join(dataDir, 'analytics.json');
      const history: any[] = (() => {
        try {
          return JSON.parse(fs.readFileSync(chatFile, 'utf8'));
        } catch {
          return [];
        }
      })();
      history.push({ role: 'assistant', who: 'NanoClaw', text: trimmed, ts });
      fs.writeFileSync(chatFile, JSON.stringify(history.slice(-CHAT_MAX_MSGS)));

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
