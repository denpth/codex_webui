import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { TmuxSessions, dimension } from './tmux-sessions.js';

export function sameOrigin(req) {
  if (!req.headers.origin) return false;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch { return false; }
}

export class TerminalServer {
  constructor(server, { command, cwd, spawn = pty.spawn, maxTerminals = 8, maxClients = 32,
    env = process.env, sessions = new TmuxSessions({ command, cwd, maxTerminals, env }) }) {
    Object.assign(this, { cwd, spawn, env, sessions, maxClients });
    this.clients = new Map();
    this.captures = new Map();
    this.tickets = new Map();
    this.disposed = false;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      const ticket = this.tickets.get(url.searchParams.get('ticket'));
      if (this.disposed || url.pathname !== '/terminal/ws' || !sameOrigin(req) || !ticket || ticket.expires < Date.now()) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      this.tickets.delete(url.searchParams.get('ticket'));
      if (this.clients.size >= this.maxClients) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return;
      }
      let terminal;
      try { terminal = this.sessions.open({ terminalId: ticket.id }); }
      catch { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
      this.wss.handleUpgrade(req, socket, head, ws => this.attach(ws, terminal, ticket));
    });
    this.cleanup = setInterval(() => {
      for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
      for (const ws of this.wss.clients) {
        if (ws.alive === false) { ws.terminate(); continue; }
        ws.alive = false; ws.ping();
      }
      // A dead pane remains inspectable, but clients need to know Codex has ended.
      if (this.clients.size) {
        try { this.list(); } catch { /* Preserve clients during transient tmux errors. */ }
      }
    }, 30000);
    this.cleanup.unref();
    // Cropped tmux clients may not emit output for changes outside their viewport.
    this.snapshotPoll = setInterval(() => {
      const active = new Map([...this.clients.values()].filter(c => c.wrapped).map(c => [c.terminal.id, c.terminal]));
      for (const terminal of active.values()) this.scheduleCapture(terminal);
    }, 500);
    this.snapshotPoll.unref();
  }

  list() {
    const sessions = this.sessions.list();
    const byId = new Map(sessions.map(s => [s.id, s]));
    for (const [ws, client] of this.clients) {
      const session = byId.get(client.terminal.id);
      if ((!session || session.exited) && !client.exited) {
        client.exited = true;
        this.send(ws, { type: 'exit', exitCode: session?.exitCode ?? 0 });
      }
    }
    return sessions.map(({ name, ...session }) => session);
  }

  open(options = {}) {
    if (this.disposed) throw Object.assign(new Error('The terminal server is shutting down.'), { status: 503 });
    if (this.tickets.size >= 256) throw Object.assign(new Error('Too many pending terminal connections. Retry shortly.'), { status: 429 });
    const terminal = this.sessions.open(options);
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, { id: terminal.id, cols: dimension(options.cols ?? 100, 20, 400),
      rows: dimension(options.rows ?? 30, 5, 200), expires: Date.now() + 30000 });
    return { id: terminal.id, ticket, exited: terminal.exited, title: terminal.title, sessionId: terminal.sessionId,
      paneCols: terminal.cols, paneRows: terminal.rows };
  }

  send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }

  scheduleCapture(terminal) {
    if (this.disposed || ![...this.clients.values()].some(client => client.terminal.id === terminal.id && client.wrapped)) return;
    let capture = this.captures.get(terminal.id);
    if (!capture) { capture = { timer: null, running: false, dirty: false }; this.captures.set(terminal.id, capture); }
    capture.dirty = true;
    if (capture.timer || capture.running) return;
    capture.timer = setTimeout(async () => {
      capture.timer = null; capture.running = true; capture.dirty = false;
      try {
        const text = await this.sessions.capture(terminal);
        if (!this.disposed) for (const [ws, client] of this.clients) {
          if (client.wrapped && client.terminal.id === terminal.id) {
            if (ws.bufferedAmount > 4 * 1024 * 1024) ws.close(1013, 'Reconnect to catch up');
            else if (client.lastSnapshot !== text) { this.send(ws, { type: 'snapshot', text }); client.lastSnapshot = text; }
          }
        }
      } catch (error) {
        if (!this.disposed) for (const [ws, client] of this.clients) {
          if (client.wrapped && client.terminal.id === terminal.id) this.send(ws, { type: 'error', text: 'Unable to update the wrapped terminal view. Reconnect or use Grid view.' });
        }
      } finally {
        capture.running = false;
        if (capture.dirty && !this.disposed) this.scheduleCapture(terminal);
      }
    }, 120);
    capture.timer.unref();
  }

  detach(ws) {
    const client = this.clients.get(ws);
    if (!client) return;
    this.clients.delete(ws);
    if (![...this.clients.values()].some(other => other.terminal.id === client.terminal.id)) {
      const capture = this.captures.get(client.terminal.id);
      clearTimeout(capture?.timer); this.captures.delete(client.terminal.id);
    }
    // Only this browser's tmux client dies. The detached Codex pane stays alive.
    try { client.proc.kill(); } catch { /* Client already exited. */ }
  }

  attach(ws, terminal, ticket) {
    let proc;
    try {
      proc = this.spawn(this.sessions.tmuxCommand,
        [...this.sessions.args, 'attach-session', '-E', '-f', 'ignore-size', '-t', terminal.name], {
          name: 'xterm-256color', cols: ticket.cols, rows: ticket.rows, cwd: this.cwd,
          env: { ...this.env, TMUX: '', TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        });
    } catch (error) { this.send(ws, { type: 'error', text: error.message }); ws.close(1011, 'Unable to attach terminal'); return; }
    const client = { proc, terminal, exited: terminal.exited };
    this.clients.set(ws, client);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    this.send(ws, { type: 'ready', id: terminal.id, title: terminal.title, exited: terminal.exited,
      cols: ticket.cols, rows: ticket.rows, paneCols: terminal.cols, paneRows: terminal.rows });
    // Tmux paints a fresh screen for each client; no shared ANSI replay buffer.
    proc.onData(data => {
      if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Reconnect to catch up'); return; }
      this.send(ws, { type: 'output', data });
      this.scheduleCapture(terminal);
    });
    proc.onExit(({ exitCode }) => {
      if (!this.clients.has(ws)) return;
      this.clients.delete(ws);
      this.send(ws, { type: 'error', text: `Terminal connection ended (${exitCode}). Reconnect to the running conversation.` });
      ws.close(1011, 'Terminal client detached');
    });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'display') {
          if (!client.wrapped && message.wrapped === true) client.lastSnapshot = undefined;
          client.wrapped = message.wrapped === true;
          if (client.wrapped) this.scheduleCapture(terminal);
        } else if (message.type === 'resize') {
          proc.resize(dimension(message.cols, 20, 400), dimension(message.rows, 5, 200));
        } else if (message.type === 'viewport' && typeof message.direction === 'string') {
          this.sessions.pan(proc.pid, message.direction);
        } else if (!client.exited && message.type === 'key' && typeof message.key === 'string') {
          this.sessions.key(terminal, message.key);
        } else if (!client.exited && message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) {
          proc.write(message.data);
        } else if (!client.exited && message.type === 'title' && typeof message.title === 'string') {
          this.sessions.title(terminal, message.title);
        }
      } catch (error) { this.send(ws, { type: 'error', text: error.message }); }
    });
    ws.on('close', () => this.detach(ws));
    ws.on('error', () => ws.terminate());
  }

  close(id) {
    const terminal = this.sessions.open({ terminalId: id });
    this.sessions.close(terminal);
    for (const [ws, client] of this.clients) if (client.terminal.id === id) {
      this.detach(ws); ws.close(1000, 'Terminal closed');
    }
    for (const [key, ticket] of this.tickets) if (ticket.id === id) this.tickets.delete(key);
  }

  dispose() {
    this.disposed = true; clearInterval(this.cleanup); clearInterval(this.snapshotPoll); this.tickets.clear();
    for (const capture of this.captures.values()) clearTimeout(capture.timer);
    this.captures.clear();
    for (const ws of this.clients.keys()) { this.detach(ws); ws.close(1001, 'WebUI restarting'); }
    this.wss.close();
  }
}
