const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const characters = text => segmenter ? [...segmenter.segment(text)].map(part => part.segment) : Array.from(text);

// Edit the shared prompt from a stable browser field. Never send Enter here.
export function terminalEdit(previous, next) {
  const before = characters(previous), after = characters(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  const erase = '\x7f'.repeat(before.length - common);
  const insert = after.slice(common).join('');
  const protectedInsert = /[\r\n\x00-\x1f\x7f]/.test(insert) || characters(insert).length > 1
    ? '\x1b[200~' + insert + '\x1b[201~' : insert;
  return erase + (insert ? protectedInsert : '');
}
