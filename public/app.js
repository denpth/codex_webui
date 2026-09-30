'use strict';
import { renderAnsi, terminalTheme, CodexColors } from './terminal-colors.js';
import { terminalEdit } from './mobile-edit.js';
import { isRetryScreen } from './terminal-refresh.js';
const $ = id => document.getElementById(id);
const state = { sessions: [], terminals: [], cursor: null, selected: null, activeTerminal: null,
  terminalSessionId: null, socket: null, generation: 0, terminalReady: false, sessionRequest: 0 };
let term, fit, reconnectTimer, searchTimer;
let codexColors = new CodexColors();
let viewportSize = { cols: 80, rows: 24 };
let paneSize = null;
let sentInput = '', composingInput = false, liveInputActive = false;
const inputDrafts = new Map();
let displayChoice = localStorage.getItem('terminalDisplay') || 'auto';
let wrappedDisplay = displayChoice === 'wrap' || (displayChoice === 'auto' && matchMedia('(max-width:640px)').matches);
let waitingForOtherApp = false, terminalUpdatedAt = 0;

async function api(url, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = sessionStorage.getItem('webuiToken');
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { error: raw }; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const post = (url, body = {}) => api(url, { method: 'POST', body });
function report(error) {
  let message = error?.message || String(error);
  try { const parsed = JSON.parse(message); message = parsed.error?.message || parsed.message || message; } catch {}
  $('alertText').textContent = message;
  $('alert').hidden = false;
}
function clearError() { $('alert').hidden = true; }
$('dismissAlert').onclick = clearError;
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('scrim').hidden = !open;
  $('openSidebar').setAttribute('aria-expanded', String(open));
  syncSidebarAccessibility();
  if (open) $('search').focus();
  else if (matchMedia('(max-width: 640px)').matches) $('openSidebar').focus();
}
function syncSidebarAccessibility() {
  const closed = matchMedia('(max-width:640px)').matches && !document.body.classList.contains('sidebar-open');
  $('sidebar').inert = closed;
  $('sidebar').setAttribute('aria-hidden', String(closed));
}
$('openSidebar').onclick = () => setSidebar(true);
$('closeSidebar').onclick = $('scrim').onclick = () => setSidebar(false);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) setSidebar(false);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newSession().catch(report); }
  if (event.key === 'Tab' && document.body.classList.contains('sidebar-open')) {
    const controls = [...$('sidebar').querySelectorAll('button,input')].filter(el => !el.hidden && el.getClientRects().length);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }
});
function relativeTime(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days < 1 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? `${days} days ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function projectName(cwd) { return (cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || 'Local workspace'; }
function sessionButton(session, live = false) {
  const button = document.createElement('button');
  button.className = 'session-card';
  button.classList.toggle('active', live ? session.id === state.activeTerminal : session.id === state.selected?.id);
  const title = document.createElement('strong'); title.textContent = session.title;
  const detail = document.createElement('small');
  detail.textContent = live ? `${session.exited ? 'Ended' : 'Running'} · ${projectName(session.cwd)}` : `${projectName(session.cwd)} · ${relativeTime(session.mtimeMs)}`;
  button.append(title, detail); button.title = session.title;
  button.onclick = () => {
    setSidebar(false);
    (live ? connectTerminal({ terminalId: session.id, title: session.title }) : selectSession(session)).catch(report);
  };
  return button;
}
function renderSessions() {
  $('sessions').replaceChildren(...state.sessions.map(s => sessionButton(s)));
  if (!state.sessions.length) { const p = document.createElement('p'); p.className = 'empty-list'; p.textContent = $('search').value ? 'No matching conversations.' : 'Your conversations will appear here.'; $('sessions').append(p); }
  $('liveSection').hidden = !state.terminals.length;
  $('liveSessions').replaceChildren(...state.terminals.map(t => sessionButton(t, true)));
  $('loadMore').hidden = !state.cursor;
}
async function loadSessions(append = false) {
  const request = ++state.sessionRequest;
  const query = new URLSearchParams();
  if (append && state.cursor) query.set('cursor', state.cursor);
  if ($('search').value.trim()) query.set('q', $('search').value.trim());
  try {
    const data = await api('/sessions?' + query);
    if (request !== state.sessionRequest) return;
    const known = new Set((append ? state.sessions : []).map(s => s.id));
    state.sessions = [...(append ? state.sessions : []), ...data.sessions.filter(s => !known.has(s.id))];
    state.cursor = data.nextCursor;
    if (state.selected || state.terminalSessionId) {
      const updated = state.sessions.find(s => s.id === (state.selected?.id || state.terminalSessionId));
      if (updated) {
        state.selected = updated; updateHeading(updated.title, updated.cwd);
        if (!terminalUpdatedAt) terminalUpdatedAt = updated.mtimeMs;
        $('refreshTerminal').textContent = updated.mtimeMs > terminalUpdatedAt ? 'Updates · ↻' : '↻';
      }
    }
    renderSessions();
  } catch (error) {
    if (!state.sessions.length) { $('sessions').textContent = 'Could not load conversations. Use ↻ to retry.'; }
    console.warn(error.message);
  }
}
async function loadTerminals() {
  try { state.terminals = (await api('/terminals')).terminals; renderSessions(); } catch {}
}
$('refreshSessions').onclick = () => { loadSessions(); loadTerminals(); };
$('loadMore').onclick = () => loadSessions(true);
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadSessions(), 220); };
function updateHeading(title, cwd) {
  $('conversationTitle').textContent = title || 'New conversation';
  $('workdir').textContent = cwd ? projectName(cwd) : 'Local Codex CLI';
  $('workdir').title = cwd || 'Working directory';
}
function updateControls() {
  $('closeTerminal').hidden = !state.activeTerminal;
  $('modelButton').disabled = !state.terminalReady;
  $('usageButton').disabled = !state.terminalReady;
  $('stopButton').disabled = !state.terminalReady;
  updateViewportControls();
}
async function selectSession(session) {
  state.selected = session; updateHeading(session.title, session.cwd); setSidebar(false); clearError(); renderSessions();
  await connectTerminal({ session });
}
async function newSession() {
  state.selected = null; updateHeading('New conversation'); setSidebar(false); clearError();
  await connectTerminal({}); renderSessions();
}
$('newSession').onclick = () => newSession().catch(report);
$('launchTerminal').onclick = () => connectTerminal({ session: state.selected }).catch(report);
function initTerminal() {
  if (term) return;
  term = new Terminal({ cursorBlink: true, fontSize: matchMedia('(max-width:640px)').matches ? 12 : 14,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, monospace', lineHeight: 1.2,
    scrollback: 10000, convertEol: false, screenReaderMode: true,
    theme: terminalTheme });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('terminalMount'));
  term.onData(data => sendTerminal(data));
  term.onTitleChange(title => {
    if (!state.selected && !state.terminalSessionId && title && !/^codex$/i.test(title)) setTerminalTitle(title.split(' | ')[0]);
  });

  new ResizeObserver(fitTerminal).observe($('terminalMount'));
}
function setTerminalTitle(value) {
  const title = value.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!title || title.startsWith('/')) return;
  socketSend({ type: 'title', title }); updateHeading(title);
  const live = state.terminals.find(t => t.id === state.activeTerminal);
  if (live && !live.sessionId) { live.title = title; renderSessions(); }
}
function fitTerminal() {
  if (!term || $('terminalHost').hidden || !$('terminalHost').clientHeight) return;
  try {
    const selectedSize = localStorage.getItem('terminalTextSize');
    const size = ['12', '14', '16'].includes(selectedSize) ? Number(selectedSize) : matchMedia('(max-width:640px)').matches ? 12 : 14;
    if (term.options.fontSize !== size) term.options.fontSize = size;
    fit.fit();
    viewportSize = { cols: term.cols, rows: term.rows };
    socketSend({ type: 'resize', ...viewportSize });
    updateViewportControls(); updateWrappedScrollbar();
  } catch {}
}
$('expandTerminal').onclick = () => {
  const expanded = document.body.classList.toggle('terminal-expanded');
  $('expandTerminal').textContent = expanded ? 'Restore' : 'Expand';
  $('expandTerminal').setAttribute('aria-pressed', String(expanded));
  requestAnimationFrame(fitTerminal);
};
$('fitPane').onclick = () => {
  fitTerminal(); socketSend({ type: 'fit-pane', ...viewportSize });
};
function updateViewportControls() {
  $('fitPane').hidden = wrappedDisplay || !state.terminalReady || !paneSize ||
    (viewportSize.cols === paneSize.cols && viewportSize.rows === paneSize.rows);
  $('terminalViewport').hidden = wrappedDisplay || !paneSize || $('terminalHost').hidden ||
    (viewportSize.cols >= paneSize.cols && viewportSize.rows >= paneSize.rows);
}
function updateDisplay() {
  wrappedDisplay = displayChoice === 'wrap' || (displayChoice === 'auto' && matchMedia('(max-width:640px)').matches);
  $('terminalHost').classList.toggle('wrapped', wrappedDisplay);
  $('terminalWrapped').hidden = !wrappedDisplay;
  $('terminalScrollbar').hidden = !wrappedDisplay;
  $('terminalMount').inert = wrappedDisplay;
  $('terminalMount').setAttribute('aria-hidden', String(wrappedDisplay));
  $('wrapTerminal').setAttribute('aria-pressed', String(wrappedDisplay));
  $('gridTerminal').setAttribute('aria-pressed', String(!wrappedDisplay));
  $('typingHint').textContent = wrappedDisplay || liveInputActive ? 'Typing is shared live' : 'Type directly in the terminal';
  $('terminalInput').placeholder = wrappedDisplay || liveInputActive ? 'Type here — shared live with your terminal…' : 'Type or paste a message for Codex…';
  $('terminalInput').maxLength = wrappedDisplay || liveInputActive ? 8192 : 32768;
  socketSend({ type: 'display', wrapped: wrappedDisplay });
  updateViewportControls(); updateWrappedScrollbar();
}
$('wrapTerminal').onclick = () => { displayChoice = 'wrap'; localStorage.setItem('terminalDisplay', displayChoice); updateDisplay(); fitTerminal(); };
$('gridTerminal').onclick = () => { displayChoice = 'grid'; localStorage.setItem('terminalDisplay', displayChoice); updateDisplay(); fitTerminal(); };
$('terminalWrapped').onclick = () => {
  if (state.terminalReady && !window.getSelection()?.toString()) $('terminalInput').focus();
};
function renderSnapshot(text) {
  const output = $('terminalWrapped');
  if (output.dataset.snapshot === text) return;
  output.dataset.snapshot = text;
  const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 30;
  const top = output.scrollTop;
  renderAnsi(output, new CodexColors().write(text));
  output.scrollTop = follow ? output.scrollHeight : top;
  updateWrappedScrollbar();
}
function updateWrappedScrollbar() {
  if (!wrappedDisplay || $('terminalHost').hidden) return;
  const output = $('terminalWrapped'), rail = $('terminalScrollbar'), thumb = $('terminalScrollThumb');
  const height = rail.clientHeight, max = Math.max(0, output.scrollHeight - output.clientHeight);
  const thumbHeight = max ? Math.max(30, height * output.clientHeight / output.scrollHeight) : height;
  thumb.style.height = `${Math.min(height, thumbHeight)}px`;
  thumb.style.top = `${max ? output.scrollTop / max * (height - thumbHeight) : 0}px`;
  rail.setAttribute('aria-valuemax', String(Math.round(max)));
  rail.setAttribute('aria-valuenow', String(Math.round(output.scrollTop)));
  rail.setAttribute('aria-disabled', String(!max));
}
$('terminalWrapped').onscroll = updateWrappedScrollbar;
let scrollGrab = 0;
function dragScrollbar(event) {
  const rail = $('terminalScrollbar'), thumb = $('terminalScrollThumb'), output = $('terminalWrapped');
  const travel = rail.clientHeight - thumb.clientHeight;
  if (travel > 0) output.scrollTop = Math.max(0, Math.min(1, (event.clientY - rail.getBoundingClientRect().top - scrollGrab) / travel)) * (output.scrollHeight - output.clientHeight);
}
$('terminalScrollbar').onpointerdown = event => {
  event.preventDefault();
  const thumb = $('terminalScrollThumb');
  scrollGrab = event.target === thumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.clientHeight / 2;
  $('terminalScrollbar').setPointerCapture(event.pointerId); dragScrollbar(event);
};
$('terminalScrollbar').onpointermove = event => { if ($('terminalScrollbar').hasPointerCapture(event.pointerId)) dragScrollbar(event); };
$('terminalScrollbar').onpointerup = event => { if ($('terminalScrollbar').hasPointerCapture(event.pointerId)) $('terminalScrollbar').releasePointerCapture(event.pointerId); };
$('terminalScrollbar').onkeydown = event => {
  const output = $('terminalWrapped');
  const amount = { ArrowUp: -40, ArrowDown: 40, PageUp: -output.clientHeight, PageDown: output.clientHeight }[event.key];
  if (amount !== undefined) { event.preventDefault(); output.scrollTop += amount; }
  if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); output.scrollTop = event.key === 'Home' ? 0 : output.scrollHeight; }
};
function flushLiveInput() {
  if (composingInput || !state.terminalReady) return false;
  const value = $('terminalInput').value;
  const data = terminalEdit(sentInput, value);
  if (data && !sendTerminal(data)) return false;
  sentInput = value; liveInputActive = true;
  return true;
}
document.querySelectorAll('[data-pan]').forEach(button => {
  button.onpointerdown = event => event.preventDefault();
  button.onclick = () => socketSend({ type: 'viewport', direction: button.dataset.pan });
});
function socketSend(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) { state.socket.send(JSON.stringify(payload)); return true; }
  return false;
}
function sendTerminal(data) { return socketSend({ type: 'input', data }); }
function updateWaitingTerminal() {
  if (!term || !state.terminalReady) return;
  const buffer = term.buffer.active;
  const lines = [];
  for (let row = 0; row < term.rows; row++) lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) || '');
  waitingForOtherApp = isRetryScreen(lines.join('\n'));
  $('refreshTerminal').style.visibility = waitingForOtherApp ? 'visible' : 'hidden';
  $('terminalStatusText').textContent = waitingForOtherApp ? 'Open in another app' : 'Connected';
}
$('refreshTerminal').onclick = () => {
  updateWaitingTerminal();
  if (waitingForOtherApp && sendTerminal('r')) {
    terminalUpdatedAt = state.selected?.mtimeMs || 0;
    $('refreshTerminal').textContent = '↻';
  }
};
function terminalStatus(text, connected = false) {
  $('terminalStatusText').textContent = text;
  $('terminalStatus').querySelector('.dot').classList.toggle('offline', !connected);
  state.terminalReady = connected;
  $('terminalComposer').querySelector('button').disabled = !connected;
  updateControls();
}
async function connectTerminal({ session, terminalId, title, reconnect = false } = {}) {
  waitingForOtherApp = false; terminalUpdatedAt = session?.mtimeMs || 0;
  $('refreshTerminal').style.visibility = 'hidden';
  const generation = ++state.generation;
  clearTimeout(reconnectTimer);
  state.socket?.close(); state.socket = null;
  terminalStatus('Connecting…'); clearError();
  $('terminalWelcome').hidden = true; $('terminalHost').hidden = false;
  $('terminalStatus').hidden = $('terminalKeys').hidden = $('terminalComposer').hidden = $('terminalDisplay').hidden = false;
  $('reconnectButton').hidden = true;
  initTerminal(); fitTerminal();
  let opened;
  try { opened = await post('/terminal/connect', { clientVersion: 'tmux-terminal-6', terminalId, sessionId: session?.id, cols: viewportSize.cols, rows: viewportSize.rows }); }
  catch (error) {
    if (generation === state.generation) {
      terminalStatus('Unable to connect');
      $('terminalWelcome').hidden = false; $('terminalHost').hidden = true;
      $('terminalStatus').hidden = $('terminalKeys').hidden = $('terminalComposer').hidden = $('terminalViewport').hidden = $('terminalDisplay').hidden = true;
    }
    throw error;
  }
  if (generation !== state.generation) return;
  if (opened.id !== state.activeTerminal) {
    if (state.activeTerminal) inputDrafts.set(state.activeTerminal, { value: $('terminalInput').value, sent: sentInput, live: liveInputActive });
    const draft = inputDrafts.get(opened.id);
    $('terminalInput').value = draft?.value || ''; sentInput = draft?.sent || ''; liveInputActive = draft?.live || false; composingInput = false;
    autoSize($('terminalInput')); codexColors = new CodexColors(); $('terminalWrapped').textContent = ''; delete $('terminalWrapped').dataset.snapshot;
  }
  state.activeTerminal = opened.id; state.terminalSessionId = opened.sessionId;
  state.selected = session || state.sessions.find(s => s.id === opened.sessionId) || null;
  sessionStorage.setItem('webuiTerminal', opened.id);
  updateHeading(title || session?.title || opened.title, session?.cwd);
  term.reset();
  paneSize = { cols: opened.paneCols, rows: opened.paneRows }; updateViewportControls();
  const url = new URL('/terminal/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', opened.ticket);
  const socket = new WebSocket(url); state.socket = socket;
  socket.onopen = () => { if (generation === state.generation) { socketSend({ type: 'resize', cols: viewportSize.cols, rows: viewportSize.rows }); updateDisplay(); } };
  socket.onmessage = event => {
    if (generation !== state.generation) return;
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') renderSnapshot(message.text);
    if (message.type === 'pane-size') { paneSize = { cols: message.cols, rows: message.rows }; updateViewportControls(); }
    if (message.type === 'output') term.write(codexColors.write(message.data), updateWaitingTerminal);
    if (message.type === 'ready') { terminalStatus(message.exited ? 'Process ended' : 'Connected', !message.exited); if (message.exited) $('reconnectButton').hidden = false; }
    if (message.type === 'exit') { terminalStatus(`Process ended (${message.exitCode})`); term.writeln('\r\n[Terminal ended. Select a saved conversation or start a new one.]'); loadSessions(); loadTerminals(); }
    if (message.type === 'error') report(message.text);
  };
  socket.onclose = () => {
    if (generation !== state.generation) return;
    terminalStatus('Disconnected · reconnecting…'); $('reconnectButton').hidden = false;
    reconnectTimer = setTimeout(() => connectTerminal({ terminalId: opened.id, reconnect: true }).catch(error => { terminalStatus('Disconnected'); report(error); }), reconnect ? 3000 : 1000);
  };
  socket.onerror = () => { if (generation === state.generation) terminalStatus('Connection interrupted'); };
  updateDisplay(); loadTerminals();
  if (!reconnect && !matchMedia('(max-width:640px)').matches) term.focus();
}
$('reconnectButton').onclick = () => connectTerminal({ terminalId: state.activeTerminal, reconnect: true }).catch(report);
$('terminalComposer').onsubmit = event => {
  event.preventDefault(); const value = $('terminalInput').value;
  if (!value.trim()) return;
  if (!state.terminalReady) return report('The terminal is disconnected. Reconnect before sending.');
  if (composingInput) return;
  const socket = state.socket;
  if (wrappedDisplay || liveInputActive) {
    if (!flushLiveInput()) return;
    // The field has already sent the prompt; only submit it, never paste it twice.
    setTimeout(() => { if (state.socket === socket) sendTerminal('\r'); }, 180);
    sentInput = ''; liveInputActive = false;
    $('terminalInput').value = ''; autoSize($('terminalInput')); updateDisplay();
    if (!state.selected) setTerminalTitle(value);
    return;
  }
  // Bracketed paste protects multiline text from executing line by line.
  if (sendTerminal('\x1b[200~' + value + '\x1b[201~')) {
    setTimeout(() => { if (state.socket === socket) sendTerminal('\r'); }, 180);
    if (!state.selected) setTerminalTitle(value);
    $('terminalInput').value = ''; autoSize($('terminalInput'));
  }
};
let shiftedKey = false;
$('shiftKey').onpointerdown = event => event.preventDefault();
$('shiftKey').onclick = () => { shiftedKey = !shiftedKey; $('shiftKey').setAttribute('aria-pressed', String(shiftedKey)); };
const keys = { escape: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', interrupt: '\x03', enter: '\r' };
document.querySelectorAll('[data-key]').forEach(button => {
  button.onpointerdown = event => event.preventDefault();
  button.onclick = () => {
    const key = button.dataset.key, shifted = shiftedKey;
    if ((wrappedDisplay || liveInputActive) && !flushLiveInput()) return;
    if (shifted && ['tab', 'enter', 'up', 'down', 'left', 'right'].includes(key)) socketSend({ type: 'key', key });
    else sendTerminal(keys[key]);
    shiftedKey = false; $('shiftKey').setAttribute('aria-pressed', 'false');
    if ((key === 'enter' || key === 'interrupt') && (wrappedDisplay || liveInputActive)) {
      if (shifted && key === 'enter') {
        $('terminalInput').value += '\n'; sentInput = $('terminalInput').value;
      } else {
        $('terminalInput').value = ''; sentInput = ''; liveInputActive = false;
      }
      autoSize($('terminalInput')); updateDisplay();
    }
  };
});
async function nativeCommand(command) {
  if (!state.terminalReady) throw new Error('Start or reconnect a terminal first.');
  const socket = state.socket;
  sendTerminal('\x15' + command);
  if (wrappedDisplay || liveInputActive) { $('terminalInput').value = ''; sentInput = ''; liveInputActive = false; autoSize($('terminalInput')); updateDisplay(); }
  // Codex treats an immediate Enter in a burst as pasted text. Submit after its
  // paste-detection window, and never send the keystroke to a different session.
  await new Promise(resolve => setTimeout(resolve, 180));
  if (state.socket === socket) sendTerminal('\r');
  if (!matchMedia('(max-width:640px)').matches) term.focus();
}
$('modelButton').onclick = $('alertModel').onclick = () => nativeCommand('/model').catch(report);
$('usageButton').onclick = () => nativeCommand('/usage').catch(report);
$('stopButton').onclick = () => sendTerminal('\x03');
$('closeTerminal').onclick = () => $('confirmDialog').showModal();
$('cancelClose').onclick = () => $('confirmDialog').close();
$('confirmClose').onclick = async () => {
  try {
    ++state.generation; clearTimeout(reconnectTimer); state.socket?.close();
    await post('/terminal/close', { terminalId: state.activeTerminal });
    state.activeTerminal = null; state.terminalReady = false; sessionStorage.removeItem('webuiTerminal');
    $('terminalWelcome').hidden = false; $('terminalHost').hidden = true;
    $('terminalStatus').hidden = $('terminalKeys').hidden = $('terminalComposer').hidden = $('terminalViewport').hidden = $('terminalDisplay').hidden = true;
    $('confirmDialog').close(); updateControls(); await loadTerminals(); loadSessions();
  } catch (error) { report(error); }
};
function autoSize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 130) + 'px'; }
$('terminalInput').addEventListener('compositionstart', () => { composingInput = true; });
$('terminalInput').addEventListener('compositionend', () => {
  composingInput = false;
  if (wrappedDisplay || liveInputActive) flushLiveInput();
});
$('terminalInput').oninput = () => {
  autoSize($('terminalInput'));
  if (wrappedDisplay || liveInputActive) flushLiveInput();
};
$('terminalInput').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer:coarse)').matches) {
    event.preventDefault(); $('terminalComposer').requestSubmit();
  }
};
const events = new EventSource('/events');
events.onopen = () => { $('connectionDot').classList.remove('offline'); $('connectionText').textContent = 'Connected to your Mac'; };
events.onerror = () => { $('connectionDot').classList.add('offline'); $('connectionText').textContent = 'Reconnecting…'; };
$('settingsButton').onclick = () => {
  $('textSize').value = localStorage.getItem('terminalTextSize') || 'auto';
  $('accessToken').value = sessionStorage.getItem('webuiToken') || '';
  $('settingsDialog').showModal();
};
$('settingsForm').onsubmit = event => {
  event.preventDefault();
  sessionStorage.setItem('webuiToken', $('accessToken').value.trim());
  localStorage.setItem('terminalTextSize', $('textSize').value);
  fitTerminal(); $('settingsDialog').close();
};
function updateViewport() { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`); syncSidebarAccessibility(); updateDisplay(); fitTerminal(); }
window.visualViewport?.addEventListener('resize', updateViewport); window.addEventListener('resize', updateViewport); updateViewport();
updateControls(); loadSessions(); loadTerminals();
const previousTerminal = sessionStorage.getItem('webuiTerminal');
if (previousTerminal) connectTerminal({ terminalId: previousTerminal, reconnect: true }).catch(error => {
  sessionStorage.removeItem('webuiTerminal'); state.activeTerminal = null; state.terminalReady = false;
  $('terminalWelcome').hidden = false; $('terminalHost').hidden = true;
  $('terminalStatus').hidden = $('terminalKeys').hidden = $('terminalComposer').hidden = $('terminalViewport').hidden = $('terminalDisplay').hidden = true; updateControls();
});
function refreshExternalChanges() { if (!document.hidden) { loadSessions(); loadTerminals(); } }
setInterval(refreshExternalChanges, 3000);
window.addEventListener('focus', refreshExternalChanges);
document.addEventListener('visibilitychange', refreshExternalChanges);
