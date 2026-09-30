#!/usr/bin/env node

// Minimal dependency-free Web UI to chat with Codex CLI (app-server)
// - Serves a static chat page
// - Uses SSE to stream Codex output
// - Launches/keeps a single Codex session, supports multiple messages

import http from 'http';
import fs from 'fs';
import path from 'path';
import { CodexClient } from './codex-client.js';
import { TerminalServer, sameOrigin } from './terminal-server.js';
import { sessionTitle } from './session-titles.js';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ROADMAP (server-side) — implementation notes
// - Session search/filters: extend GET /sessions to accept query params like
//   ?q=<needle>&since=<ms>&days=7 and filter the scanSessions() result array.
// - Export transcript: add GET /export?path=<rollout> (or current), reuse
//   parseSessionMessages() to build Markdown/HTML, return as attachment.
// - Health/log tail: add GET /logs?lines=200 to stream recent stderr/stdout
//   buffered text from the Codex child process (keep a ring buffer).
// - Config profiles: store profiles in config.toml (e.g., [profiles.<name>]) and
//   add GET/PUT /profiles and a field to switch active profile.
// - Keyboard shortcuts map: optional GET /shortcuts to expose current bindings.
// - Session import: add POST /import expecting a file upload path or content,
//   validate rollout schema, and write it under ~/.codex/sessions (optional).

const PORT = process.env.PORT ? Number(process.env.PORT) : 5055;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.WEBUI_TOKEN || '';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || `http://localhost:${PORT}`;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
function requireAuth(req) {
  if (req.headers.origin && !sameOrigin(req)) return false;
  if (!TOKEN) return true; // localhost default: open
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

const CODEX_CMD = process.env.CODEX_CMD || 'codex';
// Anchor workdir to the project root (parent of codex-webui) unless overridden
const ROOT_DIR = __dirname;
const WORKDIR = process.env.CODEX_WORKDIR ? path.resolve(process.env.CODEX_WORKDIR) : ROOT_DIR;
// Read memory from the project-level .codex by default so it stays consistent
const MEMORY_FILE = process.env.CODEX_MEMORY_FILE || path.join(WORKDIR, '.codex', 'memory.md');
const CONFIG_FILE = process.env.WEBUI_CONFIG_FILE || path.join(__dirname, 'config.toml');

const client = new CodexClient({ command: CODEX_CMD, cwd: WORKDIR });
let threadId = null;
let threadReady = null;
let busy = false;
let activeTurnId = null;
let resumeChecked = false;
const pendingApprovals = new Map();
const messageBuffers = new Map();
const sseClients = new Set();
let LAST_RESUME_PATH = null;
const HISTORY_FILE = process.env.WEBUI_HISTORY_FILE || path.join(__dirname, 'history.json');
const SESS_ROOT = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const isWithinSessions = p => {
  if (!p) return false;
  try {
    const relative = path.relative(fs.realpathSync(SESS_ROOT), fs.realpathSync(p));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch { return false; }
};

function ensureMemoryFile() {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, '# Codex Persistent Memory\n\n', 'utf8');
  }
}

function readMemoryFacts() {
  try {
    ensureMemoryFile();
    const txt = fs.readFileSync(MEMORY_FILE, 'utf8');
    const facts = (txt.split(/\r?\n/) || []).filter(l => l.trim().startsWith('- ')).map(l => l.replace(/^\-\s*/, '').trim());
    return facts;
  } catch {
    return [];
  }
}

function saveMemoryFactsFromText(text) {
  if (!text) return;
  ensureMemoryFile();
  const lines = text.split(/\r?\n/);
  let factsToAdd = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.toUpperCase().startsWith('SAVE_MEMORY:')) {
      const idx = line.indexOf(':');
      const fact = idx >= 0 ? line.slice(idx + 1).trim() : '';
      if (fact) factsToAdd.push(fact);
    }
  }
  if (!factsToAdd.length) return;
  const existing = new Set(readMemoryFacts());
  const fh = fs.openSync(MEMORY_FILE, 'a');
  for (const f of factsToAdd) {
    if (existing.has(f)) continue;
    fs.writeSync(fh, `- ${f}\n`);
  }
  fs.closeSync(fh);
}

