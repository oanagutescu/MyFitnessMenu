'use strict';

const MEALS = {
  normal: [['breakfast', 'Breakfast'], ['snack', 'Snack'], ['lunch', 'Lunch'], ['dinner', 'Dinner']],
  vegan: [['breakfast', 'Breakfast'], ['snack', 'Snack'], ['lunch', 'Lunch'], ['dinner', 'Dinner']],
  fasting: [['meal1', 'Meal 1'], ['meal2', 'Meal 2'], ['snack', 'Snack']]
};
// Label detection (English, Dutch, Romanian)
const END = '(?![\\p{L}\\d])';
const LABELS = [
  ['breakfast', new RegExp('^(breakfast|ontbijt|mic dejun)' + END, 'iu')],
  ['lunch', new RegExp('^(lunch|lunchen|pranz|prânz)' + END, 'iu')],
  ['dinner', new RegExp('^(dinner|diner|cina|cină)' + END, 'iu')],
  ['snack', new RegExp('^(snack|snacks|tussendoortje|tussendoor|gustare)' + END, 'iu')],
  ['meal1', new RegExp('^(meal|maaltijd|masa|masă)\\s*(1|one|een|i)' + END, 'iu')],
  ['meal2', new RegExp('^(meal|maaltijd|masa|masă)\\s*(2|two|twee|ii)' + END, 'iu')]
];
const LABEL_GLUED = /([.!?:;)])(?=(MIC DEJUN|GUSTARE|PRÂNZ|PRANZ|CINĂ|CINA|BREAKFAST|LUNCH|DINNER|SNACK)\b)/g;
const STOP_RE = /^(lista de cump|shopping list|boodschappenlijst)/i;
const NOISE_RE = /^(balance|\d+\s*kcal\S*|zi\s+vegan\S*|menu\s.*fastin\S*|z[iuwl][a-z0-9]{1,2}\s?[a-z0-9]?)$/i;
const DAY_RE = /^(day|dag|ziua|zi)\s*\d+/i;

