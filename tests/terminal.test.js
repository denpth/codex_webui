import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TmuxSessions } from '../tmux-sessions.js';
import { WebSocket } from 'ws';
import { TerminalServer, sameOrigin } from '../terminal-server.js';
import { sessionTitle } from '../session-titles.js';

test('session labels prefer conversation names and fall back to cleaned prompt context', () => {
  assert.equal(sessionTitle({ name: 'Build a leads dashboard', preview: 'ignored' }), 'Build a leads dashboard');
  assert.equal(sessionTitle({ preview: '<environment_context>private paths</environment_context>Fix mobile navigation' }), 'Fix mobile navigation');
  assert.equal(sessionTitle({ cwd: '/projects/webui' }), 'Conversation in webui');
});

test('terminal origins must match the WebUI host', () => {
  assert.equal(sameOrigin({ headers: { origin: 'https://mac.tailnet.ts.net:5055', host: 'mac.tailnet.ts.net:5055' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'https://evil.example', host: 'mac.tailnet.ts.net:5055' } }), false);
  assert.equal(sameOrigin({ headers: { host: 'localhost:5055' } }), false);
});


const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await pause(30); }
  assert.fail('Timed out waiting for terminal output');
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
function socket(origin, ticket, sockets, requestOrigin = origin) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/terminal/ws?ticket=' + ticket, { origin: requestOrigin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw))); sockets.push(ws);
  return { ws, messages };
}

function fakeSessions() {
  const session = { id: 'terminal-1', name: 'webui-terminal-1', sessionId: 'thread-1', title: 'Test', cwd: '/tmp', cols: 160, rows: 40, exited: false };
  let closed = false;
  return { args: ['-L', 'webui-test'], tmuxCommand: 'tmux',
    open() { if (closed) throw new Error('closed'); return session; }, list: () => closed ? [] : [session],
    close() { closed = true; }, title() {}, pan() {} };
}

test('each WebSocket owns a separate PTY; resize, disconnect and restart affect only that client', async t => {
  const server = http.createServer(); const origin = await listen(server);
  const sessions = fakeSessions(); const procs = [], sockets = [];
  const terminals = new TerminalServer(server, { command: 'codex', cwd: '/tmp', sessions, spawn: (command, args, options) => {
    const proc = { command, args, options, inputs: [], sizes: [], killed: false,
      onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; },
      write(data) { this.inputs.push(data); }, resize(...size) { this.sizes.push(size); }, kill() { this.killed = true; } };
    procs.push(proc); return proc;
  } });
  t.after(async () => { sockets.forEach(ws => ws.terminate()); terminals.dispose(); server.close(); await once(server, 'close'); });
  const desktop = socket(origin, terminals.open({ cols: 160, rows: 40 }).ticket, sockets); await once(desktop.ws, 'open');
  const phone = socket(origin, terminals.open({ terminalId: 'terminal-1', cols: 40, rows: 20 }).ticket, sockets); await once(phone.ws, 'open');
  await until(() => desktop.messages.some(m => m.type === 'ready') && phone.messages.some(m => m.type === 'ready'));
  assert.equal(procs.length, 2); assert.equal(procs[0].command, 'tmux');
  assert.ok(procs[0].args.includes('ignore-size')); assert.ok(!procs[0].args.includes('-d'));
  assert.deepEqual([procs[0].options.cols, procs[1].options.cols], [160, 40]);
  phone.ws.send(JSON.stringify({ type: 'resize', cols: 35, rows: 18 }));
  desktop.ws.send(JSON.stringify({ type: 'input', data: 'hello' }));
  await until(() => procs[1].sizes.length && procs[0].inputs.length);
  assert.deepEqual(procs[0].sizes, []); assert.deepEqual(procs[1].sizes, [[35, 18]]);
  assert.deepEqual(procs[0].inputs, ['hello']); assert.deepEqual(procs[1].inputs, []);
  procs[0].data('desktop view'); procs[1].data('phone view');
  await until(() => phone.messages.some(m => m.data === 'phone view'));
  assert.ok(!desktop.messages.some(m => m.data === 'phone view'));
  phone.ws.close(); await once(phone.ws, 'close'); await until(() => procs[1].killed);
  assert.equal(procs[0].killed, false); assert.equal(terminals.list().length, 1);
  terminals.dispose(); assert.equal(procs[0].killed, true);
  assert.equal(sessions.list().length, 1, 'WebUI shutdown leaves tmux session running');
});