function broadcast(event, data) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

// Keep SSE alive through proxies
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch {}
  }
}, 15000);

function getResumeMeta() {
  try {
    if (!LAST_RESUME_PATH) return null;
    const stat = fs.statSync(LAST_RESUME_PATH);
    const name = path.basename(LAST_RESUME_PATH);
    return { name, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; }
}

function broadcastStatus() {
  const facts = readMemoryFacts();
  const meta = getResumeMeta();
  broadcast('status', {
    resumed: !!LAST_RESUME_PATH,
    resume_path: LAST_RESUME_PATH,
    resume_meta: meta,
    memory: facts,
    config: getConfigSafe(), thread_id: threadId, busy
  });
}

// ---- Config (TOML) helpers (module scope) ----
function defaultConfig() {
  return {
    model: '',
    'tools.web_search_request': false,
    use_streamable_shell: true,
    sandbox_mode: 'workspace-write',
    approval_policy: 'on-request',
    instructions_extra: ''
  };
}

function getConfigSafe() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return defaultConfig();
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return parseToml(raw, defaultConfig());
  } catch { return defaultConfig(); }
}

function writeConfig(obj) {
  const cfg = Object.assign(getConfigSafe(), obj || {});
  const toml = dumpToml(cfg);
  fs.writeFileSync(CONFIG_FILE, toml, 'utf8');
}

function parseToml(src, fallback) {
  const out = Object.assign({}, fallback || {});
  const lines = String(src || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    out[key] = value;
  }
  return out;
}

function dumpToml(obj) {
  const parts = ['# Codex WebUI configuration'];
  const keys = Object.keys(obj || {});
  keys.forEach(k => {
    const v = obj[k];
    if (typeof v === 'string') parts.push(`${k} = ${JSON.stringify(v)}`);
    else if (typeof v === 'boolean') parts.push(`${k} = ${v ? 'true' : 'false'}`);
    else parts.push(`${k} = ${String(v)}`);
  });
  return parts.join('\n') + '\n';
}

function rpcError(res, error) {
  setCORS(res);
  res.writeHead(error.status || 502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: error.message }));
}

async function threadOptions() {
  const cfg = getConfigSafe();
  let model = cfg.model;
  if (!model) {
    const effective = await client.request('config/read', { cwd: WORKDIR });
    model = effective.config.model;
    if (!model) {
      const catalog = await client.request('model/list', {});
      model = catalog.data.find(entry => entry.isDefault)?.model;
    }
  }
  return {
    cwd: WORKDIR,
    ...(model ? { model } : {}),
    approvalPolicy: cfg.approval_policy === 'ask' ? 'on-request' : cfg.approval_policy,
    sandbox: cfg.sandbox_mode,
    config: { web_search: cfg['tools.web_search_request'] ? 'live' : 'disabled' },
    developerInstructions: [
      'When the user asks you to remember a non-sensitive fact, emit a line starting with "SAVE_MEMORY: " followed by the fact. Never store secrets or tokens.',
      cfg.instructions_extra || ''
    ].join(' ')
  };
}

function sessionIdFromPath(file) {
  if (!isWithinSessions(file)) throw new Error('Invalid or missing session file');
  // Read only the metadata prefix; paginated rollouts can have large sidecars.
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let text;
  try { text = buffer.subarray(0, fs.readSync(fd, buffer)).toString('utf8'); }
  finally { fs.closeSync(fd); }
  for (const line of text.split(/\r?\n/)) {
    try {
      const data = JSON.parse(line);
      if (data.type === 'session_meta' && data.payload?.id) return data.payload.id;
      if (data.id && data.cwd) return data.id;
    } catch {}
  }
  const match = path.basename(file).match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i);
  if (match) return match[1];
  throw new Error('Cannot find the Codex thread ID in this session');
}

