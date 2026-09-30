import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// One newline-delimited JSON-RPC connection to the supported Codex app server.
export class CodexClient extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], cwd, env = process.env, timeout = 60000 } = {}) {
    super();
    Object.assign(this, { command, args, cwd, env, timeout });
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    if (this.ready) return this.ready;
    const proc = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ready = this.initialize(proc);
    return this.ready;
  }

  async initialize(proc) {
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method) {
        this.emit(msg.id === undefined ? 'notification' : 'request', msg);
      } else if (this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else resolve(msg.result);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', text => this.emit('stderr', text));
    const fail = error => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
      this.emit('disconnect', error);
    };
    proc.on('error', fail);
    proc.stdin.on('error', fail);
    proc.on('exit', (code, signal) => fail(new Error(`Codex app-server exited (${signal || code})`)));
    try {
      await this.request('initialize', { clientInfo: { name: 'codex_webui', title: 'Codex WebUI', version: '1.1.0' } });
      this.write({ method: 'initialized', params: {} });
    } catch (error) {
      proc.kill();
      throw error;
    }
  }

  write(message) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex app-server is not connected');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.write({ id, result }); }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => proc.kill('SIGKILL'), 1500);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.kill();
    });
  }
}