test('single-use tickets, same-origin checks, client limit and explicit close', async t => {
  const server = http.createServer(); const origin = await listen(server); const sockets = [];
  const sessions = fakeSessions();
  const terminals = new TerminalServer(server, { command: 'codex', cwd: '/tmp', sessions, maxClients: 1,
    spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) });
  t.after(async () => { sockets.forEach(ws => ws.terminate()); terminals.dispose(); server.close(); await once(server, 'close'); });
  const opened = terminals.open();
  const hostile = socket(origin, opened.ticket, sockets, 'https://evil.example');
  assert.match((await once(hostile.ws, 'error'))[0].message, /403/);
  const active = socket(origin, opened.ticket, sockets); await once(active.ws, 'open');
  const reused = socket(origin, opened.ticket, sockets); assert.match((await once(reused.ws, 'error'))[0].message, /403/);
  const overLimit = socket(origin, terminals.open().ticket, sockets); assert.match((await once(overLimit.ws, 'error'))[0].message, /429/);
  terminals.close(opened.id); await once(active.ws, 'close'); assert.equal(terminals.list().length, 0);
});

let tmuxAvailable = true;
try { execFileSync(process.env.TMUX_CMD || 'tmux', ['-V'], { stdio: 'ignore' }); } catch { tmuxAvailable = false; }

