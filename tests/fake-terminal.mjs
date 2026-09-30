#!/usr/bin/env node
// A real TTY fixture: echo each input burst so tmux must paint both clients.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('TMUX_READY\r\n');
process.stdin.on('data', data => process.stdout.write(data.toString().replace(/\r/g, '\r\n')));
process.on('SIGWINCH', () => process.stdout.write('UNEXPECTED_PANE_RESIZE\r\n'));
