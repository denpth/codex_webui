import test from 'node:test';
import assert from 'node:assert/strict';
import { ansiRuns, ansiPalette } from '../public/terminal-colors.js';
test('ANSI shell colors and reset preserve all wrapped text', () => {
 const runs = ansiRuns('plain \x1b[1;32mgreen\x1b[0m normal\n\x1b[31merror');
 assert.equal(runs.map(r=>r.text).join(''), 'plain green normal\nerror');
 assert.deepEqual(runs[1].style, {fontWeight:'bold',color:ansiPalette[2]});
 assert.deepEqual(runs[2].style, {});
 assert.equal(runs[3].style.color, ansiPalette[1]);
});
test('256 colors, truecolor and inverse survive tmux snapshots', () => {
 const runs=ansiRuns('\x1b[38;5;196mred\x1b[48;2;10;20;30;7mselected\x1b[27;39;49mreset');
 assert.equal(runs[0].style.color,'rgb(255,0,0)');
 assert.equal(runs[1].style.backgroundColor,'rgb(10,20,30)');
 assert.equal(runs[1].style.inverse,true);
 assert.deepEqual(runs[2].style,{});
});
test('terminal escape controls are stripped and markup remains literal text', () => {
 const runs=ansiRuns('\x1b]0;title\x07\x1b[2J<script>hello</script>');
 assert.equal(runs.map(r=>r.text).join(''),'<script>hello</script>');
});
