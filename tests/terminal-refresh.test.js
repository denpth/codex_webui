import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryScreen } from '../public/terminal-refresh.js';

test('manual refresh control only matches the live native ownership-conflict screen', () => {
  const locked = '🔒 This conversation is open in another app     r to retry\nClose it there and press R to continue here.\n\n r retry   f fork   ←/esc command center   ctrl+c/q exit   ctrl+t transcript';
  assert.equal(isRetryScreen(locked), true);
  assert.equal(isRetryScreen(locked + '\n\n'), true);
  assert.equal(isRetryScreen(locked.replace('ctrl+c/q exit   ctrl+t transcript', 'ctrl+c/q exit\nctrl+t transcript')), true);
  assert.equal(isRetryScreen(locked + '\n› Ask Codex to do anything'), false);
  assert.equal(isRetryScreen('This conversation is open in another app\n› /model'), false);
  assert.equal(isRetryScreen('An error occurred. r retry'), false);
  assert.equal(isRetryScreen('Select Model and Effort\nenter select · esc back'), false);
});
