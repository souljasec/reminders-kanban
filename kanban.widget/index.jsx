// Reminders Kanban — Apple-style Kanban board for Apple Reminders (Übersicht widget)
// To Do = open · Doing = high priority (!!!) · Done = completed (last 3 days)
//
// • Drag the header to move the widget (snaps to a grid); click the big number for mini mode
// • Click a tab, or swipe left/right with two fingers, to switch columns; drag a task onto a tab to move it there
// • Drag a task up/down to reorder; click the circle to complete (click again quickly to cancel)
// • Click a task to open its details: title, status, deadline, project, link, description
// • Hover a row for 🕒 deadline and ‹ › to move one step; right-click for more
// • Every change shows an Undo toast for a few seconds
// • Smart add: "Pay rent tomorrow 3pm" sets a deadline + alert, end with ! for Doing
//
// Projects + manual order are shared with AI assistants in
//   ~/Library/Application Support/Reminders Kanban/data.json  (edit project names/colours/keywords there)
import { run, css } from 'uebersicht';

const DIR = '"$HOME/Library/Application Support/Übersicht/widgets/kanban.widget"';
const BRIDGE = '"$HOME/Library/Application Support/Reminders Kanban/reminders-kanban"';
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const command = `${BRIDGE} list`;
export const refreshFrequency = 10000;

// ── settings ──
const VISIBLE_ROWS = 7;
const ROW_H = 38;
const WIDTH = 380;
const GRID = 24;     // snap step in points
const EDGE = 16;     // margin from screen edges
const MENU_BAR = 25; // Übersicht's window starts below the menu bar
const DEFAULT_POS = { x: 440, y: 50 };
const BODY_H = 50 + VISIBLE_ROWS * ROW_H; // tabs + list = detail view height

const COLS = [
  { key: 'todo',  label: 'To Do', color: 'var(--blue)' },
  { key: 'doing', label: 'Doing', color: 'var(--orange)' },
  { key: 'done',  label: 'Done',  color: 'var(--green)' },
];
const ORDER = COLS.map(c => c.key);
const colLabel = k => COLS.find(c => c.key === k).label;

// widget-only settings stay in Übersicht's storage; v1.0 order/projects are imported once into data.json
const K = { pos: 'kanban-widget-pos', mini: 'kanban-widget-mini', oldOrder: 'kanban-widget-order', oldProj: 'kanban-widget-projects' };
const load = (key, dflt) => { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } };
const save = (key, v) => localStorage.setItem(key, JSON.stringify(v));

export const className = `
  top: 0; left: 0;
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
`;

// ── state ──
export const initialState = {
  cards: [], pending: {}, patches: {}, hidden: {}, completing: {}, leaving: {},
  order: [], orderT: 0, projectDefs: [], mini: load(K.mini, false),
  tab: 'todo', slide: null, filter: null, adding: false, menu: null, detail: null, descEdit: false, toast: null,
  error: null, loaded: false,
};

let ticks = 0, migrated = false, lastRun = Date.now();
// watchdog: if Übersicht's own refresh ever stalls, refresh ourselves
if (window.__kanbanWatchdog) clearInterval(window.__kanbanWatchdog);
window.__kanbanWatchdog = setInterval(() => {
  if (Date.now() - lastRun > 25000 && dispatchRef) { lastRun = Date.now(); refresh(dispatchRef); }
}, 10000);
const toggle = (obj, id, on) => { const o = { ...obj }; if (on) o[id] = true; else delete o[id]; return o; };

export const updateState = (event, prev) => {
  switch (event.type) {
    case 'UB/COMMAND_RAN': {
      if (event.error) return { ...prev, error: String(event.error) };
      try {
        lastRun = Date.now();
        const data = JSON.parse(event.output);
        const cards = data.tasks || [];
        const pending = { ...prev.pending };
        cards.forEach(c => { if (pending[c.id] === c.status) delete pending[c.id]; });
        const now = Date.now();
        const patches = Object.fromEntries(Object.entries(prev.patches).filter(([, p]) => now - p.t < 4000));
        if (data.fresh && !migrated) migrateOld();
        // on first load and about once a minute, clear icons from under the widget
        if (ticks++ % 6 === 0) setTimeout(() => makeRoom(document.querySelector('[data-kanban]')), 500);
        return { ...prev, cards, pending, patches, projectDefs: data.projects || [],
                 order: now - prev.orderT < 5000 ? prev.order : (data.order || []),
                 error: null, loaded: true };
      } catch (e) { return prev; }
    }
    case 'MOVE':   return { ...prev, pending: { ...prev.pending, [event.id]: event.status } };
    case 'PATCH':  return { ...prev, patches: { ...prev.patches,
                     [event.id]: { fields: { ...(prev.patches[event.id] || {}).fields, ...event.fields }, t: Date.now() } } };
    case 'ADD':    return { ...prev, adding: false, cards: [...prev.cards,
                     { id: 'tmp-' + Date.now(), title: event.title, status: 'todo' }] };
    case 'HIDE':       return { ...prev, hidden: toggle(prev.hidden, event.id, event.on) };
    case 'COMPLETING': return { ...prev, completing: toggle(prev.completing, event.id, event.on) };
    case 'LEAVING':    return { ...prev, leaving: toggle(prev.leaving, event.id, event.on) };
    case 'TAB': {
      if (event.tab === prev.tab && !prev.detail) return prev;
      const dir = Math.sign(ORDER.indexOf(event.tab) - ORDER.indexOf(prev.tab));
      return { ...prev, tab: event.tab, slide: dir ? { dir, view: event.tab + (prev.filter || '') } : null,
               menu: null, detail: null };
    }
    case 'FILTER': return { ...prev, filter: prev.filter === event.filter ? null : event.filter };
    case 'ORDER':  return { ...prev, order: event.order, orderT: Date.now() };
    case 'ADDING': return { ...prev, adding: event.on, detail: event.on ? null : prev.detail };
    case 'MINI':   return { ...prev, mini: event.on, menu: null, adding: false, detail: null };
    case 'DETAIL': return { ...prev, detail: event.id, descEdit: false, menu: null, adding: false,
                     slide: !event.id && prev.detail ? { dir: -1, view: prev.tab + (prev.filter || '') } : prev.slide };
    case 'DESC_EDIT': return { ...prev, descEdit: event.on };
    case 'MENU': {
      const m = event.menu;
      if (m && m.inherit && prev.menu) return { ...prev, menu: { ...m, top: prev.menu.top, bottom: prev.menu.bottom } };
      return { ...prev, menu: m };
    }
    case 'TOAST':  return { ...prev, toast: event.toast };
    case 'TOAST_EXPIRE': return prev.toast && prev.toast.token === event.token ? { ...prev, toast: null } : prev;
    default: return prev;
  }
};

// ── actions ──
const timers = {};
let dispatchRef = null;
const refresh = dispatch => run(command).then(output => dispatch({ type: 'UB/COMMAND_RAN', output }));
const act = (dispatch, cmd, id, fields) => {
  if (id && fields) dispatch({ type: 'PATCH', id, fields });
  return run(`${BRIDGE} ${cmd}`).then(out => { refresh(dispatch); return out; }, () => refresh(dispatch));
};

