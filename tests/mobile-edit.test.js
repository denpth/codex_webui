import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalEdit } from '../public/mobile-edit.js';

test('live mobile edits append spaces without clearing or resending the word', () => {
  assert.equal(terminalEdit('hello', 'hello '), ' ');
  assert.equal(terminalEdit('hello ', 'hello '), '');
  assert.equal(terminalEdit('hello ', 'hello w'), 'w');
});

test('mobile autocorrect and middle edits replace only the changed suffix', () => {
  assert.equal(terminalEdit('teh ', 'the '), '\x7f\x7f\x7f\x1b[200~he \x1b[201~');
  assert.equal(terminalEdit('hello world', 'hello brave world'), '\x7f'.repeat(5) + '\x1b[200~brave world\x1b[201~');
  assert.equal(terminalEdit('hello ', 'hello'), '\x7f');
});

test('grapheme backspace and multiline paste never submit a prompt', () => {
  assert.equal(terminalEdit('hello 👩‍💻', 'hello '), '\x7f');
  assert.equal(terminalEdit('', 'one\ntwo'), '\x1b[200~one\ntwo\x1b[201~');
  assert.equal(terminalEdit('', '\x1b[A'), '\x1b[200~\x1b[A\x1b[201~');
});
