import { randomUUID, randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';

export function sameOrigin(req) {
  if (!req.headers.origin) return false;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch { return false; }
}

export class TerminalServer {
  constructor(server, { command, cwd, spawn = pty.spawn, maxTerminals = 8, env = process.env }) {
    Object.assign(this, { command, cwd, spawn, maxTerminals, env });
    this.terminals = new Map();
    this.tickets = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      const ticket = this.tickets.get(url.searchParams.get('ticket'));
      if (url.pathname !== '/terminal/ws' || !sameOrigin(req) || !ticket || ticket.expires < Date.now()) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.tickets.delete(url.searchParams.get('ticket'));
      const terminal = this.terminals.get(ticket.id);
      if (!terminal) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
      this.wss.handleUpgrade(req, socket, head, ws => this.attach(ws, terminal, ticket));
    });
    this.cleanup = setInterval(() => {
      for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
      // No browser traffic should keep a dead connection alive forever.
      for (const ws of this.wss.clients) {
        if (ws.alive === false) { ws.terminate(); continue; }
        ws.alive = false;
        ws.ping();
      }
    }, 30000);
    this.cleanup.unref();
  }

  list() {
    return [...this.terminals.values()].map(t => ({
      id: t.id, sessionId: t.sessionId, title: t.title, cwd: t.cwd, exited: t.exited,
      createdAt: t.createdAt, fullAccess: true
    }));
  }

  open({ terminalId, sessionId, title, cwd, model, cols = 100, rows = 30 } = {}) {
    let terminal;
    if (terminalId) {
      terminal = this.terminals.get(terminalId);
      if (!terminal) throw Object.assign(new Error('This terminal has ended. Open the conversation again.'), { status: 404 });
    } else if (sessionId) terminal = [...this.terminals.values()].find(t => t.sessionId === sessionId && !t.exited);
    if (!terminal) {
      if (this.terminals.size >= this.maxTerminals) throw Object.assign(new Error('Close an open terminal before starting another.'), { status: 409 });
      const args = ['--no-alt-screen', '--cd', cwd || this.cwd, '--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request'];
      if (model) args.push('--model', model);
      if (sessionId) args.push('resume', sessionId);
      const proc = this.spawn(this.command, args, {
        name: 'xterm-256color', cols: clamp(cols, 20, 400), rows: clamp(rows, 5, 200),
        cwd: cwd || this.cwd, env: { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
      terminal = { id: randomUUID(), sessionId: sessionId || null, title: title || 'New conversation', cwd: cwd || this.cwd,
        proc, cols: clamp(cols, 20, 400), rows: clamp(rows, 5, 200), clients: new Set(), buffer: '', exited: false, createdAt: Date.now(), inputLine: '' };
      this.terminals.set(terminal.id, terminal);
      proc.onData(data => {
        terminal.buffer = (terminal.buffer + data).slice(-2 * 1024 * 1024);
        for (const ws of terminal.clients) {
          if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Reconnect to catch up'); continue; }
          this.send(ws, { type: 'output', data });
        }
      });
      proc.onExit(({ exitCode }) => {
        terminal.exited = true;
        for (const ws of terminal.clients) this.send(ws, { type: 'exit', exitCode });
      });
    }
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, { id: terminal.id, cols: clamp(cols, 20, 400), rows: clamp(rows, 5, 200), expires: Date.now() + 30000 });
    return { id: terminal.id, ticket, exited: terminal.exited, title: terminal.title, sessionId: terminal.sessionId };
  }

  send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }

  resize(terminal) {
    if (terminal.exited || !terminal.clients.size) return;
    const cols = Math.max(...[...terminal.clients].map(ws => ws.cols));
    const rows = Math.max(...[...terminal.clients].map(ws => ws.rows));
    if (cols === terminal.cols && rows === terminal.rows) return;
    terminal.cols = cols; terminal.rows = rows;
    // Send geometry before the PTY emits output for its new size.
    for (const client of terminal.clients) this.send(client, { type: 'size', cols, rows });
    terminal.proc.resize(cols, rows);
  }

  attach(ws, terminal, ticket) {
    ws.cols = ticket.cols; ws.rows = ticket.rows;
    terminal.clients.add(ws);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    this.send(ws, { type: 'ready', id: terminal.id, title: terminal.title, exited: terminal.exited, cols: terminal.cols, rows: terminal.rows });
    if (terminal.buffer) this.send(ws, { type: 'output', data: terminal.buffer });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (terminal.exited) return;
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) {
          terminal.proc.write(message.data);
        }
        if (message.type === 'title' && !terminal.sessionId && typeof message.title === 'string') {
          terminal.title = message.title.replace(/\s+/g, ' ').trim().slice(0, 100) || terminal.title;
        }
        if (message.type === 'resize') {
          ws.cols = clamp(message.cols, 20, 400); ws.rows = clamp(message.rows, 5, 200);
          this.resize(terminal);
        }
      } catch (error) { this.send(ws, { type: 'error', text: error.message }); }
    });
    ws.on('close', () => { terminal.clients.delete(ws); this.resize(terminal); });
    ws.on('error', () => ws.terminate());
    this.resize(terminal);
  }

  close(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (!terminal.exited) terminal.proc.kill();
    for (const ws of terminal.clients) ws.close(1000, 'Terminal closed');
    this.terminals.delete(id);
    for (const [key, ticket] of this.tickets) if (ticket.id === id) this.tickets.delete(key);
  }

  dispose() {
    clearInterval(this.cleanup);
    for (const id of this.terminals.keys()) this.close(id);
    this.wss.close();
  }
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