// one-time import of order + project choices saved by widget v1.0
const migrateOld = () => {
  migrated = true;
  const order = load(K.oldOrder, null), assign = load(K.oldProj, null);
  if (!order && !assign) return;
  run(`${BRIDGE} import ${q(JSON.stringify({ order: order || [], assign: assign || {} }))}`).then(() => {
    localStorage.removeItem(K.oldOrder); localStorage.removeItem(K.oldProj);
    if (dispatchRef) refresh(dispatchRef);
  });
};

const showToast = (dispatch, text, undo) => {
  const token = Math.random();
  dispatch({ type: 'TOAST', toast: { text, undo, token } });
  setTimeout(() => dispatch({ type: 'TOAST_EXPIRE', token }), 4500);
};

const doMove = (dispatch, card, to, { toast = true, text } = {}) => {
  const from = card.status;
  if (from === to) return;
  dispatch({ type: 'MOVE', id: card.id, status: to });
  run(`${BRIDGE} move ${q(card.id)} ${to}`);
  if (toast) showToast(dispatch, text || `Moved to ${colLabel(to)}`, { kind: 'move', id: card.id, to: from });
};

// tick → strike → slide away; clicking again before it leaves cancels
const complete = (dispatch, card, completing) => {
  const id = card.id;
  if (completing[id]) {
    clearTimeout(timers['c' + id]); clearTimeout(timers['l' + id]);
    dispatch({ type: 'COMPLETING', id, on: false }); dispatch({ type: 'LEAVING', id, on: false });
    return;
  }
  dispatch({ type: 'COMPLETING', id, on: true });
  timers['c' + id] = setTimeout(() => {
    dispatch({ type: 'LEAVING', id, on: true });
    timers['l' + id] = setTimeout(() => {
      doMove(dispatch, card, 'done', { text: 'Completed' });
      dispatch({ type: 'COMPLETING', id, on: false }); dispatch({ type: 'LEAVING', id, on: false });
    }, 320);
  }, 850);
};

const add = (dispatch, text) => {
  dispatch({ type: 'ADD', title: text });
  act(dispatch, `add ${q(text)}`).then(out => {
    const id = (out || '').trim();
    if (id) showToast(dispatch, text.trim().endsWith('!') ? 'Added to Doing' : 'Task added', { kind: 'added', id });
  });
};

// title / notes / url / due  →  bridge `update`, with optimistic patch + Undo
const update = (dispatch, card, fields, text) => {
  const patch = {}, prev = {};
  Object.keys(fields).forEach(k => {
    if (k === 'due') {
      // "YYYY-MM-DD" = all-day; undo must restore an all-day deadline as all-day
      const day = /^\d{4}-\d{2}-\d{2}$/.test(fields.due);
      patch.due = fields.due === 'none' ? null : day ? new Date(fields.due + 'T00:00').toISOString() : fields.due;
      patch.hasTime = fields.due !== 'none' && !day;
      prev.due = !card.due ? 'none' : card.hasTime === false ? toLocalInput(new Date(card.due)).slice(0, 10) : card.due;
    } else { patch[k] = fields[k]; prev[k] = card[k] || ''; }
  });
  act(dispatch, `update ${q(card.id)} ${q(JSON.stringify(fields))}`, card.id, patch);
  if (text) showToast(dispatch, text, { kind: 'update', id: card.id, fields: prev });
};

const setDue = (dispatch, card, date, verb = 'Deadline') => {
  dispatch({ type: 'MENU', menu: null });
  const iso = date ? date.toISOString() : 'none';
  update(dispatch, card, { due: iso }, date ? `${verb} · ${dueInfo(iso, true).text}` : 'Deadline cleared');
};

const setProject = (dispatch, card, key, defs) => {
  dispatch({ type: 'MENU', menu: null });
  const next = card.project === key ? 'none' : key;
  act(dispatch, `project ${q(card.id)} ${next}`, card.id, { project: next === 'none' ? null : key });
  const def = defs.find(p => p.key === next);
  showToast(dispatch, def ? `Project · ${def.label}` : 'Project removed',
    { kind: 'project', id: card.id, prev: card.project || 'none' });
};

// deleting waits until the Undo window has passed
const remove = (dispatch, card) => {
  dispatch({ type: 'MENU', menu: null });
  dispatch({ type: 'DETAIL', id: null });
  dispatch({ type: 'HIDE', id: card.id, on: true });
  timers['d' + card.id] = setTimeout(() => run(`${BRIDGE} delete ${q(card.id)}`).then(() => refresh(dispatch)), 4700);
  showToast(dispatch, 'Task deleted', { kind: 'delete', id: card.id });
};

const undo = (dispatch, u) => {
  dispatch({ type: 'TOAST', toast: null });
  switch (u.kind) {
    case 'move':    doMove(dispatch, { id: u.id, status: null }, u.to, { toast: false }); break;
    case 'update':  update(dispatch, { id: u.id }, u.fields, null); break;
    case 'project': act(dispatch, `project ${q(u.id)} ${u.prev}`, u.id, { project: u.prev === 'none' ? null : u.prev }); break;
    case 'delete':  clearTimeout(timers['d' + u.id]); dispatch({ type: 'HIDE', id: u.id, on: false }); break;
    case 'added':   dispatch({ type: 'HIDE', id: u.id, on: true }); act(dispatch, `delete ${q(u.id)}`); break;
  }
};

const openUrl = url => run(`open ${q(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url)}`);
const openInReminders = (dispatch, id) => {
  dispatch({ type: 'MENU', menu: null });
  run(`open ${q('x-apple-reminderkit://REMCDReminder/' + id)} || open -a Reminders`);
};

// ── desktop icons + window drag ──
const makeRoom = el => {
  if (!el) return;
  const r = el.getBoundingClientRect();
  run(`/usr/bin/python3 -I ${DIR}/make-room.py ${Math.round(r.left)} ${Math.round(r.top + MENU_BAR)} ${Math.round(r.width)} ${Math.round(r.height)}`);
};

