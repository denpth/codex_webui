#!/usr/bin/env node
import fs from 'node:fs';
// A real TTY fixture: echo each input burst so tmux must paint both clients.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('TMUX_READY\r\n');
process.stdin.on('data', data => {
  if (process.env.WEBUI_TEST_INPUT_LOG) fs.appendFileSync(process.env.WEBUI_TEST_INPUT_LOG, data.toString('hex') + '\n');
  process.stdout.write(data.toString().replace(/\r/g, '\r\n'));
});
process.on('SIGWINCH', () => process.stdout.write('UNEXPECTED_PANE_RESIZE\r\n'));
