#!/usr/bin/env node
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const threadId = '11111111-1111-4111-8111-111111111111';
const rollout = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${threadId}.jsonl`);
const output = data => process.stdout.write(JSON.stringify(data) + '\n');
let initialized = false;
let turns = 0;
let pendingTurn;
const items = [];
function complete(turnId, text) {
  const item = { type: 'agentMessage', id: `agent-${turnId}`, text };
  // Deliberately split a JSON event across stdout chunks.
  const delta = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, itemId: item.id, delta: text } }) + '\n';
  process.stdout.write(delta.slice(0, 19));
  setTimeout(() => {
    process.stdout.write(delta.slice(19));
    items.push({ turnId, item });
    output({ method: 'item/completed', params: { threadId, item } });
    output({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }, 20);
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  const reply = result => output({ id, result });
  if (!method) {
    if (id === 999) complete(pendingTurn, `Approval: ${message.result.decision}`);
    return;
  }
  if (method === 'initialize') return reply({ userAgent: 'test' });
  if (method === 'initialized') { initialized = true; return; }
  if (!initialized) return output({ id, error: { code: -1, message: 'Not initialized' } });
  if (method === 'config/read') return reply({ config: { model: 'test-model' } });
  if (method === 'model/list') return reply({ data: [{ model: 'test-model', displayName: 'Test Model', isDefault: true }, { model: 'other-model', displayName: 'Other Model' }], nextCursor: null });
  if (method === 'thread/list') return reply({ data: fs.existsSync(rollout) ? [{ id: threadId, path: rollout, name: 'WebUI compatibility conversation', cwd: process.cwd(), updatedAt: Date.now() / 1000, model: 'test-model' }] : [], nextCursor: null });
  if (method === 'thread/read') return reply({ thread: { id: threadId, path: rollout, name: 'WebUI compatibility conversation', cwd: process.cwd() } });
  if (method === 'thread/start' || method === 'thread/resume') {
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
    return reply({ thread: { id: threadId, path: rollout, turns: [] } });
  }
  if (method === 'thread/items/list') return reply({ data: [...items].reverse(), nextCursor: null });
  if (method === 'turn/start') {
    const text = params.input[0].text;
    if (text === 'fail') return output({ id, error: { code: -1, message: 'Model unavailable' } });
    const turnId = `turn-${++turns}`;
    items.push({ turnId, item: { id: `user-${turnId}`, type: 'userMessage', content: params.input } });
    output({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    reply({ turn: { id: turnId } });
    if (text === 'limit') {
      output({ method: 'error', params: { threadId, error: { message: 'Usage limit reached. Try another model.' } } });
      output({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Usage limit reached' } } } });
    } else if (text === 'which model') complete(turnId, params.model);
    else if (text === 'approval') {
      pendingTurn = turnId;
      output({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'echo approved', reason: 'Test approval' } });
    } else if (text === 'crash') process.exit(1);
    else complete(turnId, `Reply ${turns}: ${text}`);
    return;
  }
  if (method === 'turn/interrupt') {
    output({ method: 'turn/completed', params: { threadId, turn: { id: params.turnId, status: 'interrupted' } } });
    return reply({});
  }
  output({ id, error: { code: -32601, message: 'Unknown method' } });
});
