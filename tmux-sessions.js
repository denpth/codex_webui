import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dimension = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : min;
};

// The registry lives on the dedicated tmux server, not in this Node process.
export class TmuxSessions {
  constructor({ cwd, command, env = process.env, tmuxCommand = env.TMUX_CMD || 'tmux',
    socketName = env.WEBUI_TMUX_SOCKET, stateDir, maxTerminals = 8 }) {
    Object.assign(this, { cwd, command, env, tmuxCommand, maxTerminals });
    const key = createHash('sha256').update(fs.realpathSync(cwd)).digest('hex').slice(0, 16);
    this.socketName = socketName || `codex-webui-${key}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(this.socketName)) throw new Error('Invalid WEBUI_TMUX_SOCKET name.');
    this.stateDir = stateDir || path.join(os.homedir(), '.local', 'state', 'codex-webui', this.socketName);
    this.configFile = path.join(this.stateDir, 'tmux.conf');
  }

  get args() { return ['-L', this.socketName, '-f', this.configFile]; }

  run(args) {
    try {
      return execFileSync(this.tmuxCommand, [...this.args, ...(args[0] === 'new-session' ? [] : ['-N']), ...args], {
        encoding: 'utf8', env: { ...this.env, TMUX: '' }, timeout: 5000,
        maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
      }).trimEnd();
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('Install tmux to use the terminal (macOS: brew install tmux; Ubuntu/Debian: sudo apt install tmux).'), { status: 503 });
      throw Object.assign(new Error(error.stderr?.toString().trim() || error.message), { status: 503 });
    }
  }

  list() {
    let output;
    try { output = this.run(['list-sessions', '-F', '#{session_name}\t#{@webui}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_width}\t#{pane_height}']); }
    catch (error) {
      if (/no server running|error connecting|No such file or directory|Install tmux/.test(error.message)) return [];
      throw error;
    }
    return output.split('\n').flatMap(line => {
      const [name, metadata, dead, code, cols, rows] = line.split('\t');
      try {
        const data = JSON.parse(metadata);
        if (name !== `webui-${data.id}` || !data.id) return [];
        return [{ ...data, name, cols: Number(cols) || data.cols, rows: Number(rows) || data.rows, exited: dead === '1', exitCode: code ? Number(code) : null, fullAccess: true }];
      } catch { return []; }
    });
  }

  open({ terminalId, sessionId, title, cwd, model, cols = 100, rows = 30 } = {}) {
    const sessions = this.list();
    if (sessions.length) {
      // Setting even an unchanged option repaints every tmux client.
      const filler = this.run(['show-options', '-gqv', 'fill-character']);
      if (filler) this.run(['set-option', '-gq', 'fill-character', ' ']);
    }
    if (terminalId) {
      const session = sessions.find(s => s.id === terminalId);
      if (!session) throw Object.assign(new Error('This terminal has ended. Open the conversation again.'), { status: 404 });
      return session;
    }
    const existing = sessionId && sessions.find(s => s.sessionId === sessionId && !s.exited);
    if (existing) return existing;
    if (sessions.length >= this.maxTerminals) throw Object.assign(new Error('Close an open terminal before starting another.'), { status: 409 });
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.configFile, [
      'set -g status off', 'set -g history-limit 10000', 'set -g mouse on',
      "set -gq fill-character ' '",
      'set -g window-size manual', 'set -g remain-on-exit on',
      'set -g destroy-unattached off', 'set -g allow-rename off',
      'set -g set-titles on', 'set -g set-titles-string "#{pane_title}"'
    ].join('\n') + '\n', { mode: 0o600 });
    const session = { id: randomUUID(), sessionId: sessionId || null, title: title || 'New conversation',
      cwd: cwd || this.cwd, cols: dimension(cols, 20, 400), rows: dimension(rows, 5, 200), createdAt: Date.now() };
    session.name = `webui-${session.id}`;
    const args = ['--no-alt-screen', '--cd', session.cwd, '--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request'];
    if (model) args.push('--model', model);
    if (sessionId) args.push('resume', sessionId);
    // Multiple command arguments are executed directly by tmux, without a shell.
    const sessionEnv = ['PATH', 'HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME'].flatMap(key =>
      this.env[key] === undefined ? [] : ['-e', `${key}=${this.env[key]}`]);
    this.run(['new-session', '-d', '-s', session.name, '-c', session.cwd,
      '-x', String(session.cols), '-y', String(session.rows), ...sessionEnv, '--', this.command, ...args]);
    try {
      this.run(['set-option', '-t', session.name, '@webui', JSON.stringify(session)]);
      this.run(['set-option', '-wt', session.name, 'window-size', 'manual']);
      this.run(['select-pane', '-t', session.name, '-T', session.title]);
    } catch (error) {
      try { this.run(['kill-session', '-t', session.name]); } catch {}
      throw error;
    }
    return { ...session, exited: false, exitCode: null, fullAccess: true };
  }

  title(session, title) {
    if (session.sessionId) return;
    const updated = { ...session, title: title.replace(/\s+/g, ' ').trim().slice(0, 100) || session.title };
    this.run(['set-option', '-t', session.name, '@webui', JSON.stringify(updated)]);
    session.title = updated.title;
  }

  pan(pid, direction) {
    const flags = { left: '-L', right: '-R', up: '-U', down: '-D', follow: '-c' };
    if (!flags[direction]) throw new Error('Unknown viewport direction.');
    const client = this.run(['list-clients', '-F', '#{client_pid}\t#{client_name}']).split('\n')
      .map(line => line.split('\t')).find(([clientPid]) => Number(clientPid) === pid)?.[1];
    if (!client) throw new Error('The terminal is still attaching. Retry shortly.');
    this.run(['refresh-client', '-t', client, flags[direction], ...(direction === 'follow' ? [] : ['10'])]);
  }

  key(session, key) {
    const keys = { tab: '\x1b[Z', enter: '\x1b[13;2u', up: '\x1b[1;2A', down: '\x1b[1;2B', left: '\x1b[1;2D', right: '\x1b[1;2C' };
    if (!keys[key]) throw new Error('Unknown shifted terminal key.');
    // Literal sequences retain Shift even when the pane has not negotiated extended keys.
    this.run(['send-keys', '-l', '-t', session.name, '--', keys[key]]);
  }

  fit(session, cols, rows) {
    const size = { cols: dimension(cols, 20, 400), rows: dimension(rows, 5, 200) };
    this.run(['resize-window', '-t', session.name, '-x', String(size.cols), '-y', String(size.rows)]);
    return size;
  }

  capture(session) {
    return new Promise((resolve, reject) => {
      execFile(this.tmuxCommand, [...this.args, '-N', 'capture-pane', '-p', '-e', '-J', '-S', '-500', '-t', session.name],
        { encoding: 'utf8', env: { ...this.env, TMUX: '' }, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (error, text) => error ? reject(error) : resolve(text.trimEnd()));
    });
  }

  close(session) { this.run(['kill-session', '-t', session.name]); }
}