// drag anywhere on the header to move; a plain click on the number toggles mini mode
const startWindowDrag = (dispatch, mini) => e => {
  if (e.button !== 0 || e.target.closest('button, input, [data-nodrag]')) return;
  const el = e.currentTarget.closest('[data-kanban]');
  const onToggle = !!e.target.closest('[data-toggle]');
  const sx = e.clientX, sy = e.clientY;
  const ox = parseFloat(el.style.left) || 0, oy = parseFloat(el.style.top) || 0;
  let moved = false;
  const onMove = m => {
    if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
    moved = true;
    el.style.cursor = 'grabbing';
    el.style.left = Math.max(0, ox + m.clientX - sx) + 'px';
    el.style.top = Math.max(0, oy + m.clientY - sy) + 'px';
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    el.style.cursor = '';
    if (!moved) {
      if (onToggle) {
        save(K.mini, !mini);
        dispatch({ type: 'MINI', on: !mini });
        if (mini) setTimeout(() => makeRoom(el), 350);
      }
      return;
    }
    const snap = (v, max) =>
      Math.min(Math.max(EDGE, Math.round((v - EDGE) / GRID) * GRID + EDGE), Math.max(EDGE, max - EDGE));
    const x = snap(parseFloat(el.style.left), window.innerWidth - el.offsetWidth);
    const y = snap(parseFloat(el.style.top), window.innerHeight - el.offsetHeight);
    el.style.transition = 'left 0.22s cubic-bezier(.22,1,.36,1), top 0.22s cubic-bezier(.22,1,.36,1)';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    setTimeout(() => { el.style.transition = ''; makeRoom(el); }, 260);
    save(K.pos, { x, y });
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  e.preventDefault();
};

// ── two-finger swipe: left/right switches columns, right goes back from the detail view ──
// One swipe = one step. After a step the trackpad keeps sending fading "momentum" events; those are
// ignored, but a new swipe (deltas suddenly growing, or the other direction) is picked up right away.
const swipe = { acc: 0, lock: 0, at: 0, last: 0, idle: null };
const SWIPE_DIST = 45;
const onSwipe = (dispatch, tab, inDetail) => e => {
  const dx = e.deltaX, ax = Math.abs(dx);
  clearTimeout(swipe.idle);
  swipe.idle = setTimeout(() => { swipe.acc = 0; swipe.lock = 0; swipe.last = 0; }, 150);
  if (swipe.lock) {
    const fresh = Date.now() - swipe.at > 220 && ((ax > 6 && ax > swipe.last * 1.6) || (ax > 3 && Math.sign(dx) !== swipe.lock));
    swipe.last = ax;
    if (!fresh) return;
    swipe.lock = 0; swipe.acc = 0;
  }
  swipe.last = ax;
  if (Math.abs(dx) <= Math.abs(e.deltaY)) return;   // vertical scrolling: leave it alone
  swipe.acc += dx;
  if (Math.abs(swipe.acc) < SWIPE_DIST) return;
  const dir = swipe.acc > 0 ? 1 : -1;
  swipe.acc = 0; swipe.lock = dir; swipe.at = Date.now();
  if (inDetail) { if (dir < 0) dispatch({ type: 'DETAIL', id: null }); return; }
  const next = ORDER[ORDER.indexOf(tab) + dir];
  if (next) { dispatch({ type: 'TAB', tab: next }); return; }
  // already at the first/last column: a small rubber-band nudge
  const el = e.currentTarget.querySelector('[data-list]');
  if (el && el.animate) el.animate([{ transform: 'none' }, { transform: `translateX(${-dir * 7}px)` }, { transform: 'none' }],
    { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' });
};

// ── ordering + glide animation ──
const sortByOrder = (list, order) => {
  const idx = new Map(order.map((id, i) => [id, i]));
  return list.map((c, i) => ({ c, k: idx.has(c.id) ? idx.get(c.id) : 1e6 + i }))
    .sort((a, b) => a.k - b.k).map(x => x.c);
};
const reorder = (dispatch, all, order, dragId, targetId, after) => {
  if (!dragId || dragId === targetId) return;
  const ids = sortByOrder(all, order).map(c => c.id).filter(id => id !== dragId && !id.startsWith('tmp-'));
  const i = ids.indexOf(targetId);
  if (i < 0) return;
  ids.splice(after ? i + 1 : i, 0, dragId);
  dispatch({ type: 'ORDER', order: ids });
  run(`${BRIDGE} order ${q(JSON.stringify(ids))}`);
};
const clearMarks = el => el.classList.remove('above', 'below');

// FLIP: rows that change position glide to their new place; new rows fade in
const flip = { pos: {}, view: null, ready: false };
const flipRef = view => listEl => {
  if (!listEl) return;
  const rows = listEl.querySelectorAll('[data-row]');
  const same = flip.view === view && flip.ready;
  const next = {};
  rows.forEach(el => {
    const id = el.dataset.id, top = el.offsetTop;
    next[id] = top;
    if (!same) return;
    const old = flip.pos[id];
    if (old == null) {
      el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    } else if (old !== top) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${old - top}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transition = 'transform 0.3s cubic-bezier(.22,1,.36,1)';
        el.style.transform = '';
        setTimeout(() => { el.style.transition = ''; }, 340);
      }));
    }
  });
  flip.pos = next; flip.view = view; flip.ready = flip.ready || rows.length > 0;
};

// ── dates ──
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayDiff = (a, b) => Math.round((dayStart(a) - dayStart(b)) / 864e5);
const fmtTime = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });

const dueInfo = (iso, hasTime) => {
  if (!iso) return null;
  const d = new Date(iso), now = new Date();
  const days = dayDiff(d, now);
  const t = hasTime ? fmtTime(d) : '';
  const soft = 'var(--fg2)';
  if (d < now && !(days === 0 && !hasTime))
    return { text: days < 0 ? `${-days}d late` : `${t} · late`, color: 'var(--red)', overdue: true };
  if (days === 0) return { text: t || 'Today', color: 'var(--orange)', today: true };
  if (days === 1) return { text: t ? `Tmrw ${t}` : 'Tomorrow', color: soft };
  if (days < 7) return { text: d.toLocaleDateString(undefined, { weekday: 'short' }) + (t ? ` ${t}` : ''), color: soft };
  return { text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), color: soft };
};
const fmtFull = (iso, hasTime = true) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + (hasTime ? ', ' + fmtTime(d) : '');
};

const at = (base, addDays, h, m = 0) => {
  const d = new Date(base); d.setDate(d.getDate() + addDays); d.setHours(h, m, 0, 0); return d;
};
const quickDates = () => {
  const now = new Date(), out = [];
  if (now.getHours() < 17) out.push(['Today', '6 PM', at(now, 0, 18)]);
  else if (now.getHours() < 20) out.push(['Tonight', '9 PM', at(now, 0, 21)]);
  out.push(['Tomorrow', '9 AM', at(now, 1, 9)]);
  // on Saturday "this weekend" means Sunday, not next Saturday
  if (now.getDay() === 6) out.push(['This weekend', 'Sun 10 AM', at(now, 1, 10)]);
  else if (now.getDay() !== 0) out.push(['This weekend', 'Sat 10 AM', at(now, 6 - now.getDay(), 10)]);
  out.push(['Next week', 'Mon 9 AM', at(now, (1 - now.getDay() + 7) % 7 || 7, 9)]);
  return out;
};
const snoozeOptions = () => {
  const now = new Date(), out = [['+1 hour', new Date(now.getTime() + 36e5)]];
  if (now.getHours() < 20) out.push(['Tonight', at(now, 0, 21)]);
  out.push(['Tomorrow', at(now, 1, 9)]);
  return out;
};
const toLocalInput = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// text with clickable links
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"')\]]+)/gi;
const linkify = text => String(text).split(URL_RE).map((part, i) =>
  i % 2 === 1
    ? <a key={i} className="lnk" onClick={e => { e.preventDefault(); e.stopPropagation(); openUrl(part); }}>{part}</a>
    : part);
const shortUrl = u => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