async function ensureThread() {
  if (threadReady) return threadReady;
  threadReady = (async () => {
    await client.start();
    if (!resumeChecked) {
      resumeChecked = true;
      if (!['0', 'false', 'no', 'off'].includes(String(process.env.CODEX_RESUME || '1').toLowerCase())) {
        LAST_RESUME_PATH = scanSessions()[0]?.path || null;
      }
    }
    const id = threadId || (LAST_RESUME_PATH ? sessionIdFromPath(LAST_RESUME_PATH) : null);
    const result = await client.request(id ? 'thread/resume' : 'thread/start', {
      ...await threadOptions(), ...(id ? { threadId: id, excludeTurns: true } : {})
    });
    threadId = result.thread.id;
    LAST_RESUME_PATH = result.thread.path || LAST_RESUME_PATH;
    if (LAST_RESUME_PATH) recordResume(LAST_RESUME_PATH);
    broadcast('system', { text: id ? 'Codex session resumed' : 'Codex session ready' });
    broadcastStatus();
    return threadId;
  })();
  try { return await threadReady; }
  catch (error) { threadReady = null; throw error; }
}

function clearApprovals() {
  for (const id of pendingApprovals.keys()) broadcast('approval-resolved', { id });
  pendingApprovals.clear();
}

client.on('disconnect', error => {
  threadReady = null;
  busy = false;
  activeTurnId = null;
  messageBuffers.clear();
  clearApprovals();
  broadcast('system', { text: error.message });
  broadcastStatus();
});
client.on('stderr', text => console.error(text.trimEnd()));
client.on('notification', ({ method, params: p = {} }) => {
  if (p.threadId && p.threadId !== threadId) return;
  if (method === 'item/agentMessage/delta') {
    messageBuffers.set(p.itemId, (messageBuffers.get(p.itemId) || '') + p.delta);
    broadcast('delta', { text: p.delta, id: p.itemId });
  }
  if (method === 'item/completed' && p.item?.type === 'agentMessage') {
    const text = p.item.text || messageBuffers.get(p.item.id) || '';
    messageBuffers.delete(p.item.id);
    saveMemoryFactsFromText(text);
    broadcast('message', { text, id: p.item.id });
  }
  if (method === 'item/started') {
    const item = p.item || {};
    if (item.type === 'commandExecution') broadcast('tool', { name: 'Shell', detail: item.command });
    if (item.type === 'fileChange') broadcast('tool', { name: 'Edit', detail: (item.changes || []).map(c => c.path).join(', ') });
    if (item.type === 'mcpToolCall') broadcast('tool', { name: item.server, detail: item.tool });
  }
  if (method === 'turn/started') { busy = true; activeTurnId = p.turn.id; broadcastStatus(); }
  if (method === 'turn/completed') {
    busy = false;
    activeTurnId = null;
    messageBuffers.clear();
    clearApprovals();
    const turn = p.turn || {};
    broadcast(turn.status === 'failed' ? 'codex-error' : 'system', {
      text: turn.status === 'completed' ? 'Task complete' : turn.error?.message || `Turn ${turn.status}`
    });
    broadcast('turn-completed', { status: turn.status });
    broadcastStatus();
  }
  if (method === 'error') broadcast('codex-error', { text: p.error?.message || p.message || 'Codex error' });
  if (method === 'serverRequest/resolved') {
    pendingApprovals.delete(p.requestId);
    broadcast('approval-resolved', { id: p.requestId });
  }
});
client.on('request', request => {
  const { id, method, params = {} } = request;
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(method)) {
    pendingApprovals.set(id, request);
    broadcast('approval', request);
  } else {
    // Unsupported server requests must receive a response, never an implicit approval.
    client.write({ id, error: { code: -32601, message: `WebUI does not support ${method}` } });
    broadcast('codex-error', { text: `Unsupported Codex request: ${method}` });
  }
});

async function stopCodex() {
  await client.stop();
  threadReady = null;
}

async function startCodexWithResume(resumePath, explicitId = null) {
  if (busy) throw Object.assign(new Error('Stop the active turn before switching sessions'), { status: 409 });
  // Validate before stopping a working session.
  const id = explicitId || (resumePath ? sessionIdFromPath(resumePath) : null);
  await stopCodex();
  threadId = id;
  LAST_RESUME_PATH = resumePath;
  resumeChecked = true;
  await ensureThread();
}

