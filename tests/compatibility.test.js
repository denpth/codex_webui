import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../codex-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('app-server chat, split streaming, errors, approvals, resume and shutdown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-compat-'));
  const controller = new AbortController();
  let reading;
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, PORT: '0', CODEX_CMD: path.join(root, 'tests/fake-codex.mjs'),
    CODEX_HOME: dir, CODEX_WORKDIR: dir, CODEX_RESUME: '0',
    WEBUI_CONFIG_FILE: path.join(dir, 'config.toml'), WEBUI_HISTORY_FILE: path.join(dir, 'history.json')
  } });
  t.after(async () => {
    controller.abort();
    await reading;
    proc.kill();
    if (proc.exitCode === null) await once(proc, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [data] = await once(proc.stdout, 'data');
  const url = data.toString().match(/http:\/\/\S+/)[0];
  const staleTerminal = await fetch(url + '/terminal/connect', {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(staleTerminal.status, 426, 'old retry clients cannot reconnect');
  assert.match((await staleTerminal.json()).error, /Reload the WebUI/);
  const events = [];
  const stream = await fetch(url + '/events', { signal: controller.signal });
  reading = (async () => {
    let buffer = '';
    for await (const chunk of stream.body) {
      buffer += Buffer.from(chunk).toString();
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 2);
        if (event.startsWith('event:')) {
          const [name, data] = event.split('\n');
          events.push({ name: name.slice(7), data: JSON.parse(data.slice(6)) });
        }
      }
    }
  })().catch(error => { if (error.name !== 'AbortError') throw error; });
  const post = (route, body = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function waitEvent(name, after = 0) {
    for (let i = 0; i < 100; i++) {
      const found = events.slice(after).find(e => e.name === name);
      if (found) return found.data;
      await delay(20);
    }
    assert.fail(`Missing event ${name}: ${JSON.stringify(events)}`);
  }
  assert.equal((await post('/message', { text: 'hello' })).status, 200);
  await waitEvent('turn-completed');
  assert.equal(events.find(e => e.name === 'delta').data.text, 'Reply 1: hello');
  assert.equal(events.filter(e => e.name === 'message').length, 1);
  const transcript = await (await fetch(url + '/session-messages')).json();
  assert.deepEqual(transcript.messages.map(m => m.role), ['user', 'assistant']);
  const readOnly = await (await fetch(url + '/session-messages?threadId=11111111-1111-4111-8111-111111111111')).json();
  assert.deepEqual(readOnly.messages, transcript.messages);
  let after = events.length;
  assert.equal((await post('/message', { text: 'again' })).status, 200);
  await waitEvent('turn-completed', after);
  assert.equal(events.filter(e => e.name === 'message').at(-1).data.text, 'Reply 2: again');
  const failed = await post('/message', { text: 'fail' });
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /Model unavailable/);
  after = events.length;
  assert.equal((await post('/message', { text: 'approval' })).status, 200);
  const approval = await waitEvent('approval', after);
  assert.equal((await post('/message', { text: 'overlap' })).status, 409);
  assert.equal((await post('/approval', { id: approval.id, decision: 'not-valid' })).status, 400);
  assert.equal((await post('/approval', { id: approval.id, decision: 'decline' })).status, 200);
  await waitEvent('turn-completed', after);
  assert.equal(events.filter(e => e.name === 'message').at(-1).data.text, 'Approval: decline');
  assert.equal((await post('/approval', { id: approval.id, decision: 'accept' })).status, 404);
  const sessions = await (await fetch(url + '/sessions')).json();
  assert.ok(sessions.current);
  assert.equal(sessions.sessions[0].title, 'WebUI compatibility conversation');
  const models = await (await fetch(url + '/models')).json();
  assert.equal(models.models[1].id, 'other-model');
  assert.equal((await fetch(url + '/terminal/connect', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  after = events.length;
  assert.equal((await post('/message', { text: 'limit' })).status, 200);
  assert.equal((await waitEvent('turn-completed', after)).status, 'failed');
  assert.equal((await fetch(url + '/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'other-model' }) })).status, 200);
  after = events.length;
  assert.equal((await post('/message', { text: 'which model' })).status, 200);
  await waitEvent('turn-completed', after);
  assert.equal(events.filter(e => e.name === 'message').at(-1).data.text, 'other-model', 'model change is applied without restarting after a limit');
  assert.equal((await post('/resume', { path: sessions.current })).status, 200);
  assert.equal((await post('/resume', { path: '/tmp/not-a-session.jsonl' })).status, 400);
  after = events.length;
  assert.equal((await post('/message', { text: 'after resume' })).status, 200);
  await waitEvent('turn-completed', after);
  assert.equal((await post('/shutdown')).status, 200);
  assert.equal((await fetch(url + '/health')).status, 200);
});

test('missing Codex executable rejects startup without crashing the host', async () => {
  const client = new CodexClient({ command: '/nonexistent/codex', timeout: 1000 });
  await assert.rejects(client.start(), /ENOENT/);
  assert.equal(client.proc, null);
});