// ── icons ──
const svg = (d, size = 11, w = 1.8) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{d}</svg>);
const Icon = {
  clock: () => svg(<g><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5V8l2.5 1.5" /></g>),
  left:  () => svg(<path d="M10 3L5 8l5 5" />, 10, 2.2),
  right: () => svg(<path d="M6 3l5 5-5 5" />, 10, 2.2),
  back:  () => svg(<path d="M10 3L5 8l5 5" />, 12, 2.2),
  plus:  () => svg(<path d="M8 2.5v11M2.5 8h11" />, 14, 2),
  link:  ({ size = 11 } = {}) => svg(<g><path d="M6.5 9.5l3-3" /><path d="M7 4.5l1.2-1.2a2.8 2.8 0 014 4L11 8.5" /><path d="M9 11.5l-1.2 1.2a2.8 2.8 0 01-4-4L5 7.5" /></g>, size),
  note:  () => svg(<path d="M3 4.5h10M3 8h10M3 11.5h6" />, 11),
  out:   () => svg(<g><path d="M9 3h4v4" /><path d="M13 3L7.5 8.5" /><path d="M11 9.5V13H3V5h3.5" /></g>, 10, 1.8),
  tick:  () => (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path className="tick" d="M2.6 6.3l2.2 2.2 4.6-4.9" />
    </svg>),
};

// ── styles ──
// keyframes live in one global <style> so every class below can use them
(() => {
  let el = document.getElementById('kanban-kf');
  if (!el) { el = document.createElement('style'); el.id = 'kanban-kf'; document.head.appendChild(el); }
  el.textContent = `
@keyframes kbPop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes kbFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes kbEnter { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@keyframes kbCheck { 0% { transform: scale(1); } 45% { transform: scale(1.28); } 100% { transform: scale(1); } }
@keyframes kbDraw { from { stroke-dashoffset: 12; } to { stroke-dashoffset: 0; } }
@keyframes kbMenu { from { opacity: 0; transform: translateY(-4px) scale(0.97); } to { opacity: 1; transform: none; } }
@keyframes kbToast { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes kbSlideIn { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
@keyframes kbSlideBack { from { opacity: 0; transform: translateX(-18px); } to { opacity: 1; transform: none; } }
`;
})();

const ease = 'cubic-bezier(.22,1,.36,1)';
const box = css`
  /* colours follow the Mac's light / dark appearance */
  --bg: rgba(36, 36, 38, 0.93); --solid: #29292b;
  --fg: #fff; --fg2: rgba(255,255,255,0.58); --fg3: rgba(255,255,255,0.36);
  --line: rgba(255,255,255,0.09); --line2: rgba(255,255,255,0.14);
  --fill: rgba(255,255,255,0.07); --fill2: rgba(255,255,255,0.13); --fill3: rgba(255,255,255,0.2);
  --pill: rgba(255,255,255,0.17); --ring: rgba(255,255,255,0.42);
  --menu: rgba(48,48,51,0.98); --toast: rgba(64,64,68,0.98); --toastfg: #fff;
  --red: #FF453A; --orange: #FF9F0A; --green: #30D158; --blue: #0A84FF; --link: #64B5FF;
  --shadow: 0 10px 34px rgba(0,0,0,0.38), 0 1px 3px rgba(0,0,0,0.2);
  @media (prefers-color-scheme: light) {
    --bg: rgba(250, 250, 252, 0.94); --solid: #f8f8fa;
    --fg: #1d1d1f; --fg2: rgba(0,0,0,0.52); --fg3: rgba(0,0,0,0.32);
    --line: rgba(0,0,0,0.07); --line2: rgba(0,0,0,0.11);
    --fill: rgba(0,0,0,0.045); --fill2: rgba(0,0,0,0.07); --fill3: rgba(0,0,0,0.11);
    --pill: #fff; --ring: rgba(0,0,0,0.28);
    --menu: rgba(255,255,255,0.99); --toast: rgba(30,30,32,0.96); --toastfg: #fff;
    --red: #FF3B30; --orange: #FF9500; --green: #34C759; --blue: #007AFF; --link: #007AFF;
    --shadow: 0 10px 34px rgba(0,0,0,0.16), 0 1px 3px rgba(0,0,0,0.08);
  }

  position: absolute;
  width: ${WIDTH}px;
  padding: 16px 16px 10px;
  box-sizing: border-box;
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0) 30%), var(--bg);
  border: 0.5px solid var(--line2);
  box-shadow: var(--shadow), inset 0 0.5px 0 rgba(255,255,255,0.08);
  color: var(--fg);
  user-select: none;
  animation: kbPop 0.32s ${ease};

  &.mini {
    width: auto; padding: 8px 14px 8px 10px; border-radius: 19px;
    display: flex; align-items: center; gap: 9px; cursor: grab;
  }
  .lnk { color: var(--link); cursor: pointer; text-decoration: none; word-break: break-all; }
  .lnk:hover { text-decoration: underline; }
`;
const head = css`display: flex; align-items: flex-start; justify-content: space-between; cursor: grab;`;
const bigNum = css`
  font-size: 34px; font-weight: 700; line-height: 1; letter-spacing: -0.6px;
  font-variant-numeric: tabular-nums; cursor: pointer; display: inline-block;
  transition: color 0.2s, transform 0.15s;
  &:hover { transform: scale(1.04); }
`;
const headTitle = css`
  display: flex; align-items: baseline; gap: 7px; white-space: nowrap;
  font-size: 16px; font-weight: 700; margin-top: 4px;
  .proj { font-size: 13px; font-weight: 600; }
  .sum { font-size: 11.5px; font-weight: 600; }
`;
const headRight = css`display: flex; align-items: center; gap: 10px;`;
const dots = css`
  display: flex; gap: 7px;
  span {
    width: 9px; height: 9px; border-radius: 50%; cursor: pointer; opacity: 0.85;
    transition: transform 0.15s ${ease}, opacity 0.15s, box-shadow 0.15s;
  }
  span:hover { transform: scale(1.3); opacity: 1; }
  &.filtering span { opacity: 0.3; }
  &.filtering span.on { opacity: 1; box-shadow: 0 0 0 2px var(--solid), 0 0 0 3.5px currentColor; }
`;
const roundBtn = css`
  width: 32px; height: 32px; border-radius: 50%; border: none;
  background: var(--fill2); color: var(--fg); padding: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, transform 0.25s ${ease};
  &:hover { background: var(--fill3); }
  &.open { transform: rotate(45deg); }
`;
const tabs = css`
  position: relative; display: flex; margin: 12px 0 8px;
  background: var(--fill); border-radius: 9px; padding: 3px;
  .slider {
    position: absolute; top: 3px; bottom: 3px; width: calc((100% - 6px) / 3);
    background: var(--pill); border-radius: 7px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    transition: left 0.3s ${ease};
  }
`;
const tabCls = css`
  position: relative; flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
  font-size: 12px; font-weight: 600; color: var(--fg2);
  padding: 5px 0; border-radius: 7px; cursor: pointer; transition: color 0.2s, background 0.15s;
  &.on { color: var(--fg); }
  &.over { background: rgba(10, 132, 255, 0.35); color: var(--fg); }
  .n { font-weight: 500; opacity: 0.55; font-variant-numeric: tabular-nums; }
`;
const tabDot = css`width: 7px; height: 7px; border-radius: 50%;`;
const inputCls = css`
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; color: var(--fg);
  background: var(--fill); border: 1px solid var(--blue);
  border-radius: 9px; padding: 7px 10px; outline: none; margin-bottom: 6px;
  animation: kbEnter 0.25s ${ease};
  &::placeholder { color: var(--fg3); }
`;
const listCls = css`
  height: ${VISIBLE_ROWS * ROW_H}px;
  overflow-y: auto;
  border-top: 0.5px solid var(--line2);
  animation: kbFade 0.22s ease-out;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 10px), transparent);
  &::-webkit-scrollbar { width: 0; }
  &.from-right { animation: kbSlideIn 0.28s ${ease}; }
  &.from-left { animation: kbSlideBack 0.28s ${ease}; }
`;
const row = css`
  position: relative; height: ${ROW_H}px; box-sizing: border-box; overflow: hidden;
  display: flex; align-items: center; gap: 11px; padding-left: 9px;
  font-size: 14px; cursor: default;
  transition: height 0.3s ${ease}, opacity 0.3s, transform 0.3s ${ease};
  .bar {
    position: absolute; left: 0; top: 50%; width: 3px; height: 16px; margin-top: -8px;
    border-radius: 2px; opacity: 0.9;
  }
  .t {
    flex: 1; min-width: 0; height: 100%; cursor: pointer;
    display: flex; align-items: center; gap: 6px;
    border-bottom: 0.5px solid var(--line);
  }
  .t .title {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: color 0.25s;
    background: linear-gradient(currentColor, currentColor) no-repeat 0 55% / 0 1px;
  }
  .t .mark { flex: none; display: flex; color: var(--fg3); }
  &:last-child .t { border-bottom: none; }
  &.done .t .title, &.completing .t .title { color: var(--fg3); background-size: 100% 1px; }
  &.completing .t .title { transition: color 0.25s, background-size 0.35s ${ease}; }
  &.leaving { height: 0; opacity: 0; transform: translateX(14px); }
  &.enter { animation: kbEnter 0.32s ${ease}; }
  &:hover .actions, &.menuOpen .actions { opacity: 1; transform: translateY(-50%); }
  &.above { box-shadow: inset 0 2px 0 var(--blue); }
  &.below { box-shadow: inset 0 -2px 0 var(--blue); }
  &.dragging { opacity: 0.3; }
`;
const circle = css`
  flex: none; width: 18px; height: 18px; border-radius: 50%; box-sizing: border-box;
  border: 1.5px solid var(--ring); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s, background 0.2s;
  &:hover { border-color: var(--fg2); }
  &.doing { border-color: var(--orange); }
  &.checked { background: var(--green); border-color: var(--green); }
  &.pop { animation: kbCheck 0.38s ${ease}; }
  &.pop .tick { stroke-dasharray: 12; animation: kbDraw 0.3s ease-out 0.05s both; }
`;
const dueCls = css`flex: none; margin-left: auto; padding-right: 4px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;`;
const actions = css`
  position: absolute; right: 0; top: 50%; transform: translate(4px, -50%);
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s, transform 0.2s ${ease};
  background: linear-gradient(to right, transparent, var(--solid) 12px); padding-left: 16px;
  button {
    display: flex; align-items: center; justify-content: center; height: 22px; min-width: 24px;
    border: none; background: var(--fill2); color: var(--fg);
    border-radius: 7px; padding: 0 6px; cursor: pointer; transition: background 0.12s, color 0.12s;
  }
  button:hover { background: var(--blue); color: #fff; }
`;
const emptyCls = css`
  height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  text-align: center; padding: 0 30px; animation: kbFade 0.3s ease-out;
  .icon { font-size: 22px; color: var(--green); margin-bottom: 2px; }
  .main { font-size: 14px; font-weight: 600; color: var(--fg2); }
  .sub { font-size: 12px; color: var(--fg3); line-height: 1.35; }
`;
const detailCls = css`
  height: ${BODY_H - 11}px; box-sizing: border-box; margin-top: 12px;
  display: flex; flex-direction: column; gap: 9px;
  animation: kbSlideIn 0.3s ${ease};
  .top { display: flex; align-items: center; justify-content: space-between; }
  .back {
    display: flex; align-items: center; gap: 3px; border: none; background: none; padding: 2px 4px 2px 0;
    color: var(--blue); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  }
  .back:hover { opacity: 0.75; }
  .seg { display: flex; gap: 2px; background: var(--fill); border-radius: 8px; padding: 2px; }
  .seg span {
    font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 6px; cursor: pointer;
    color: var(--fg2); transition: background 0.15s, color 0.15s;
  }
  .seg span:hover { color: var(--fg); }
  .seg span.on { background: var(--pill); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
  .titleIn {
    font: inherit; font-size: 17px; font-weight: 700; color: var(--fg); letter-spacing: -0.2px;
    background: transparent; border: 1px solid transparent; border-radius: 7px; padding: 4px 6px; margin: 0 -7px;
    outline: none; transition: background 0.15s, border-color 0.15s;
  }
  .titleIn:hover { background: var(--fill); }
  .titleIn:focus { background: var(--fill); border-color: var(--blue); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 12px;
    background: var(--fill); font-size: 12px; font-weight: 500; color: var(--fg2); cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .chip:hover { background: var(--fill3); color: var(--fg); }
  .chip i { width: 7px; height: 7px; border-radius: 50%; }
  .field {
    display: flex; align-items: center; gap: 7px; padding: 0 4px 0 9px; height: 30px;
    background: var(--fill); border-radius: 8px; color: var(--fg3);
    border: 1px solid transparent; transition: border-color 0.15s;
  }
  .field:focus-within { border-color: var(--blue); }
  .field input {
    flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--link);
    background: none; border: none; outline: none;
  }
  .field input::placeholder { color: var(--fg3); }
  .field button {
    display: flex; align-items: center; gap: 4px; border: none; background: var(--fill2); color: var(--fg);
    font: inherit; font-size: 11.5px; font-weight: 500; border-radius: 6px; padding: 3px 8px; cursor: pointer;
  }
  .field button:hover { background: var(--blue); color: #fff; }
  .desc {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    background: var(--fill); border-radius: 8px; border: 1px solid transparent;
    transition: border-color 0.15s;
  }
  .desc:focus-within { border-color: var(--blue); }
  .desc .text {
    flex: 1; overflow-y: auto; padding: 8px 10px; font-size: 13px; line-height: 1.45; color: var(--fg);
    white-space: pre-wrap; cursor: text; user-select: text;
  }
  .desc .text::-webkit-scrollbar { width: 0; }
  .desc .ph { color: var(--fg3); }
  .desc textarea {
    flex: 1; resize: none; font: inherit; font-size: 13px; line-height: 1.45; color: var(--fg);
    background: none; border: none; outline: none; padding: 8px 10px;
  }
  .foot { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 0 2px 2px; }
  .foot span { cursor: pointer; color: var(--fg2); display: flex; align-items: center; gap: 4px; }
  .foot span:hover { color: var(--fg); }
  .foot .danger { color: var(--red); }
  .foot .danger:hover { color: var(--red); opacity: 0.75; }
  .hint { color: var(--fg3); font-size: 11px; }
`;
const scrim = css`position: fixed; inset: 0; z-index: 9;`;
const menuCls = css`
  position: absolute; right: 16px; z-index: 10; width: 228px;
  background: var(--menu); border: 0.5px solid var(--line2);
  border-radius: 11px; padding: 5px; box-shadow: var(--shadow);
  font-size: 13px; color: var(--fg);
  animation: kbMenu 0.18s ${ease};
  .item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 9px; border-radius: 6px; cursor: pointer;
  }
  .item:hover { background: var(--blue); color: #fff; }
  .item .hint { color: var(--fg3); font-size: 12px; }
  .item:hover .hint { color: rgba(255,255,255,0.8); }
  .item.danger { color: var(--red); }
  .item.danger:hover { background: var(--red); color: #fff; }
  .sep { height: 0.5px; background: var(--line2); margin: 4px 6px; }
  .label { padding: 5px 9px 3px; font-size: 11px; font-weight: 500; color: var(--fg3); }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 3px 7px 6px; }
  .chip {
    display: flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 20px;
    background: var(--fill); font-size: 12px; cursor: pointer; transition: background 0.12s;
  }
  .chip:hover { background: var(--fill3); }
  .chip.on { background: var(--blue); color: #fff; }
  .chip i { width: 7px; height: 7px; border-radius: 50%; }
  .pick { display: flex; gap: 5px; padding: 3px 6px 6px; }
  input {
    font: inherit; font-size: 12px; color: var(--fg); color-scheme: light dark;
    background: var(--fill); border: 1px solid var(--line2);
    border-radius: 6px; padding: 4px 6px; outline: none; min-width: 0;
  }
  input:focus { border-color: var(--blue); }
  .pick input { flex: 1; }
  button.btn {
    border: none; background: var(--blue); color: #fff; font: inherit; font-size: 12px; font-weight: 500;
    border-radius: 6px; padding: 4px 11px; cursor: pointer;
  }
`;
const toastCls = css`
  position: absolute; left: 50%; bottom: 14px; z-index: 8; transform: translate(-50%, 0);
  display: flex; align-items: center; gap: 12px; white-space: nowrap;
  background: var(--toast); color: var(--toastfg); border-radius: 11px;
  padding: 7px 7px 7px 13px; font-size: 12.5px; font-weight: 500;
  box-shadow: 0 6px 20px rgba(0,0,0,0.3);
  animation: kbToast 0.28s ${ease};
  button {
    border: none; background: rgba(255,255,255,0.14); color: #64B5FF; font: inherit; font-weight: 600;
    border-radius: 7px; padding: 3px 10px; cursor: pointer;
  }
  button:hover { background: rgba(255,255,255,0.22); }
`;
const miniCls = css`
  display: flex; align-items: center; gap: 9px; animation: kbFade 0.25s ease-out;
  .n { font-size: 22px; font-weight: 700; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; cursor: pointer; }
  .l { font-size: 13px; font-weight: 600; color: var(--fg2); }
  .c { display: flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; }
  .c i { width: 6px; height: 6px; border-radius: 50%; }
`;

// ── popover menus ──
const DueMenu = ({ card, dispatch }) => (
  <div>
    <div className="label">Deadline · you'll get an alert</div>
    {quickDates().map(([label, hint, d]) => (
      <div key={label} className="item" onClick={() => setDue(dispatch, card, d)}>
        {label}<span className="hint">{hint}</span>
      </div>
    ))}
    <div className="sep" />
    <div className="label">Pick a date & time</div>
    <div className="pick">
      <input type="datetime-local" id="kanban-pick"
        defaultValue={toLocalInput(card.due ? new Date(card.due) : at(new Date(), 1, 9))}
        onKeyDown={e => e.key === 'Enter' && e.target.value && setDue(dispatch, card, new Date(e.target.value))} />
      <button className="btn" onClick={() => {
        const v = document.getElementById('kanban-pick').value;
        if (v) setDue(dispatch, card, new Date(v));
      }}>Set</button>
    </div>
    {card.due && <div>
      <div className="sep" />
      <div className="item danger" onClick={() => setDue(dispatch, card, null)}>Clear deadline</div>
    </div>}
  </div>
);

const ProjectChips = ({ card, dispatch, defs }) => (
  <div className="chips">
    {defs.map(p => (
      <span key={p.key} className={`chip ${card.project === p.key ? 'on' : ''}`}
        onClick={() => setProject(dispatch, card, p.key, defs)}>
        <i style={{ background: p.color }} />{p.label}
      </span>
    ))}
  </div>
);

const ContextMenu = ({ card, dispatch, defs }) => {
  const sub = kind => e => { e.stopPropagation(); dispatch({ type: 'MENU', menu: { id: card.id, kind, inherit: true } }); };
  const info = dueInfo(card.due, card.hasTime);
  return (
    <div>
      {card.due && card.status !== 'done' && <div>
        <div className="label">{info && info.overdue ? 'Overdue · snooze until' : 'Snooze until'}</div>
        <div className="chips">
          {snoozeOptions().map(([label, d]) => (
            <span key={label} className="chip" onClick={() => setDue(dispatch, card, d, 'Snoozed')}>{label}</span>
          ))}
        </div>
        <div className="sep" />
      </div>}
      <div className="item" onClick={() => dispatch({ type: 'DETAIL', id: card.id })}>Open details<span className="hint">click</span></div>
      {card.status !== 'done' &&
        <div className="item" onClick={sub('due')}>{card.due ? 'Change deadline…' : 'Set deadline…'}</div>}
      {card.url && <div className="item" onClick={() => { dispatch({ type: 'MENU', menu: null }); openUrl(card.url); }}>
        Open link<span className="hint">{shortUrl(card.url).slice(0, 18)}</span></div>}
      <div className="item" onClick={() => openInReminders(dispatch, card.id)}>Open in Reminders</div>
      <div className="sep" />
      <div className="label">Project</div>
      <ProjectChips card={card} dispatch={dispatch} defs={defs} />
      <div className="sep" />
      <div className="item danger" onClick={() => remove(dispatch, card)}>Delete</div>
    </div>
  );
};

const ProjectMenu = ({ card, dispatch, defs }) => (
  <div>
    <div className="label">Project</div>
    <ProjectChips card={card} dispatch={dispatch} defs={defs} />
    <div className="label" style={{ paddingTop: 0 }}>Add projects in data.json, or ask your AI</div>
  </div>
);

// ── detail view ──
const Detail = ({ card, dispatch, defs, descEdit, openMenu }) => {
  const proj = defs.find(p => p.key === card.project);
  const due = dueInfo(card.due, card.hasTime);
  const saveTitle = el => {
    const v = el.value.trim();
    if (v && v !== card.title) update(dispatch, card, { title: v }, 'Renamed');
    else el.value = card.title;
  };
  const saveUrl = el => {
    const v = el.value.trim();
    if (v !== (card.url || '')) update(dispatch, card, { url: v }, v ? 'Link saved' : 'Link removed');
  };
  const saveNotes = el => {
    dispatch({ type: 'DESC_EDIT', on: false });
    const v = el.value.trim();
    if (v !== (card.notes || '')) update(dispatch, card, { notes: v }, v ? 'Description saved' : 'Description removed');
  };
  return (
    <div className={detailCls} key={card.id}
      onKeyDown={e => { if (e.key === 'Escape' && e.target.tagName !== 'TEXTAREA') dispatch({ type: 'DETAIL', id: null }); }}>
      <div className="top">
        <button className="back" onClick={() => dispatch({ type: 'DETAIL', id: null })}><Icon.back />{colLabel(card.status)}</button>
        <div className="seg">
          {COLS.map(c => (
            <span key={c.key} className={card.status === c.key ? 'on' : ''}
              onClick={() => doMove(dispatch, card, c.key)}>{c.label}</span>
          ))}
        </div>
      </div>

      <input className="titleIn" key={card.title} defaultValue={card.title}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = card.title; e.target.blur(); } }}
        onBlur={e => saveTitle(e.target)} />

      <div className="chips">
        {card.status !== 'done' && (
          <span className="chip" data-anchor onClick={e => openMenu(e, card.id, 'due')}
            style={due ? { color: due.color } : {}}>
            <Icon.clock />{card.due ? fmtFull(card.due, card.hasTime !== false) : 'Add deadline'}
          </span>
        )}
        <span className="chip" data-anchor onClick={e => openMenu(e, card.id, 'proj')}>
          <i style={{ background: proj ? proj.color : 'var(--fg3)' }} />{proj ? proj.label : 'No project'}
        </span>
      </div>

      <div className="field">
        <Icon.link />
        <input key={card.url || ''} defaultValue={card.url || ''} placeholder="Add a link" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
          onBlur={e => saveUrl(e.target)} />
        {card.url && <button onClick={() => openUrl(card.url)}>Open <Icon.out /></button>}
      </div>

      <div className="desc">
        {descEdit
          ? <textarea autoFocus defaultValue={card.notes || ''} placeholder="Add a description…"
              onKeyDown={e => {
                if (e.key === 'Enter' && e.metaKey) e.target.blur();
                if (e.key === 'Escape') { e.target.value = card.notes || ''; e.target.blur(); }
              }}
              onBlur={e => saveNotes(e.target)} />
          : <div className="text" onClick={() => dispatch({ type: 'DESC_EDIT', on: true })}>
              {card.notes ? linkify(card.notes) : <span className="ph">Add a description…</span>}
            </div>}
      </div>

      <div className="foot">
        <span onClick={() => openInReminders(dispatch, card.id)}>Open in Reminders <Icon.out /></span>
        {descEdit ? <span className="hint">⌘↩ to save</span>
                  : <span className="danger" onClick={() => remove(dispatch, card)}>Delete</span>}
      </div>
    </div>
  );
};

