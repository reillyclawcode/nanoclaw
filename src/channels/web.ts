/**
 * NanoClaw Web Dashboard Channel
 * Plugs into NanoClaw as a native channel — same agent, same memory, same context.
 *
 * Install: copy this file to /workspace/project/src/channels/web.ts
 * Then add `import './web.js';` to /workspace/project/src/channels/index.ts
 */

import fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

import { setRegisteredGroup } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const WEB_JID = 'web:dashboard';
const WEB_SENDER = 'web-user';
const WEB_SENDER_NAME = 'Reilly';
const DEFAULT_PORT = 3000;
const CHAT_MAX_MSGS = 500;

// ── Channel Implementation ───────────────────────────────────────────────────

export class WebChannel implements Channel {
  name = 'web';

  private opts: ChannelOpts;
  private io: SocketIOServer | null = null;
  private connected = false;
  private password: string;
  private port: number;
  private authedSockets = new Set<string>();
  private projectRoot: string;

  constructor(opts: ChannelOpts, password: string, port: number) {
    this.opts = opts;
    this.password = password;
    this.port = port;
    // Resolve project root from compiled location: dist/channels/web.js → up 2
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.projectRoot = path.resolve(__dirname, '..', '..');
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
      requiresTrigger: false, // Every message goes to the agent — no trigger needed
    };

    // Mutate the in-memory map (registeredGroups() returns the live object reference)
    groups[WEB_JID] = group;
    // Persist to database so it survives restarts
    setRegisteredGroup(WEB_JID, group);
    // Create group folder structure
    fs.mkdirSync(
      path.join(this.projectRoot, 'groups', 'web-dashboard', 'logs'),
      {
        recursive: true,
      },
    );