test('real tmux shares live typing, keeps pane size fixed and survives WebUI restart', { skip: !tmuxAvailable }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-tmux-test-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sessions = new TmuxSessions({ cwd: dir, command: path.join(root, 'tests/fake-terminal.mjs'),
    env: { ...process.env, CODEX_HOME: dir, WEBUI_TEST_INPUT_LOG: path.join(dir, 'input.log') }, socketName: `webui-test-${path.basename(dir)}`, stateDir: dir, maxTerminals: 1 });
  const server = http.createServer(); const origin = await listen(server); const sockets = [];
  let terminals = new TerminalServer(server, { command: 'unused', cwd: dir, sessions });
  let secondServer;
  t.after(async () => {
    sockets.forEach(ws => ws.terminate()); terminals.dispose();
    for (const session of sessions.list()) sessions.close(session);
    if (server.listening) { server.close(); await once(server, 'close'); }
    if (secondServer?.listening) { secondServer.close(); await once(secondServer, 'close'); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const opened = terminals.open({ sessionId: 'test-thread', cols: 120, rows: 35 });
  const name = sessions.list()[0].name;
  const pane = () => sessions.run(['display-message', '-p', '-t', name, '#{pane_width}x#{pane_height} #{pane_pid}']);
  const originalPane = pane();
  assert.equal(sessions.run(['show-options', '-wv', '-t', name, 'window-size']), 'manual');
  assert.equal(sessions.run(['show-options', '-gv', 'history-limit']), '10000');
  const desktop = socket(origin, opened.ticket, sockets); await once(desktop.ws, 'open');
  await until(() => desktop.messages.some(m => m.type === 'output'));
  desktop.ws.send(JSON.stringify({ type: 'input', data: 'DESKTOP_LIVE\r' }));
  await until(() => sessions.run(['capture-pane', '-p', '-t', name]).includes('DESKTOP_LIVE'));
  await until(() => desktop.messages.filter(m => m.type === 'output').map(m => m.data).join('').includes('DESKTOP_LIVE'));
  await pause(150);
  const beforePhone = desktop.messages.length;
  const phone = socket(origin, terminals.open({ sessionId: 'test-thread', cols: 40, rows: 15 }).ticket, sockets); await once(phone.ws, 'open');
  await until(() => phone.messages.some(m => m.type === 'output'));
  assert.equal(pane(), originalPane, 'attaching phone does not resize or restart Codex');
  await pause(150);
  assert.equal(desktop.messages.slice(beforePhone).map(m => (m.data || '').replace(/\x1b\[\?(?:12|25)[hl]/g, '')).join(''), '', 'phone attach does not repaint desktop');
  assert.match(phone.messages.filter(m => m.type === 'output').map(m => m.data).join(''), /DESKTOP_LIVE/);
  phone.ws.send(JSON.stringify({ type: 'input', data: 'PHONE_LIVE\r' }));
  await until(() => desktop.messages.filter(m => m.type === 'output').map(m => m.data).join('').includes('PHONE_LIVE'));
  assert.ok(phone.messages.filter(m => m.type === 'output').map(m => m.data).join('').includes('PHONE_LIVE'));
  await pause(150);
  const beforePan = desktop.messages.length;
  const desktopView = sessions.run(['list-clients', '-F', '#{client_width}\t#{window_offset_x}']).split('\n').find(line => line.startsWith('120\t'));
  phone.ws.send(JSON.stringify({ type: 'viewport', direction: 'right' })); await pause(100);
  assert.ok(!phone.messages.some(m => m.type === 'error'), 'pan resolves the correct tmux client');
  assert.equal(desktop.messages.slice(beforePan).map(m => (m.data || '').replace(/\x1b\[\?(?:12|25)[hl]/g, '')).join(''), '', 'panning only repaints the phone');
  const views = sessions.run(['list-clients', '-F', '#{client_width}\t#{window_offset_x}']);
  assert.ok(views.includes('40\t10'), 'phone viewport pans right');
  assert.equal(views.split('\n').find(line => line.startsWith('120\t')), desktopView, 'desktop viewport stays in place');
  phone.ws.send(JSON.stringify({ type: 'viewport', direction: 'follow' })); await pause(100);
  phone.ws.send(JSON.stringify({ type: 'resize', cols: 32, rows: 12 })); await pause(150);
  assert.ok(sessions.run(['list-clients', '-F', '#{client_width}x#{client_height}']).includes('32x12'));
  assert.ok(sessions.run(['list-clients', '-F', '#{client_width}x#{client_height}']).includes('120x35'));
  assert.ok(!sessions.run(['capture-pane', '-p', '-t', name]).includes('UNEXPECTED_PANE_RESIZE'));
  assert.equal(pane(), originalPane, 'phone resize leaves pane dimensions unchanged');
  phone.ws.send(JSON.stringify({ type: 'display', wrapped: true }));
  await until(() => phone.messages.some(m => m.type === 'snapshot' && m.text.includes('PHONE_LIVE')));
  assert.equal(pane(), originalPane, 'wrapped snapshots never resize Codex');
  desktop.ws.send(JSON.stringify({ type: 'input', data: '\x1b[31mCOLOR_CHECK\x1b[0m' }));
  await until(() => phone.messages.some(m => m.type === 'snapshot' && /\x1b\[[0-9;]*31mCOLOR_CHECK/.test(m.text)));

  sessions.key(sessions.list()[0], 'tab');
  await until(() => fs.readFileSync(path.join(dir, 'input.log'), 'utf8').includes('1b5b5a'));
  sessions.key(sessions.list()[0], 'enter');
  await until(() => fs.readFileSync(path.join(dir, 'input.log'), 'utf8').includes('1b5b31333b3275'));
  await pause(200);
  const beforeDetach = desktop.messages.length;
  phone.ws.close(); await once(phone.ws, 'close'); await pause(150);
  assert.equal(pane(), originalPane); assert.equal(desktop.messages.slice(beforeDetach).map(m => (m.data || '').replace(/\x1b\[\?(?:12|25)[hl]/g, '')).join(''), '', 'phone detach does not repaint desktop');
  assert.throws(() => terminals.open(), /Close an open terminal/);
  terminals.dispose(); await until(() => desktop.ws.readyState === WebSocket.CLOSED);
  server.close(); await once(server, 'close');
  assert.equal(pane(), originalPane, 'Codex remains alive after WebUI shutdown');
  const recovered = new TmuxSessions({ cwd: dir, command: path.join(root, 'tests/fake-terminal.mjs'),
    socketName: sessions.socketName, stateDir: dir, env: sessions.env });
  secondServer = http.createServer(); const secondOrigin = await listen(secondServer);
  terminals = new TerminalServer(secondServer, { command: 'unused', cwd: dir, sessions: recovered });
  assert.equal(terminals.list()[0].id, opened.id);
  const reattached = socket(secondOrigin, terminals.open({ terminalId: opened.id, cols: 80, rows: 24 }).ticket, sockets);
  await once(reattached.ws, 'open');
  await until(() => reattached.messages.filter(m => m.type === 'output').map(m => m.data).join('').includes('PHONE_LIVE'));
  assert.equal(pane(), originalPane);
  terminals.close(opened.id); await once(reattached.ws, 'close');
  assert.equal(recovered.list().length, 0);
});
