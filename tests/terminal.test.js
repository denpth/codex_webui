import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
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

test('PTY input, resize, reconnect replay, one-use tickets and cleanup', async t => {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let onData, onExit, killed = false, spawnArgs;
  const input = [], sizes = [];
  const terminals = new TerminalServer(server, { command: 'codex', cwd: '/tmp', spawn: (command, args, options) => {
    spawnArgs = { command, args, options };
    return { onData: cb => { onData = cb; }, onExit: cb => { onExit = cb; }, write: data => input.push(data), resize: (...size) => sizes.push(size), kill: () => { killed = true; onExit({ exitCode: 0 }); } };
  } });
  const sockets = [];
  t.after(async () => { sockets.forEach(ws => ws.terminate()); terminals.dispose(); server.close(); await once(server, 'close'); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const opened = terminals.open({ sessionId: 'thread-123', title: 'Fix mobile', cols: 80, rows: 24 });
  assert.ok(spawnArgs.args.includes('danger-full-access'));
  assert.ok(spawnArgs.args.includes('on-request'));
  assert.deepEqual(spawnArgs.args.slice(-2), ['resume', 'thread-123']);
  onData('Existing output\r\n');
  const connect = (ticket, requestOrigin = origin) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/terminal/ws?ticket=' + ticket, { origin: requestOrigin }); sockets.push(ws); return ws;
  };
  const ws = connect(opened.ticket); const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(messages.some(m => m.type === 'output' && m.data === 'Existing output\r\n'));
  ws.send(JSON.stringify({ type: 'input', data: '/model\r' }));
  ws.send(JSON.stringify({ type: 'resize', cols: 44, rows: 18 }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(input, ['/model\r']); assert.deepEqual(sizes, [[44, 18]]);
  const rejected = connect(opened.ticket);
  const [error] = await once(rejected, 'error'); assert.match(error.message, /403/);
  const reconnect = terminals.open({ terminalId: opened.id });
  const hostile = connect(reconnect.ticket, 'https://evil.example');
  const [hostileError] = await once(hostile, 'error'); assert.match(hostileError.message, /403/);
  ws.close(); await once(ws, 'close'); assert.equal(killed, false, 'browser disconnect preserves process');
  const resumed = connect(reconnect.ticket); const replay = [];
  resumed.on('message', raw => replay.push(JSON.parse(raw))); await once(resumed, 'open');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(replay.some(m => m.data === 'Existing output\r\n'));
  terminals.close(opened.id); assert.equal(killed, true); assert.equal(terminals.list().length, 0);
});