    logger.info({ jid: WEB_JID }, 'Web Dashboard group auto-registered');
  }

  async connect(): Promise<void> {
    this.ensureGroupRegistered();

    const app = express();
    const httpServer = createServer(app);
    this.io = new SocketIOServer(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    // Serve dashboard static files
    const publicDir = path.join(this.projectRoot, 'dashboard', 'public');
    app.use(express.static(publicDir));

    // ── REST API: Projects ───────────────────────────────────────────────────
    app.use(express.json());

    const dataDir = path.join(this.projectRoot, 'data');
    const projectsFile = path.join(dataDir, 'projects.json');
    const chatFile = path.join(dataDir, 'web-chat-history.json');
    const reportsFile = path.join(dataDir, 'project-reports.json');

    // ── Project report cache helpers ─────────────────────────────────────────
    const loadReports = (): Record<string, unknown> => {
      try {
        return JSON.parse(fs.readFileSync(reportsFile, 'utf8'));
      } catch {
        return {};
      }
    };
    const saveReport = (key: string, data: unknown): void => {
      fs.mkdirSync(dataDir, { recursive: true });
      const reports = loadReports();
      reports[key] = data;
      fs.writeFileSync(reportsFile, JSON.stringify(reports));
      for (const sid of this.authedSockets) {
        this.io?.to(sid).emit('report_updated', { key });
      }
    };

    // ── Chat history helpers ─────────────────────────────────────────────────
    interface ChatMsg {
      role: 'user' | 'assistant';
      who: string;
      text: string;
      ts: number;
    }

    const loadChat = (): ChatMsg[] => {
      try {
        return JSON.parse(fs.readFileSync(chatFile, 'utf8'));
      } catch {
        return [];
      }
    };

    const appendChat = (msg: ChatMsg): void => {
      fs.mkdirSync(dataDir, { recursive: true });
      const history = loadChat();
      history.push(msg);
      // Keep only the most recent messages
      const trimmed = history.slice(-CHAT_MAX_MSGS);
      fs.writeFileSync(chatFile, JSON.stringify(trimmed));
    };

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

    const loadProjects = (): object[] => {
      try {
        return JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      } catch {
        return DEFAULT_PROJECTS;
      }
    };

    const saveProjects = (projects: object[]): void => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
      // Push live update to all authenticated clients
      for (const sid of this.authedSockets) {
        this.io?.to(sid).emit('projects_updated');
      }
    };

    const requireRestAuth = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ): void => {
      if (req.headers['x-dashboard-password'] !== this.password) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    };

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
      const filtered = (loadProjects() as any[]).filter(
        (p: any) => p.key !== req.params.key,
      );
      saveProjects(filtered);
      res.json({ ok: true });
    });

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

    app.get('/api/chat', requireRestAuth, (_req, res) => {
      res.json(loadChat());
    });

    app.delete('/api/chat', requireRestAuth, (_req, res) => {
      try {
        fs.writeFileSync(chatFile, '[]');
      } catch {}
      res.json({ ok: true });
    });

    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });

    // ── Socket.io handlers ──────────────────────────────────────────────────

    this.io.on('connection', (socket) => {
      logger.debug({ socketId: socket.id }, 'Web Dashboard: client connected');

      // Auth
      socket.on('auth', ({ password }: { password: string }) => {
        if (password === this.password) {
          this.authedSockets.add(socket.id);
          socket.emit('auth_ok');
          logger.info({ socketId: socket.id }, 'Web Dashboard: authenticated');
        } else {
          socket.emit('auth_fail', { error: 'Invalid password' });
          logger.warn({ socketId: socket.id }, 'Web Dashboard: auth failed');
        }
      });

      // Inbound message from browser → NanoClaw pipeline
      socket.on('message', ({ text }: { text: string }) => {
        if (!this.authedSockets.has(socket.id)) {
          socket.emit('error_msg', { message: 'Not authenticated' });
          return;
        }
        if (!text?.trim()) return;

        const trimmed = text.trim();
        const msg: NewMessage = {
          id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: WEB_JID,
          sender: WEB_SENDER,
          sender_name: WEB_SENDER_NAME,
          content: trimmed,
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

        // Echo back so the browser can render the user bubble immediately
        socket.emit('user_message', { text: trimmed, timestamp: Date.now() });
        appendChat({
          role: 'user',
          who: WEB_SENDER_NAME,
          text: trimmed,
          ts: Date.now(),
        });
        logger.debug(
          { preview: trimmed.slice(0, 80) },
          'Web Dashboard: message received',
        );
      });

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

  // Called by NanoClaw when the agent produces output
  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.io || !text?.trim()) return;
    const trimmed = text.trim();
    const ts = Date.now();
    for (const socketId of this.authedSockets) {
      this.io
        .to(socketId)
        .emit('assistant_message', { text: trimmed, timestamp: ts });
    }
    // Persist to server-side history (best-effort)
    try {
      const dataDir = path.join(this.projectRoot, 'data');
      const chatFile = path.join(dataDir, 'web-chat-history.json');
      const history: Array<{
        role: string;
        who: string;
        text: string;
        ts: number;
      }> = (() => {
        try {
          return JSON.parse(fs.readFileSync(chatFile, 'utf8'));
        } catch {
          return [];
        }
      })();
      history.push({ role: 'assistant', who: 'NanoClaw', text: trimmed, ts });
      fs.writeFileSync(chatFile, JSON.stringify(history.slice(-CHAT_MAX_MSGS)));
    } catch {
      /* non-fatal */
    }
    logger.debug(
      { chars: trimmed.length },
      'Web Dashboard: response delivered',
    );
  }

  // Show/hide typing indicator in browser
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.io) return;
    for (const socketId of this.authedSockets) {
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

// ── Self-register with NanoClaw channel registry ─────────────────────────────

registerChannel('web', (opts: ChannelOpts) => {
  const env = readEnvFile(['WEB_DASHBOARD_PASSWORD', 'WEB_PORT']);
  const password = env['WEB_DASHBOARD_PASSWORD'];
  if (!password) {
    logger.info('WEB_DASHBOARD_PASSWORD not set — web dashboard disabled');
    return null;
  }
  const port = parseInt(env['WEB_PORT'] || String(DEFAULT_PORT), 10);
  return new WebChannel(opts, password, port);
});
