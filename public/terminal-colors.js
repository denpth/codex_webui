// Shared shell palette for native xterm and safe, wrapping ANSI snapshots.
export const ansiPalette = ['#171a1d', '#f07882', '#9ee7cb', '#e5c07b', '#82aaff', '#c792ea', '#7fdbca', '#e7ecef', '#697580', '#ff98a4', '#b9f4dc', '#ffe19c', '#a6c8ff', '#e1b3ff', '#a3f3e7', '#ffffff'];
export const terminalTheme = Object.fromEntries([
  ['background', '#101214'], ['foreground', '#e7ecef'], ['cursor', '#9ee7cb'], ['selectionBackground', '#425b51'],
  ...['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'].map((name,i) => [name, ansiPalette[i]])
]);
function indexedColor(n) {
  if (n < 16) return ansiPalette[n];
  if (n < 232) { const c = n - 16, levels = [0,95,135,175,215,255]; return `rgb(${levels[Math.floor(c/36)]},${levels[Math.floor(c/6)%6]},${levels[c%6]})`; }
  const gray = 8 + (n - 232) * 10; return `rgb(${gray},${gray},${gray})`;
}
export function ansiRuns(text) {
  const runs = []; let style = {};
  const pattern = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
  let pos = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > pos) runs.push({ text: text.slice(pos, match.index), style: { ...style } });
    pos = match.index + match[0].length;
    if (match[1] === undefined) continue;
    const codes = (match[1] || '0').split(/[;:]/).map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.fontWeight = 'bold';
      else if (c === 2) style.opacity = '0.7';
      else if (c === 3) style.fontStyle = 'italic';
      else if (c === 4) style.textDecoration = 'underline';
      else if (c === 7) style.inverse = true;
      else if (c === 22) { delete style.fontWeight; delete style.opacity; }
      else if (c === 23) delete style.fontStyle;
      else if (c === 24) delete style.textDecoration;
      else if (c === 27) delete style.inverse;
      else if (c === 39) delete style.color;
      else if (c === 49) delete style.backgroundColor;
      else if (c >= 30 && c <= 37) style.color = ansiPalette[c - 30];
      else if (c >= 90 && c <= 97) style.color = ansiPalette[c - 90 + 8];
      else if (c >= 40 && c <= 47) style.backgroundColor = ansiPalette[c - 40];
      else if (c >= 100 && c <= 107) style.backgroundColor = ansiPalette[c - 100 + 8];
      else if (c === 38 || c === 48) {
        const key = c === 38 ? 'color' : 'backgroundColor', mode = codes[++i];
        if (mode === 5) { const n = codes[++i]; if (Number.isInteger(n) && n >= 0 && n <= 255) style[key] = indexedColor(n); }
        else if (mode === 2) { const rgb = codes.slice(i+1,i+4); i += 3; if (rgb.length === 3 && rgb.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) style[key] = `rgb(${rgb.join(',')})`; }
      }
    }
  }
  if (pos < text.length) runs.push({ text: text.slice(pos), style: { ...style } });
  return runs;
}
export function renderAnsi(output, text) {
  const fragment = output.ownerDocument.createDocumentFragment();
  for (const run of ansiRuns(text)) {
    const span = output.ownerDocument.createElement('span'); span.textContent = run.text;
    const { inverse, ...style } = run.style;
    if (inverse) { style.color = run.style.backgroundColor || terminalTheme.background; style.backgroundColor = run.style.color || terminalTheme.foreground; }
    Object.assign(span.style, style); fragment.append(span);
  }
  output.replaceChildren(fragment);
}