const state = { cat: 'normal', scope: 'day', days: [] };
const MEAL_NAMES = { breakfast: 'Breakfast', meal1: 'Meal 1', snack: 'Snack', lunch: 'Lunch', meal2: 'Meal 2', dinner: 'Dinner' };
function mealDefs() {
  const days = state.days.filter(d => d.category === state.cat);
  const keys = Object.keys(MEAL_NAMES).filter(k => days.some(d => d.meals[k] !== undefined));
  return keys.length ? keys.map(k => [k, MEAL_NAMES[k]]) : MEALS[state.cat];
}
const $ = s => document.querySelector(s);
const expanded = new Set();
const filters = {};

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('fitmenu', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('days', { keyPath: 'id', autoIncrement: true }).createIndex('category', 'category');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(fn, mode = 'readonly') {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('days', mode);
    const out = fn(t.objectStore('days'));
    t.oncomplete = () => res(out && out.result);
    t.onerror = () => rej(t.error);
  });
}
const getAll = () => tx(s => s.getAll());
async function saveDays(cat, days) {
  const d = await db();
  const batch = Date.now();
  await new Promise((res, rej) => {
    const t = d.transaction('days', 'readwrite');
    const s = t.objectStore('days');
    days.forEach(x => s.add({ category: cat, order: x.order, label: x.label, meals: x.meals, added: batch }));
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

async function deleteDay(id) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction('days', 'readwrite');
    t.objectStore('days').delete(id);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
function parseMenu(text) {
  const lines = text.replace(LABEL_GLUED, '$1\n').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const days = [];
  let day = null, meal = null;
  const start = label => { day = { label, meals: {} }; days.push(day); meal = null; };
  for (const line of lines) {
    const clean = line.replace(/^[\W_]+/u, '');
    if (STOP_RE.test(clean)) break;
    if (NOISE_RE.test(clean)) continue;
    if (DAY_RE.test(clean) && clean.length < 40) { start(clean); continue; }
    const hit = LABELS.find(l => l[1].test(clean));
    if (hit) {
      if (!day || day.meals[hit[0]] !== undefined) start('');
      meal = hit[0];
      day.meals[meal] = clean.replace(hit[1], '').replace(/^[\s:\-–]+/, '');
    } else if (day && meal) {
      day.meals[meal] += (day.meals[meal] ? '\n' : '') + line;
    }
  }
  return days.filter(d => Object.keys(d.meals).length)
    .map((d, i) => ({ ...d, order: i, label: d.label || 'Day ' + (i + 1) }));
}

/* ---------- Rendering ---------- */
const norm = s => Array.from(s).map(c => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).join('').toLowerCase();
const terms = v => v.split(/[,;]/).map(s => norm(s.trim())).filter(Boolean);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function hl(text, inc) {
  const n = norm(text);
  const ranges = [];
  inc.forEach(t => {
    for (let i = n.indexOf(t); i >= 0; i = n.indexOf(t, i + t.length)) ranges.push([i, i + t.length]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + esc(text.slice(pos));
}
function buildScope() {
  const opts = [['day', 'Whole day'], ...mealDefs()];
  if (!opts.some(o => o[0] === state.scope)) state.scope = 'day';
  $('#scope').innerHTML = opts.map(([k, l]) => `<button class="chip ${k === state.scope ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
}
function render() {
  const inc = terms($('#inc').value), exc = terms($('#exc').value);
  const defs = mealDefs();
  const days = state.days.filter(d => d.category === state.cat)
    .sort((a, b) => a.added - b.added || a.order - b.order);
  const has = (txt, ts) => ts.some(t => norm(txt || '').includes(t));
  const all = d => defs.map(([k]) => d.meals[k] || '').join(' ');
  const scopeKeys = state.scope === 'day' ? defs.map(d => d[0]) : [state.scope];
  const scoped = d => scopeKeys.map(k => d.meals[k] || '').join(' ');
  let list = days.filter(d => {
    if (!inc.every(t => norm(scoped(d)).includes(t))) return false;
    if (exc.length && has(state.scope === 'day' ? all(d) : scoped(d), exc)) return false;
    return true;
  });
  $('#count').textContent = `${list.length} of ${days.length} days`;
  if (!days.length) { $('#results').innerHTML = '<div class="empty">No menu yet.<br>Tap “＋ Add menu” to import one 📄</div>'; return; }
  if (!list.length) { $('#results').innerHTML = '<div class="empty">Nothing matches 🤷</div>'; return; }
  $('#results').innerHTML = list.map(d => {
    const shown = state.scope === 'day' ? defs : defs.filter(([k]) => k === state.scope);
    return `<article class="day${expanded.has(d.id) ? ' open' : ''}"><div class="dayHead"><button class="del tog" data-tog="${d.id}" title="Expand / collapse">▸</button><h3 data-tog="${d.id}">${esc(d.label)}</h3><button class="del" data-edit="${d.id}" title="Edit day">✏️</button><button class="del" data-del="${d.id}" title="Delete day">🗑️</button></div>${shown.map(([k, l]) =>
      d.meals[k] ? `<div class="meal"><b>${l}</b>${hl(d.meals[k], inc)}</div>` : '').join('')}</article>`;
  }).join('');
  if (inc.length || exc.length) $('#results').querySelectorAll('.day').forEach(a => a.classList.add('open'));
}
async function reload() { state.days = await getAll(); buildScope(); render(); }
let editing = null;
function openEdit(id) {
  editing = state.days.find(d => d.id === id);
  if (!editing) return;
  $('#edName').value = editing.label;
  $('#edMeals').innerHTML = mealDefs().map(([k, l]) =>
    `<div><label for="ed_${k}">${l}</label><textarea id="ed_${k}" data-k="${k}" rows="7"></textarea></div>`).join('');
  document.querySelectorAll('#edMeals textarea').forEach(t => { t.value = editing.meals[t.dataset.k] || ''; });
  $('#editDlg').showModal();
}
$('#edCancel').onclick = () => { editing = null; $('#editDlg').close(); };
$('#edSave').onclick = async () => {
  if (!editing) return;
  const meals = {};
  document.querySelectorAll('#edMeals textarea').forEach(t => { if (t.value.trim()) meals[t.dataset.k] = t.value.trim(); });
  const day = { ...editing, label: $('#edName').value.trim() || editing.label, meals };
  editing = null;
  $('#editDlg').close();
  await saveDay(day);
  await reload(); toast('Day updated ✅');
};
async function saveDay(day) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction('days', 'readwrite');
    t.objectStore('days').put(day);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
$('#results').onclick = async e => {
  const tog = Number(e.target.dataset.tog);
  if (tog) {
    expanded.has(tog) ? expanded.delete(tog) : expanded.add(tog);
    e.target.closest('.day').classList.toggle('open');
    return;
  }
  const editId = Number(e.target.dataset.edit);
  if (editId) return openEdit(editId);
  const id = Number(e.target.dataset.del);
  if (!id || !confirm('Delete this day?')) return;
  await deleteDay(id);
  await reload(); toast('Day deleted');
};
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }

/* ---------- Events ---------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  filters[state.cat] = { inc: $('#inc').value, exc: $('#exc').value, scope: state.scope };
  state.cat = b.dataset.cat;
  const f = filters[state.cat] || { inc: '', exc: '', scope: 'day' };
  $('#inc').value = f.inc; $('#exc').value = f.exc; state.scope = f.scope;
  buildScope(); render();
});
$('#scope').onclick = e => { const k = e.target.dataset.k; if (k) { state.scope = k; buildScope(); render(); } };
$('#inc').oninput = $('#exc').oninput = render;
$('#clear').onclick = () => { $('#inc').value = $('#exc').value = ''; render(); };

let pending = [];
let nameTouched = false;
function updatePreview() {
  const text = $('#pvText').value;
  if (!nameTouched) {
    const m = text.match(/^\s*([^\n]+)\n\s*(\d+\s*kcal)/i);
    $('#pvName').value = m ? `${m[1].trim()} ${m[2].replace(/\s+/g, '')}` : '';
  }
  const name = $('#pvName').value.trim();
  pending = parseMenu(text).map(d => ({ ...d, label: name ? `${name} \u00b7 ${d.label}` : d.label }));
  $('#pvInfo').textContent = pending.length ? `Found ${pending.length} day(s).` : 'No days recognized yet.';
  $('#pvDays').innerHTML = pending.map(d => `<p><b>${esc(d.label)}</b><br>${Object.keys(d.meals).join(', ')}</p>`).join('');
  $('#pvSave').disabled = !pending.length;
}
$('#uploadBtn').onclick = () => {
  $('#pvText').value = '';
  $('#pvName').value = '';
  nameTouched = false;
  $('#pvCat').value = state.cat;
  updatePreview();
  $('#preview').showModal();
};
$('#pvText').oninput = updatePreview;
$('#pvName').oninput = () => { nameTouched = true; updatePreview(); };
$('#preview').onclose = async () => {
  if ($('#preview').returnValue !== 'ok') return;
  const cat = $('#pvCat').value;
  await saveDays(cat, pending);
  document.querySelector(`#tabs [data-cat="${cat}"]`).click();
  await reload(); toast('Menu saved ✅');
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
buildScope();
reload();