async function readTranscript(selectedId) {
  if (!selectedId) {
    if (!threadId && !LAST_RESUME_PATH) return [];
    await ensureThread();
  } else await client.start();
  const messages = [];
  let cursor;
  do {
    const page = await client.request('thread/items/list', { threadId: selectedId || threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
    for (const entry of page.data) {
      const item = entry.item;
      if (item.type === 'agentMessage') messages.push({ role: 'assistant', text: item.text });
      if (item.type === 'userMessage') messages.push({ role: 'user', text: item.content.filter(c => c.type === 'text').map(c => c.text).join('\n') });
    }
    cursor = page.nextCursor;
  } while (cursor && messages.length < 100);
  return messages.slice(0, 100).reverse();
}

function scanSessions() {
  const root = SESS_ROOT;
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (/^rollout-.*\.jsonl$/.test(ent.name)) {
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        out.push({ path: full, name: ent.name, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { return { entries: [] }; }
}

function writeHistory(h) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); } catch {}
}

function recordResume(resumePath) {
  if (!resumePath) return;
  const h = readHistory();
  const ts = Date.now();
  h.entries = h.entries || [];
  // Deduplicate by resumePath + workdir
  h.entries = h.entries.filter(e => !(e.resume_path === resumePath && e.workdir === WORKDIR));
  h.entries.push({ resume_path: resumePath, workdir: WORKDIR, last_used: ts });
  writeHistory(h);
}

async function sendUserInput(text) {
  if (busy) throw Object.assign(new Error('A turn is already running'), { status: 409 });
  busy = true;
  try {
    await ensureThread();
    const facts = readMemoryFacts();
    const memory = facts.length ? '\n\n<memory>\n' + facts.map(f => `- ${f}`).join('\n') + '\n</memory>' : '';
    const options = await threadOptions();
    await client.request('turn/start', { threadId, model: options.model, approvalPolicy: options.approvalPolicy, input: [{ type: 'text', text: text + memory }] });
  } catch (error) { busy = false; broadcastStatus(); throw error; }
}

function serveStatic(req, res) {
  const url = req.url.split('?')[0];
  const root = path.join(__dirname, 'public');
  const vendor = {
    '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js',
    '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
    '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js'
  };
  let filePath = vendor[url] ? path.join(__dirname, 'node_modules', vendor[url]) : path.join(root, url === '/' ? 'index.html' : url);
  if (!vendor[url] && !filePath.startsWith(root + path.sep)) { setCORS(res); res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { setCORS(res); res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    setCORS(res);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    try {
      await client.start();
      const catalog = await client.request('model/list', { limit: 100 });
      const effective = await client.request('config/read', { cwd: WORKDIR });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: catalog.data.map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault })),
        selected: getConfigSafe().model || effective.config.model || catalog.data.find(m => m.isDefault)?.model }));
    } catch (error) { return rpcError(res, error); }
  }
  if (req.method === 'GET' && req.url === '/terminals') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ terminals: terminals.list() }));
  }
  if (req.method === 'POST' && ['/terminal/connect', '/terminal/close'].includes(req.url)) {
    if (!requireAuth(req) || !sameOrigin(req)) return rpcError(res, { status: 403, message: 'Open the terminal from this WebUI.' });
    try {
      const body = await readJSON(req);
      if (req.url === '/terminal/close') {
        terminals.close(body.terminalId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (body.clientVersion !== 'shared-terminal-4') {
        throw Object.assign(new Error('This page is out of date. Reload the WebUI to reconnect.'), { status: 426 });
      }
      let session;
      if (body.sessionId && !body.terminalId) {
        await client.start();
        session = (await client.request('thread/read', { threadId: body.sessionId })).thread;
        if (busy && threadId === session.id) throw Object.assign(new Error('Stop the active chat turn before opening it in Terminal.'), { status: 409 });
      }
      const opened = terminals.open({ terminalId: body.terminalId, sessionId: session?.id,
        title: session ? sessionTitle(session) : undefined, cwd: session?.cwd,
        model: getConfigSafe().model || undefined, cols: body.cols, rows: body.rows });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(opened));
    } catch (error) { return rpcError(res, error); }
  }
  // Basic CORS/preflight support so UI can be hosted elsewhere
  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'GET' && req.url.startsWith('/events')) {
    setCORS(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.add(res);
    // Push current status to the newly connected client
    try {
      const init = `event: status\n` + `data: ${JSON.stringify({ resumed: !!LAST_RESUME_PATH, resume_path: LAST_RESUME_PATH, resume_meta: getResumeMeta(), memory: readMemoryFacts(), thread_id: threadId, busy })}\n\n`;
      res.write(init);
    } catch {}
    for (const request of pendingApprovals.values()) res.write(`event: approval\ndata: ${JSON.stringify(request)}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // health check
  if (req.method === 'GET' && req.url === '/health') {
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // quiet favicon request
  if (req.method === 'GET' && req.url === '/favicon.ico') {
    setCORS(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/memory') {
    const facts = readMemoryFacts();
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ facts }));
  }

  if (req.method === 'DELETE' && req.url === '/memory') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { fact } = JSON.parse(body || '{}');
        if (!fact || typeof fact !== 'string') { setCORS(res); res.writeHead(400); return res.end('Bad JSON'); }
        ensureMemoryFile();
        try {
          const lines = fs.readFileSync(MEMORY_FILE, 'utf8').split(/\r?\n/);
          const needle = `- ${fact}`;
          const out = lines.filter(l => l.trim() !== needle.trim());
          fs.writeFileSync(MEMORY_FILE, out.join('\n'), 'utf8');
        } catch {}
        broadcastStatus();
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { setCORS(res); res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  if (req.method === 'DELETE' && req.url === '/session') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: p } = JSON.parse(body || '{}');
        if (!p) { setCORS(res); res.writeHead(400); return res.end('Bad JSON'); }
        const abs = path.resolve(p);
        if (!isWithinSessions(abs) || !/rollout-.*\.jsonl$/.test(abs)) { setCORS(res); res.writeHead(403); return res.end('Forbidden'); }
        try { fs.unlinkSync(abs); } catch {}
        // prune history entries pointing to this file
        const h = readHistory();
        h.entries = (h.entries || []).filter(e => e.resume_path !== abs);
        writeHistory(h);
        if (LAST_RESUME_PATH === abs) LAST_RESUME_PATH = null;
        broadcastStatus();
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { setCORS(res); res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  if (req.method === 'DELETE' && req.url === '/project-history') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { resume_path } = JSON.parse(body || '{}');
        const h = readHistory();
        h.entries = (h.entries || []).filter(e => e.resume_path !== resume_path);
        writeHistory(h);
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { setCORS(res); res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/message') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let text;
      try { ({ text } = JSON.parse(body || '{}')); }
      catch { return rpcError(res, { status: 400, message: 'Bad JSON' }); }
      if (typeof text !== 'string' || !text.trim() || text.length > 16*1024) return rpcError(res, { status: 400, message: 'Missing or oversized text' });
      try {
        await sendUserInput(text.trim());
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, thread_id: threadId }));
      } catch (error) { rpcError(res, error); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/approval') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id, decision, answers } = JSON.parse(body);
        const request = pendingApprovals.get(id);
        if (!request) return rpcError(res, { status: 404, message: 'Request is no longer pending' });
        let result;
        if (request.method === 'item/tool/requestUserInput') {
          if (!answers || typeof answers !== 'object') throw new Error('Missing answers');
          result = { answers };
        } else {
          if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid decision');
          result = request.method === 'item/permissions/requestApproval'
            ? { permissions: decision === 'accept' ? request.params.permissions : {}, scope: 'turn' }
            : { decision };
        }
        client.respond(id, result);
        pendingApprovals.delete(id);
        broadcast('approval-resolved', { id });
        setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) { rpcError(res, { status: 400, message: error.message }); }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getConfigSafe()));
  }

  if (req.method === 'PUT' && req.url === '/config') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const obj = JSON.parse(body || '{}');
        // whitelist only known keys
        const allowed = ['model','approval_policy','tools.web_search_request','use_streamable_shell','sandbox_mode','instructions_extra'];
        Object.keys(obj||{}).forEach(k => { if (!allowed.includes(k)) delete obj[k]; });
        writeConfig(obj);
        broadcastStatus();
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { setCORS(res); res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/restart') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    try {
      await startCodexWithResume(LAST_RESUME_PATH);
      setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, resume_path: LAST_RESUME_PATH }));
    } catch (error) { rpcError(res, error); }
    return;
  }

  if (req.method === 'GET' && (req.url === '/sessions' || req.url.startsWith('/sessions?'))) {
    try {
      await client.start();
      const url = new URL(req.url, 'http://localhost');
      const page = await client.request('thread/list', { limit: 100, sortKey: 'updated_at',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
        ...(url.searchParams.get('q') ? { searchTerm: url.searchParams.get('q') } : {}) });
      const sessions = page.data.map(t => ({ id: t.id, title: sessionTitle(t), path: t.path, cwd: t.cwd,
        preview: t.preview, model: t.model, mtimeMs: t.updatedAt * 1000 }));
      setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sessions, current: LAST_RESUME_PATH, currentId: threadId, nextCursor: page.nextCursor }));
    } catch (error) { return rpcError(res, error); }
  }

  if (req.method === 'GET' && (req.url === '/session-messages' || req.url.startsWith('/session-messages?'))) {
    try {
      if (!requireAuth(req)) { res.writeHead(401); return res.end(); }
      const messages = await readTranscript(new URL(req.url, 'http://localhost').searchParams.get('threadId'));
      setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (error) { rpcError(res, error); }
    return;
  }

  if (req.method === 'POST' && req.url === '/resume') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let resumePath = null;
      let requestedId = null;
      try {
        // Try JSON body first
        const parsed = JSON.parse(body || '{}');
        resumePath = parsed && (parsed.path || parsed.resume_path) || null;
        requestedId = parsed.thread_id || null;
      } catch {
        // Fallback: raw string body treated as path
        const s = String(body || '').trim();
        if (s && s !== '{}' && s !== 'null') resumePath = s;
      }
      // path safety
      if (resumePath) {
        const abs = path.resolve(resumePath);
        if (!isWithinSessions(abs) || !/rollout-.*\.jsonl$/.test(abs)) {
          setCORS(res); res.writeHead(400, { 'Content-Type':'application/json' });
          return res.end(JSON.stringify({ ok:false, error:'Invalid resume path' }));
        }
      }
      try {
        if (requestedId) {
          await client.start();
          const session = await client.request('thread/read', { threadId: requestedId });
          resumePath = session.thread.path;
        }
        await startCodexWithResume(resumePath ? path.resolve(resumePath) : null, requestedId);
        broadcastStatus();
        setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, resume_path: LAST_RESUME_PATH, thread_id: threadId }));
      } catch (error) { rpcError(res, error); }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/projects') {
    const h = readHistory();
    // Group by workdir
    const groups = {};
    for (const e of h.entries || []) {
      (groups[e.workdir] = groups[e.workdir] || []).push(e);
    }
    // Sort entries in each group by last_used desc
    Object.values(groups).forEach(arr => arr.sort((a, b) => (b.last_used || 0) - (a.last_used || 0)));
    setCORS(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ groups }));
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    if (!requireAuth(req)) { setCORS(res); res.writeHead(401); return res.end(); }
    try {
      if (activeTurnId) await client.request('turn/interrupt', { threadId, turnId: activeTurnId });
      await stopCodex();
    } catch (error) { return rpcError(res, error); }
    setCORS(res);
    res.writeHead(200); res.end('OK');
    return;
  }

  // static
  serveStatic(req, res);
});

const terminals = new TerminalServer(server, { command: CODEX_CMD, cwd: WORKDIR });

async function readJSON(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

server.listen(PORT, HOST, () => {
  console.log(`Codex WebUI running at http://${HOST}:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { terminals.dispose(); await stopCodex(); process.exit(0); });