const EMPTY = {
  todo:  { icon: '✓', main: 'All clear', sub: 'Nothing left to do. Add a task with +, or ask your AI' },
  doing: { main: 'Nothing in progress', sub: 'Drag a task onto Doing, or end a new one with !' },
  done:  { main: 'Nothing finished yet', sub: 'Completed tasks stay here for 3 days' },
};

// ── render ──
export const render = (state, dispatch) => {
  dispatchRef = dispatch;
  const { cards, pending, patches, hidden, completing, leaving, order, projectDefs: defs, mini,
          tab, slide, filter, adding, menu, detail, descEdit, toast, error, loaded } = state;
  const pos = load(K.pos, DEFAULT_POS);
  const all = cards
    .map(c => (patches[c.id] ? { ...c, ...patches[c.id].fields } : c))
    .filter(c => !hidden[c.id])
    .map(c => (pending[c.id] ? { ...c, status: pending[c.id] } : c));
  const projOf = c => defs.find(p => p.key === c.project) || null;
  const shown = filter ? all.filter(c => c.project === filter) : all;
  const counts = Object.fromEntries(ORDER.map(k => [k, shown.filter(c => c.status === k).length]));
  const items = sortByOrder(shown.filter(c => c.status === tab), order);
  const cur = COLS.find(c => c.key === tab);
  const open = shown.filter(c => c.status !== 'done');
  const overdue = open.filter(c => (dueInfo(c.due, c.hasTime) || {}).overdue).length;
  const dueToday = open.filter(c => (dueInfo(c.due, c.hasTime) || {}).today).length;
  const usedProjects = defs.filter(p => all.some(c => c.project === p.key));
  const filterProj = filter && defs.find(p => p.key === filter);
  const menuCard = menu && all.find(c => c.id === menu.id);
  const detailCard = detail && all.find(c => c.id === detail);
  const onHead = startWindowDrag(dispatch, mini);

  const openMenu = (e, id, kind) => {
    e.preventDefault(); e.stopPropagation();
    const boxR = e.currentTarget.closest('[data-kanban]').getBoundingClientRect();
    const anchor = e.currentTarget.closest('[data-anchor], [data-row]') || e.currentTarget;
    const r = anchor.getBoundingClientRect();
    const m = r.bottom + 300 > window.innerHeight
      ? { bottom: boxR.bottom - r.top + 2 } : { top: r.bottom - boxR.top + 2 };
    dispatch({ type: 'MENU', menu: { id, kind, ...m } });
  };

  if (mini) {
    return (
      <div data-kanban className={`${box} mini`} style={{ left: pos.x, top: pos.y }}
        onMouseDown={onHead} title="Click the number to expand · drag to move">
        <div className={miniCls}>
          <span className="n" data-toggle style={overdue ? { color: 'var(--red)' } : {}}>{open.length}</span>
          <span className="l">{filterProj ? filterProj.label : 'Tasks'}</span>
          {counts.doing > 0 && <span className="c" style={{ color: 'var(--orange)' }}><i style={{ background: 'var(--orange)' }} />{counts.doing} doing</span>}
          {overdue > 0 && <span className="c" style={{ color: 'var(--red)' }}>{overdue} late</span>}
          {dueToday > 0 && <span className="c" style={{ color: 'var(--orange)' }}>{dueToday} today</span>}
        </div>
      </div>
    );
  }

  const tabIndex = ORDER.indexOf(tab);
  const empty = filterProj
    ? { main: `No ${filterProj.label} tasks here`, sub: 'Click the dot again to show everything' }
    : EMPTY[tab];
  const view = tab + (filter || '');

  return (
    <div data-kanban className={box} style={{ left: pos.x, top: pos.y }}
      onWheel={menu ? undefined : onSwipe(dispatch, tab, !!detailCard)}>
      <div className={head} onMouseDown={onHead}>
        <div>
          <div className={bigNum} data-toggle title="Click for mini mode · drag to move"
            style={overdue && tab !== 'done' ? { color: 'var(--red)' } : {}}>{counts[tab]}</div>
          <div className={headTitle}>
            <span style={{ color: cur.color }}>{cur.label}</span>
            {filterProj && <span className="proj" style={{ color: filterProj.color }}>{filterProj.label}</span>}
            {overdue > 0 && <span className="sum" style={{ color: 'var(--red)' }}>{overdue} overdue</span>}
            {dueToday > 0 && <span className="sum" style={{ color: 'var(--orange)' }}>{dueToday} today</span>}
          </div>
        </div>
        <div className={headRight}>
          {usedProjects.length > 1 && (
            <div className={`${dots} ${filter ? 'filtering' : ''}`} data-nodrag>
              {usedProjects.map(p => (
                <span key={p.key} className={filter === p.key ? 'on' : ''} title={p.label}
                  style={{ background: p.color, color: p.color }}
                  onClick={() => dispatch({ type: 'FILTER', filter: p.key })} />
              ))}
            </div>
          )}
          <button className={`${roundBtn} ${adding ? 'open' : ''}`} title="Add task"
            onClick={() => dispatch({ type: 'ADDING', on: !adding })}><Icon.plus /></button>
        </div>
      </div>

      {detailCard ? (
        <Detail card={{ ...detailCard }} dispatch={dispatch} defs={defs} descEdit={descEdit} openMenu={openMenu} />
      ) : (
        <div>
          <div className={tabs}>
            <div className="slider" style={{ left: `calc(3px + ${tabIndex} * (100% - 6px) / 3)` }} />
            {COLS.map(c => (
              <div key={c.key}
                className={`${tabCls} ${tab === c.key ? 'on' : ''}`}
                onClick={() => dispatch({ type: 'TAB', tab: c.key })}
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
                onDragLeave={e => e.currentTarget.classList.remove('over')}
                onDrop={e => {
                  e.preventDefault(); e.currentTarget.classList.remove('over');
                  const card = all.find(x => x.id === e.dataTransfer.getData('text/plain'));
                  if (card) doMove(dispatch, card, c.key);
                }}>
                <span className={tabDot} style={{ background: c.color }} />
                {c.label} <span className="n">{counts[c.key]}</span>
              </div>
            ))}
          </div>

          {adding && (
            <input className={inputCls} autoFocus placeholder='Try "Call bank tomorrow 3pm" · end with ! for Doing'
              onKeyDown={e => {
                if (e.key === 'Escape') dispatch({ type: 'ADDING', on: false });
                if (e.key === 'Enter' && e.target.value.trim()) add(dispatch, e.target.value.trim());
              }} />
          )}

          <div className={[listCls, slide && slide.view === view && (slide.dir > 0 ? 'from-right' : 'from-left')].filter(Boolean).join(' ')}
            key={view} ref={flipRef(view)} data-list>
            {error && <div className={emptyCls}><div className="main">Can’t reach Reminders</div>
              <div className="sub">Run the installer again, or check System Settings → Privacy → Reminders</div></div>}
            {!error && !loaded && <div className={emptyCls}><div className="sub">Loading…</div></div>}
            {!error && loaded && items.length === 0 && (
              <div className={emptyCls}>
                {empty.icon && <div className="icon">{empty.icon}</div>}
                <div className="main">{empty.main}</div>
                <div className="sub">{empty.sub}</div>
              </div>
            )}
            {items.map(c => {
              const i = ORDER.indexOf(c.status);
              const tmp = c.id.startsWith('tmp-');
              const isDone = c.status === 'done';
              const isCompleting = !!completing[c.id];
              const due = !isDone && !isCompleting && dueInfo(c.due, c.hasTime);
              const proj = projOf(c);
              const cls = [row, isDone && 'done', isCompleting && 'completing', leaving[c.id] && 'leaving',
                           menu && menu.id === c.id && 'menuOpen'].filter(Boolean).join(' ');
              return (
                <div key={c.id} data-row data-id={c.id} className={cls}
                  draggable={!tmp}
                  onContextMenu={e => !tmp && openMenu(e, c.id, 'ctx')}
                  onDragStart={e => {
                    e.dataTransfer.setData('text/plain', c.id);
                    e.dataTransfer.effectAllowed = 'move';
                    const el = e.currentTarget; setTimeout(() => el.classList.add('dragging'), 0);
                  }}
                  onDragEnd={e => e.currentTarget.classList.remove('dragging')}
                  onDragOver={e => {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > r.top + r.height / 2;
                    e.currentTarget.classList.toggle('below', after);
                    e.currentTarget.classList.toggle('above', !after);
                  }}
                  onDragLeave={e => clearMarks(e.currentTarget)}
                  onDrop={e => {
                    e.preventDefault();
                    const after = e.currentTarget.classList.contains('below');
                    clearMarks(e.currentTarget);
                    reorder(dispatch, all, order, e.dataTransfer.getData('text/plain'), c.id, after);
                  }}
                  title={c.notes ? `${c.title}\n\n${c.notes}` : c.title}>
                  {proj && <span className="bar" style={{ background: proj.color }} />}
                  <div className={[circle, c.status === 'doing' && 'doing', (isDone || isCompleting) && 'checked',
                                   isCompleting && 'pop'].filter(Boolean).join(' ')}
                    title={isDone ? 'Reopen' : isCompleting ? 'Undo' : 'Complete'}
                    onClick={() => {
                      if (tmp) return;
                      if (isDone) doMove(dispatch, c, 'todo', { text: 'Reopened' });
                      else complete(dispatch, c, completing);
                    }}>
                    {(isDone || isCompleting) && <Icon.tick />}
                  </div>
                  <div className="t" onClick={() => !tmp && !isCompleting && dispatch({ type: 'DETAIL', id: c.id })}>
                    <span className="title">{c.title}</span>
                    {c.url && <span className="mark"><Icon.link size={10} /></span>}
                    {c.notes && <span className="mark"><Icon.note /></span>}
                    {due && <span className={dueCls} style={{ color: due.color }}>{due.text}</span>}
                  </div>
                  {!tmp && !isCompleting && (
                    <div className={`${actions} actions`}>
                      {!isDone && <button title="Set deadline" onClick={e => openMenu(e, c.id, 'due')}><Icon.clock /></button>}
                      {i > 0 && <button onClick={() => doMove(dispatch, c, ORDER[i - 1])}
                        title={`Move to ${COLS[i - 1].label}`}><Icon.left /></button>}
                      {i < 2 && <button onClick={() => doMove(dispatch, c, ORDER[i + 1])}
                        title={`Move to ${COLS[i + 1].label}`}><Icon.right /></button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {toast && (
        <div className={toastCls} key={toast.token}>
          {toast.text}
          {toast.undo && <button onClick={() => undo(dispatch, toast.undo)}>Undo</button>}
        </div>
      )}

      {menuCard && (
        <div>
          <div className={scrim} onMouseDown={() => dispatch({ type: 'MENU', menu: null })}
            onContextMenu={e => { e.preventDefault(); dispatch({ type: 'MENU', menu: null }); }} />
          <div className={menuCls}
            style={menu.bottom != null ? { bottom: menu.bottom } : { top: menu.top != null ? menu.top : 150 }}
            onMouseDown={e => e.stopPropagation()}>
            {menu.kind === 'ctx' && <ContextMenu card={menuCard} dispatch={dispatch} defs={defs} />}
            {menu.kind === 'due' && <DueMenu card={menuCard} dispatch={dispatch} />}
            {menu.kind === 'proj' && <ProjectMenu card={menuCard} dispatch={dispatch} defs={defs} />}
          </div>
        </div>
      )}
    </div>
  );
};
