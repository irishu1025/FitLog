import * as db from './db.js';
import * as cloud from './cloud.js';
import * as C from './calc.js';
import * as AI from './ai.js';
import { lineChart, barChart, ring } from './charts.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n0 = (v) => Math.round(+v || 0);
const n1 = (v) => Math.round((+v || 0) * 10) / 10;
const fmt = (v) => n0(v).toLocaleString('en-US');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULT = {
  version: 1,
  profile: { sex: '', age: null, heightCm: null, weightKg: null, activity: 1.375, goalWeightKg: null, rate: 0.5 },
  goals: { custom: false, kcal: 2000, protein: 120, carbs: 220, fat: 65, activeDays: 4, weeklyMinutes: 150, eatBack: 0 },
  settings: { provider: 'gemini', apiKey: '', model: '', models: [], claudeKey: '', claudeModel: AI.DEFAULT_CLAUDE_MODEL, autoFallback: true },
  meals: [],
  workouts: [],
  weights: [],
  days: {},
};

let S;
const ui = { tab: 'today', date: C.today(), followToday: true, user: null, syncing: false };

// ---------- persistence ----------
let saveTimer;
// Signed in: changes go to Firestore (which caches offline). Signed out: this device's IndexedDB.
function save() {
  if (ui.user) return cloud.push(S);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
}
function flush() {
  clearTimeout(saveTimer);
  if (ui.user) return cloud.pushNow();
  return db.kvSet('state', S).catch((e) => toast('Save failed: ' + e.message));
}
function hydrateState(saved) {
  const d = clone(DEFAULT);
  if (!saved) return d;
  const goals = { ...d.goals, ...saved.goals };
  if (saved.goals?.workoutsPerWeek && saved.goals.activeDays == null) goals.activeDays = saved.goals.workoutsPerWeek; // v1 → days
  delete goals.workoutsPerWeek;
  return {
    ...d, ...saved,
    profile: { ...d.profile, ...saved.profile },
    goals,
    settings: { ...d.settings, ...saved.settings },
  };
}

const photoCache = new Map();
async function getPhoto(id) {
  if (!photoCache.has(id)) {
    let src = await db.photoGet(id).catch(() => '');
    if (!src && ui.user) {
      src = await cloud.photoGet(id);
      if (src) db.photoSet(id, src).catch(() => {});
    }
    photoCache.set(id, src || '');
  }
  return photoCache.get(id);
}
async function savePhoto(id, src) {
  await db.photoSet(id, src);
  photoCache.set(id, src);
  cloud.photoSet(id, src);
}
function deletePhoto(id) {
  db.photoDel(id).catch(() => {});
  photoCache.delete(id);
  cloud.photoDel(id);
}
function hydratePhotos(root) {
  $$('img[data-photo]', root).forEach(async (img) => {
    const src = await getPhoto(img.dataset.photo);
    if (src) img.src = src; else img.remove();
  });
}

// ---------- derived data ----------
function curWeight() {
  if (!S.weights.length) return S.profile.weightKg;
  return [...S.weights].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1).kg;
}
function sortedWeights() { return [...S.weights].sort((a, b) => (a.date < b.date ? -1 : 1)); }
function targets() {
  const calc = C.calcGoals(S.profile, curWeight());
  const g = S.goals;
  const base = g.custom || !calc ? g : calc;
  return { kcal: base.kcal, protein: base.protein, carbs: base.carbs, fat: base.fat, calc, activeDays: g.activeDays, weeklyMinutes: g.weeklyMinutes, eatBack: g.eatBack };
}
const mealsOn = (d) => S.meals.filter((m) => m.date === d).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const workoutsOn = (d) => S.workouts.filter((w) => w.date === d);
function dayTotals(d) {
  const meals = mealsOn(d);
  const t = C.sumItems(meals.flatMap((m) => m.items));
  t.burn = workoutsOn(d).reduce((s, w) => s + (+w.kcal || 0), 0);
  t.meals = meals.length;
  return t;
}
function markDirty(date) { if (S.days[date]?.closed) S.days[date].stale = true; }
// Workout goals are counted in active days (any workout that day) and total minutes per Mon–Sun week.
function weekStats(ws) {
  const we = C.addDays(ws, 6);
  const list = S.workouts.filter((w) => w.date >= ws && w.date <= we);
  return { days: new Set(list.map((w) => w.date)).size, minutes: list.reduce((s, w) => s + (+w.minutes || 0), 0), kcal: list.reduce((s, w) => s + (+w.kcal || 0), 0) };
}
function weekMet(ws) {
  const x = weekStats(ws);
  return x.days >= (S.goals.activeDays || 1) && x.minutes >= (S.goals.weeklyMinutes || 0);
}
function workoutWeekStreak() {
  let ws = C.weekStart(C.today()), n = weekMet(ws) ? 1 : 0;
  ws = C.addDays(ws, -7);
  while (weekMet(ws)) { n++; ws = C.addDays(ws, -7); }
  return n;
}
// A food-log day is "complete" once the user has tapped Done and received the day review.
const isReviewed = (d) => !!S.days[d]?.closed;
function logStreak() {
  let d = C.today(), n = 0;
  if (!isReviewed(d)) d = C.addDays(d, -1);
  while (isReviewed(d)) { n++; d = C.addDays(d, -1); }
  return n;
}
const GEAR = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
const gearBtn = () => `<button class="icon-btn gear" data-act="open-settings" aria-label="Settings">${GEAR}</button>`;

// 16-week calendar grid (Monday rows on top); cls(date) returns the cell's CSS class.
function heatGrid(cls, weeks = 16) {
  const today = C.today(), start = C.addDays(C.weekStart(today), -7 * (weeks - 1));
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = C.addDays(start, i);
    cells += `<i class="${d > today ? 'future' : cls(d)}${d === today ? ' today' : ''}" title="${d}"></i>`;
  }
  return `<div class="heat">${cells}</div>`;
}
function dateLabel(d) {
  const diff = C.daysBetween(d, C.today());
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return C.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------- UI primitives ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openSheet({ persistent = false } = {}) {
  const root = $('#sheet-root');
  root.innerHTML = '<div class="backdrop"></div><div class="sheet"></div>';
  root.classList.add('open');
  document.documentElement.classList.add('locked');
  if (!persistent) root.querySelector('.backdrop').onclick = closeSheet;
  return root.querySelector('.sheet');
}
function closeSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
  document.documentElement.classList.remove('locked');
}
const spinner = '<span class="spinner"></span>';

// ---------- render ----------
function render() {
  if (ui.followToday) ui.date = C.today();
  const v = $('#view');
  v.innerHTML = ui.syncing ? `<div class="boot">${spinner}<div style="margin-top:10px">Syncing your account…</div></div>` : VIEWS[ui.tab]();
  hydratePhotos(v);
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

const VIEWS = { today: viewToday, activity: viewActivity, progress: viewProgress, settings: viewSettings };

// ===== Today =====
function viewToday() {
  const d = ui.date, t = targets(), tot = dayTotals(d), day = S.days[d];
  const budget = t.kcal + Math.round((tot.burn * (t.eatBack || 0)) / 100);
  const left = budget - tot.kcal;
  const isToday = d >= C.today();
  const setup = !t.calc && !S.goals.custom
    ? `<button class="card tight row" data-act="open-settings" style="width:100%;text-align:left">
         <div class="grow"><h3>Set up your profile</h3><div class="muted sm">Get a science-based calorie goal (Mifflin-St Jeor) and progress forecast.</div></div><span class="muted">›</span></button>` : '';
  const keyHint = !S.settings.apiKey && !S.settings.claudeKey
    ? `<button class="card tight row" data-act="open-settings" style="width:100%;text-align:left">
         <div class="grow"><h3>Add an AI key</h3><div class="muted sm">Free Gemini or paid Claude, for photo analysis and daily reviews.</div></div><span class="muted">›</span></button>` : '';

  const macro = (key, label, color) => {
    const v = tot[key], goal = t[key] || 1;
    return `<div class="macro"><div class="row between sm"><span><i class="dot-i" style="background:${color}"></i>${label}</span></div>
      <div class="bar"><i style="width:${Math.min(100, (v / goal) * 100)}%;background:${color}"></i></div>
      <div class="xs muted num">${n0(v)} / ${n0(goal)} g</div></div>`;
  };

  const meals = C.MEAL_TYPES.map((mt) => {
    const list = mealsOn(d).filter((m) => m.type === mt.key);
    const kcal = list.reduce((s, m) => s + C.sumItems(m.items).kcal, 0);
    return `<section class="card">
      <div class="sec-head"><h3>${mt.label}</h3><span class="muted sm num">${list.length ? fmt(kcal) + ' kcal' : ''}</span>
        <button class="icon-btn" data-act="add-meal" data-type="${mt.key}" aria-label="Add ${mt.label}">+</button></div>
      ${list.length ? `<div class="entries">${list.map(entryHtml).join('')}</div>` : ''}
    </section>`;
  }).join('');

  const wos = workoutsOn(d);
  const workouts = `<section class="card">
    <div class="sec-head"><h3>Workouts</h3><span class="muted sm num">${wos.length ? '−' + fmt(tot.burn) + ' kcal' : ''}</span>
      <button class="icon-btn" data-act="add-workout" aria-label="Add workout">+</button></div>
    ${wos.length ? `<div class="entries">${wos.map((w) => `<button class="entry" data-act="edit-workout" data-id="${w.id}">
        <div class="badge">${n0(w.minutes)}′</div><div class="grow"><div class="entry-title">${esc(w.name)}</div>
        <div class="muted xs">${esc(w.intensity || '')}${w.note ? ' · ' + esc(w.note) : ''}</div></div>
        <div class="entry-kcal" style="color:var(--burn)">${fmt(w.kcal)}</div></button>`).join('')}</div>` : ''}
  </section>`;

  let reviewBlock;
  if (day?.closed && day.review) {
    reviewBlock = `${reviewCard(day.review, day.stale)}
      <div class="grid2"><button class="btn" data-act="reopen-day">Reopen day</button>
      <button class="btn" data-act="finish-day">${day.stale ? 'Update review' : 'Regenerate'}</button></div>`;
  } else {
    reviewBlock = `<button class="btn primary block" data-act="finish-day" ${tot.meals ? '' : 'disabled'}>Done for ${isToday ? 'today' : 'this day'} · get review</button>`;
  }

  const signHint = cloud.enabled && !ui.user && !hasData(S)
    ? `<button class="card tight row" data-act="open-settings" style="width:100%;text-align:left">
         <div class="grow"><h3>Sign in with Google</h3><div class="muted sm">Sync your log across iPhone, Safari and other devices.</div></div><span class="muted">›</span></button>` : '';
  return `
    <div class="appbar"><span class="brand">FitLog</span>${gearBtn()}</div>
    <header class="top">
      <button class="icon-btn plain" data-act="prev-day" aria-label="Previous day">‹</button>
      <label class="date-pick"><span class="date-label">${dateLabel(d)}</span>
        <span class="muted xs">${C.fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        <input type="date" data-change="pick-date" value="${d}" max="${C.today()}"></label>
      <button class="icon-btn plain" data-act="next-day" ${isToday ? 'disabled' : ''} aria-label="Next day">›</button>
    </header>
    ${signHint}${setup}${keyHint}
    <section class="card">
      <div class="summary">
        <div class="ring-wrap">${ring({ value: tot.kcal, max: budget, over: left < 0 })}
          <div class="ring-center"><b class="num">${fmt(Math.abs(left))}</b><span class="muted xs">${left < 0 ? 'kcal over' : 'kcal left'}</span></div></div>
        <div class="stat-list">
          <div class="stat"><span class="muted sm">Goal</span><b>${fmt(t.kcal)}</b></div>
          <div class="stat"><span class="muted sm">Eaten</span><b>${fmt(tot.kcal)}</b></div>
          <div class="stat"><span class="muted sm">Burned</span><b style="color:var(--burn)">${tot.burn ? '−' : ''}${fmt(tot.burn)}</b></div>
          <div class="stat"><span class="muted sm">Net</span><b>${fmt(tot.kcal - tot.burn)}</b></div>
        </div>
      </div>
      <div class="macros">${macro('protein', 'Protein', 'var(--protein)')}${macro('carbs', 'Carbs', 'var(--carbs)')}${macro('fat', 'Fat', 'var(--fat)')}</div>
    </section>
    ${meals}
    ${workouts}
    ${reviewBlock}`;
}

function entryHtml(m) {
  const t = C.sumItems(m.items);
  const thumbs = m.photoIds?.length
    ? m.photoIds.slice(0, 3).map((id) => `<img data-photo="${id}" alt="">`).join('')
    : '<div class="thumb-ph">✎</div>';
  return `<button class="entry" data-act="edit-meal" data-id="${m.id}">
    <div class="thumbs">${thumbs}</div>
    <div class="grow"><div class="entry-title">${esc(m.items.map((i) => i.name).join(', ') || 'Meal')}</div>
      <div class="muted xs num">P ${n0(t.protein)} · C ${n0(t.carbs)} · F ${n0(t.fat)} g</div></div>
    <div class="entry-kcal">${fmt(t.kcal)}</div></button>`;
}

function reviewCard(r, stale) {
  const cls = r.score >= 7 ? '' : r.score >= 4 ? 'mid' : 'low';
  return `<section class="card review-card">
    <div class="row" style="align-items:flex-start"><div class="score ${cls}">${n0(r.score)}</div>
      <div class="grow"><h2>${esc(r.headline)}</h2>
      <div class="muted xs">${r.source === 'local' ? 'Offline summary' : 'AI review'}${stale ? ' · log changed since review' : ''}</div></div></div>
    <p style="margin:12px 0 0">${esc(r.summary)}</p>
    ${r.wins?.length ? `<div style="margin-top:12px"><div class="label">Wins</div><ul class="bullets">${r.wins.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${r.improvements?.length ? `<div style="margin-top:12px"><div class="label">Improve</div><ul class="bullets">${r.improvements.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${r.tomorrow ? `<div class="ai-note" style="margin-top:12px"><b style="color:var(--text)">Tomorrow:</b> ${esc(r.tomorrow)}</div>` : ''}
  </section>`;
}

// ===== Activity =====
function viewActivity() {
  const t = targets(), today = C.today(), ws = C.weekStart(today);
  const wk = weekStats(ws);
  const mins = {};
  for (const w of S.workouts) mins[w.date] = (mins[w.date] || 0) + (+w.minutes || 0);
  const mealDays = new Set(S.meals.map((m) => m.date));
  const reviewedThisWeek = Array.from({ length: 7 }, (_, i) => C.addDays(ws, i)).filter(isReviewed).length;
  const activeAll = Object.keys(mins).length;
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = C.addDays(ws, i);
    return `<div class="wd${mins[d] ? ' on' : ''}${d === today ? ' now' : ''}${d > today ? ' future' : ''}"><i></i><span>${'MTWTFSS'[i]}</span></div>`;
  }).join('');
  const minPct = Math.min(100, (wk.minutes / (t.weeklyMinutes || 1)) * 100);

  const recent = [...S.workouts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0))).slice(0, 30);

  return `
    <header class="row between"><h1>Activity</h1><div class="row"><button class="btn primary sm" data-act="add-workout" data-today="1">+ Log workout</button>${gearBtn()}</div></header>
    <section class="card">
      <div class="card-title"><span class="label">This week</span>${weekMet(ws) ? '<span class="pill ok">Goal met</span>' : ''}</div>
      <div class="row between sm"><span>Active days</span><b class="num">${wk.days} / ${t.activeDays}</b></div>
      <div class="week-days">${week}</div>
      <div class="row between sm" style="margin-top:14px"><span>Minutes</span><b class="num">${fmt(wk.minutes)} / ${fmt(t.weeklyMinutes)}</b></div>
      <div class="progress-bar" style="margin-top:6px"><i style="width:${minPct}%"></i></div>
      <div class="row between xs muted" style="margin-top:8px"><span>${fmt(wk.kcal)} kcal burned</span><span>${reviewedThisWeek}/7 food days reviewed</span></div>
    </section>
    <div class="big-stats">
      <div class="card"><b>${workoutWeekStreak()}</b><span class="muted xs">week streak<br>(goal met)</span></div>
      <div class="card"><b style="color:var(--carbs)">${logStreak()}</b><span class="muted xs">day food-<br>log streak</span></div>
      <div class="card"><b>${activeAll}</b><span class="muted xs">total<br>active days</span></div>
    </div>
    <section class="card">
      <div class="card-title"><span class="label">Workouts · 16 weeks</span><span class="xs faint">Mon → Sun ↓</span></div>
      ${heatGrid((d) => { const m = mins[d] || 0; return m >= 60 ? 'l3' : m >= 30 ? 'l2' : m > 0 ? 'l1' : ''; })}
      <div class="legend"><span><i class="dot-i" style="background:var(--surface-2)"></i>rest</span><span><i class="dot-i" style="background:rgba(74,222,128,.35)"></i>&lt;30 min</span>
        <span><i class="dot-i" style="background:rgba(74,222,128,.65)"></i>30–59</span><span><i class="dot-i" style="background:var(--accent)"></i>60+</span></div>
    </section>
    <section class="card">
      <div class="card-title"><span class="label">Food log · 16 weeks</span><span class="xs faint">Mon → Sun ↓</span></div>
      ${heatGrid((d) => (isReviewed(d) ? 'food' : mealDays.has(d) ? 'food-part' : ''))}
      <div class="legend"><span><i class="dot-i" style="background:var(--surface-2)"></i>no log</span>
        <span><i class="dot-i" style="background:rgba(251,191,36,.28)"></i>logged, not reviewed</span><span><i class="dot-i" style="background:var(--carbs)"></i>complete (reviewed)</span></div>
    </section>
    <section class="card">
      <div class="card-title"><span class="label">Recent workouts</span></div>
      ${recent.length ? recent.map((w) => `<button class="list-row" data-act="edit-workout" data-id="${w.id}">
          <div class="badge">${n0(w.minutes)}′</div>
          <div class="grow"><div style="font-weight:600">${esc(w.name)}</div><div class="muted xs">${dateLabel(w.date)} · ${esc(w.intensity || '')}</div></div>
          <div class="num" style="color:var(--burn);font-weight:700">${fmt(w.kcal)}</div></button>`).join('')
        : '<div class="empty-hint">No workouts yet. Log your first one to start the streak.</div>'}
    </section>`;
}

// ===== Progress =====
function viewProgress() {
  const t = targets(), p = S.profile, cur = curWeight(), goal = +p.goalWeightKg || null;
  const ws = sortedWeights();
  const startW = ws.length ? ws[0].kg : cur;

  // goal progress
  let goalCard = `<section class="card"><div class="label">Goal</div><p class="muted sm" style="margin:6px 0 10px">Set your current and goal weight in Settings to see a forecast.</p>
    <button class="btn sm" data-act="open-settings">Open settings</button></section>`;
  if (cur && goal) {
    const total = Math.abs(startW - goal) || 1;
    const done = Math.max(0, Math.min(1, (Math.abs(startW - goal) - Math.abs(cur - goal)) / total));
    const proj = projections();
    const row = (label, r, sub) => `<div class="eta-row"><div><div style="font-weight:600">${label}</div><div class="muted xs">${sub}</div></div>
      <div style="text-align:right">${r ? `<b class="num">${C.fmtDate(r.date, { month: 'short', day: 'numeric', year: 'numeric' })}</b><div class="muted xs">${r.weeks < 1 ? '< 1 week' : '~' + Math.round(r.weeks) + ' weeks'}</div>` : '<span class="muted sm">—</span>'}</div></div>`;
    goalCard = `<section class="card">
      <div class="card-title"><span class="label">Goal</span><span class="sm muted num">${n1(cur)} → ${n1(goal)} kg</span></div>
      <div class="progress-bar"><i style="width:${done * 100}%"></i></div>
      <div class="row between xs muted" style="margin-top:6px"><span>Start ${n1(startW)} kg</span><span>${Math.round(done * 100)}% · ${n1(Math.abs(cur - goal))} kg to go</span></div>
      ${Math.abs(cur - goal) < 0.3 ? '<p style="margin:14px 0 0"><span class="pill ok">Goal reached</span> Consider switching to maintenance in Settings.</p>' : `
      <div class="label" style="margin:16px 0 10px">Estimated arrival</div>
      <div class="eta">
        ${row('Your plan', proj.plan, `${p.rate} kg/week target`)}
        ${row('Weight trend', proj.trend, proj.trendNote)}
        ${row('Logged calories', proj.cal, proj.calNote)}
      </div>`}
    </section>`;
  }

  // weight chart (last 120 days)
  const cutoff = C.addDays(C.today(), -120);
  const recentW = ws.filter((w) => w.date >= cutoff);
  const toX = (d) => C.parseYmd(d).getTime();
  const trend = C.ema(recentW);
  const weightChart = lineChart({
    series: recentW.map((w) => ({ x: toX(w.date), y: w.kg })),
    trend: trend.length > 2 ? trend.map((w) => ({ x: toX(w.date), y: w.kg })) : [],
    goal,
    xLabel: (x) => C.fmtDate(C.ymd(x)),
  });

  // 14-day calories
  const days = Array.from({ length: 14 }, (_, i) => C.addDays(C.today(), i - 13));
  const totals = days.map((d) => ({ d, ...dayTotals(d) }));
  const bars = totals.map((x) => ({ label: C.parseYmd(x.d).getDate(), value: x.kcal, burn: x.burn }));
  const logged = totals.filter((x) => x.meals > 0);
  const avg = (k) => (logged.length ? logged.reduce((s, x) => s + x[k], 0) / logged.length : 0);
  const onTarget = logged.filter((x) => Math.abs(x.kcal - t.kcal) <= t.kcal * 0.1).length;

  // history of closed days
  const reviewed = Object.entries(S.days).filter(([, v]) => v.closed && v.review).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 10);

  return `
    <header class="row between"><h1>Progress</h1><div class="row"><button class="btn primary sm" data-act="weigh-in">+ Weigh-in</button>${gearBtn()}</div></header>
    ${goalCard}
    <section class="card">
      <div class="card-title"><span class="label">Weight</span><span class="sm muted">${cur ? n1(cur) + ' kg' : ''}</span></div>
      ${weightChart}
      <div class="legend"><span><i class="dot-i" style="background:var(--text)"></i>weigh-ins</span><span><i class="dot-i" style="background:var(--accent)"></i>smoothed trend</span><span>- - goal</span></div>
      ${ws.length ? `<div style="margin-top:10px">${ws.slice(-4).reverse().map((w) => `<button class="list-row" data-act="weigh-in" data-date="${w.date}">
        <div class="grow">${dateLabel(w.date)}</div><b class="num">${n1(w.kg)} kg</b></button>`).join('')}</div>` : ''}
    </section>
    <section class="card">
      <div class="card-title"><span class="label">Calories · 14 days</span><span class="sm muted">goal ${fmt(t.kcal)}</span></div>
      ${barChart({ bars, target: t.kcal })}
      <div class="legend"><span><i class="dot-i" style="background:var(--accent)"></i>within ±10%</span><span><i class="dot-i" style="background:var(--danger)"></i>over</span>
        <span><i class="dot-i" style="background:var(--protein)"></i>well under</span><span><i class="dot-i" style="background:var(--burn)"></i>workout</span></div>
    </section>
    <div class="big-stats">
      <div class="card"><b>${fmt(avg('kcal'))}</b><span class="muted xs">avg kcal<br>(logged days)</span></div>
      <div class="card"><b>${n0(avg('protein'))}<small class="sm">g</small></b><span class="muted xs">avg protein<br>goal ${n0(t.protein)} g</span></div>
      <div class="card"><b>${onTarget}/${logged.length}</b><span class="muted xs">days on<br>target</span></div>
    </div>
    ${reviewed.length ? `<section class="card"><div class="card-title"><span class="label">Daily reviews</span></div>
      ${reviewed.map(([d, v]) => `<button class="list-row" data-act="goto-day" data-date="${d}">
        <div class="score ${v.review.score >= 7 ? '' : v.review.score >= 4 ? 'mid' : 'low'}" style="width:38px;height:38px;font-size:16px;border-radius:12px">${n0(v.review.score)}</div>
        <div class="grow"><div style="font-weight:600">${esc(v.review.headline)}</div><div class="muted xs">${dateLabel(d)} · ${fmt(dayTotals(d).kcal)} kcal</div></div><span class="muted">›</span></button>`).join('')}
    </section>` : ''}`;
}

function projections() {
  const p = S.profile, cur = curWeight(), goal = +p.goalWeightKg;
  const diff = goal - cur;
  const out = { plan: null, trend: null, cal: null, trendNote: 'Needs 3+ weigh-ins over 10+ days', calNote: 'Needs 5+ logged days in last 14' };
  const mk = (days) => (days > 0 && days < 365 * 5 ? { date: C.addDays(C.today(), Math.round(days)), weeks: days / 7 } : null);

  const rate = diff > 0 ? Math.min(p.rate || 0.25, 0.5) : p.rate || 0.5;
  out.plan = mk((Math.abs(diff) / rate) * 7);

  const since = C.addDays(C.today(), -42);
  const pts = sortedWeights().filter((w) => w.date >= since).map((w) => ({ x: C.daysBetween(since, w.date), y: w.kg }));
  if (pts.length >= 3 && pts.at(-1).x - pts[0].x >= 10) {
    const lr = C.linreg(pts);
    const perWeek = lr.slope * 7;
    out.trendNote = `${perWeek >= 0 ? '+' : ''}${Math.round(perWeek * 100) / 100} kg/week lately`;
    if (Math.sign(lr.slope) === Math.sign(diff) && Math.abs(lr.slope) > 0.003) out.trend = mk(diff / lr.slope);
    else out.trendNote += ' — not toward goal yet';
  }

  const calc = C.calcGoals(p, cur);
  const days = Array.from({ length: 14 }, (_, i) => C.addDays(C.today(), -i - 1)).map(dayTotals).filter((x) => x.meals > 0);
  if (calc && days.length >= 5) {
    const bal = days.reduce((s, x) => s + x.kcal - x.burn - calc.tdee, 0) / days.length;
    out.calNote = `${bal < 0 ? 'Deficit' : 'Surplus'} ~${fmt(Math.abs(bal))} kcal/day`;
    const perDay = bal / C.KCAL_PER_KG;
    if (Math.sign(perDay) === Math.sign(diff) && Math.abs(bal) > 50) out.cal = mk(diff / perDay);
    else out.calNote += ' — not toward goal';
  }
  return out;
}

// ===== Settings =====
function viewSettings() {
  const p = S.profile, g = S.goals, st = S.settings, cur = curWeight();
  const calc = C.calcGoals(p, cur);
  const num = (path, val, ph, step = 'any') => `<input type="number" inputmode="decimal" step="${step}" data-path="${path}" data-num value="${val ?? ''}" placeholder="${ph}">`;
  const models = [...new Set([st.model, ...(st.models || [])].filter(Boolean))];

  return `
    <header class="row"><button class="icon-btn plain" data-act="close-settings" aria-label="Back">‹</button><h1>Settings</h1></header>
    ${accountCard()}

    <section class="card stack">
      <div class="label">Profile</div>
      <div class="grid2">
        <label class="field"><span>Sex</span><select data-path="profile.sex"><option value="">Select</option>
          <option value="female" ${p.sex === 'female' ? 'selected' : ''}>Female</option><option value="male" ${p.sex === 'male' ? 'selected' : ''}>Male</option></select></label>
        <label class="field"><span>Age</span>${num('profile.age', p.age, 'years', '1')}</label>
        <label class="field"><span>Height (cm)</span>${num('profile.heightCm', p.heightCm, 'cm')}</label>
        <label class="field"><span>Current weight (kg)</span>${num('current-weight', cur, 'kg')}</label>
      </div>
      <label class="field"><span>Daily activity (excluding logged workouts)</span><select data-path="profile.activity" data-num>
        ${C.ACTIVITY_LEVELS.map((a) => `<option value="${a.v}" ${+p.activity === a.v ? 'selected' : ''}>${a.label} — ${a.desc}</option>`).join('')}</select></label>
      <div class="grid2">
        <label class="field"><span>Goal weight (kg)</span>${num('profile.goalWeightKg', p.goalWeightKg, 'kg')}</label>
        <label class="field"><span>Pace (kg/week)</span><select data-path="profile.rate" data-num>
          ${C.RATES.map((r) => `<option value="${r}" ${+p.rate === r ? 'selected' : ''}>${r}${r === 0.5 ? ' (recommended)' : r === 1 ? ' (aggressive)' : ''}</option>`).join('')}</select></label>
      </div>
    </section>

    <section class="card">
      <div class="card-title"><span class="label">Daily targets</span></div>
      ${calc ? `<div class="grid3 center" style="margin-bottom:12px">
          <div><div class="muted xs">BMR</div><b class="num">${fmt(calc.bmr)}</b></div>
          <div><div class="muted xs">Maintenance</div><b class="num">${fmt(calc.tdee)}</b></div>
          <div><div class="muted xs">Goal</div><b class="num" style="color:var(--accent)">${fmt(calc.kcal)}</b></div></div>
        <p class="muted sm" style="margin:0 0 12px">${calc.dir < 0 ? `Deficit of ~${fmt(calc.tdee - calc.kcal)} kcal/day ≈ ${n1(((calc.tdee - calc.kcal) * 7) / C.KCAL_PER_KG)} kg/week.` : calc.dir > 0 ? `Surplus of ~${fmt(calc.kcal - calc.tdee)} kcal/day for lean gain.` : 'Maintenance calories.'}
          Protein ${calc.protein} g · Carbs ${calc.carbs} g · Fat ${calc.fat} g. BMI ${n1(calc.bmi)}.
          ${calc.floored ? '<br><span class="pill warn">Raised to the safe minimum. Consider a slower pace.</span>' : ''}</p>`
        : '<p class="muted sm" style="margin:0 0 12px">Fill in sex, age, height and weight to calculate targets.</p>'}
      <div class="row between"><div><div style="font-weight:600">Use custom targets</div><div class="muted xs">Override the calculated values</div></div>
        <label class="switch"><input type="checkbox" data-path="goals.custom" ${g.custom ? 'checked' : ''}><i></i></label></div>
      ${g.custom || !calc ? `<div class="grid2" style="margin-top:12px">
        <label class="field"><span>Calories</span>${num('goals.kcal', g.kcal, 'kcal', '10')}</label>
        <label class="field"><span>Protein (g)</span>${num('goals.protein', g.protein, 'g', '1')}</label>
        <label class="field"><span>Carbs (g)</span>${num('goals.carbs', g.carbs, 'g', '1')}</label>
        <label class="field"><span>Fat (g)</span>${num('goals.fat', g.fat, 'g', '1')}</label></div>` : ''}
      <div class="grid2" style="margin-top:12px">
        <label class="field"><span>Active days / week</span>${num('goals.activeDays', g.activeDays, '4', '1')}</label>
        <label class="field"><span>Workout minutes / week</span>${num('goals.weeklyMinutes', g.weeklyMinutes, '150', '10')}</label>
      </div>
      <p class="muted xs" style="margin:8px 0 0">WHO recommends at least 150 min/week of moderate activity (or 75 min vigorous), plus strength training on 2+ days.</p>
      <label class="field" style="margin-top:12px"><span>Eat back exercise</span><select data-path="goals.eatBack" data-num>
        ${[0, 50, 100].map((v) => `<option value="${v}" ${+g.eatBack === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></label>
      <p class="muted xs" style="margin:8px 0 0">"Eat back" adds that share of workout calories to the day's budget. 0–50% is safest, because trackers tend to overestimate burn.</p>
    </section>

    <section class="card stack">
      <div class="label">AI provider</div>
      <div class="seg">
        <button data-act="set-provider" data-v="gemini" class="${st.provider !== 'claude' ? 'on' : ''}">Gemini · free</button>
        <button data-act="set-provider" data-v="claude" class="${st.provider === 'claude' ? 'on' : ''}">Claude · paid</button>
      </div>
      <p class="muted xs" style="margin:0">${st.provider === 'claude'
        ? 'Claude is billed per use to your Anthropic account and is usually faster and more reliable than Gemini’s free tier.'
        : 'Gemini’s free tier has daily limits and can be slow or busy at peak times.'} Keys ${ui.user ? 'sync with your account and' : 'stay on this device and'} are sent only to Google or Anthropic.</p>
      <div class="row between"><div><div style="font-weight:600">Use the other one as backup</div><div class="muted xs">If the chosen AI is busy or out of quota</div></div>
        <label class="switch"><input type="checkbox" data-path="settings.autoFallback" ${st.autoFallback !== false ? 'checked' : ''}><i></i></label></div>
    </section>

    <section class="card stack">
      <div class="label">Gemini (Google, free)</div>
      <label class="field"><span>API key</span><input type="password" autocomplete="off" data-path="settings.apiKey" value="${esc(st.apiKey)}" placeholder="Paste key from Google AI Studio"></label>
      <p class="muted xs" style="margin:0">Free key: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--accent)">aistudio.google.com/apikey</a></p>
      <div class="row">
        <label class="field grow"><span>Model</span><select data-path="settings.model">
          ${models.length ? models.map((m) => `<option ${m === st.model ? 'selected' : ''}>${esc(m)}</option>`).join('') : '<option value="">Auto (detect on first use)</option>'}</select></label>
        <button class="btn" style="align-self:flex-end" data-act="detect-models" ${st.apiKey ? '' : 'disabled'}>Detect</button>
      </div>
    </section>

    <section class="card stack">
      <div class="label">Claude (Anthropic, paid)</div>
      <label class="field"><span>API key</span><input type="password" autocomplete="off" data-path="settings.claudeKey" value="${esc(st.claudeKey)}" placeholder="sk-ant-…"></label>
      <p class="muted xs" style="margin:0">Create a key and add credit at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style="color:var(--accent)">console.anthropic.com</a>. Set a monthly spend limit there for peace of mind.</p>
      <div class="row">
        <label class="field grow"><span>Model</span><select data-path="settings.claudeModel">
          ${AI.CLAUDE_MODELS.map((m) => `<option value="${m.id}" ${m.id === (st.claudeModel || AI.DEFAULT_CLAUDE_MODEL) ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
        <button class="btn" style="align-self:flex-end" data-act="test-claude" ${st.claudeKey ? '' : 'disabled'}>Test</button>
      </div>
    </section>

    <section class="card stack">
      <div class="label">Data</div>
      <p class="muted xs" style="margin:0">${ui.user ? 'Synced to your Google account. A backup file is still handy as an extra copy.' : 'Everything is stored on this device only. Add FitLog to your Home Screen so iOS keeps it, and export a backup now and then.'}</p>
      <div class="grid2"><button class="btn" data-act="export">Export backup</button>
        <label class="btn">Import backup<input type="file" accept="application/json,.json" data-change="import" hidden></label></div>
      <button class="btn block" data-act="prune-photos">Delete photos older than 60 days</button>
      <button class="btn danger block" data-act="reset">${ui.user ? 'Erase all account data' : 'Erase all data'}</button>
    </section>
    <p class="center faint xs">FitLog · estimates are approximate and not medical advice.</p>`;
}

function accountCard() {
  if (!cloud.enabled) return '';
  if (!ui.user) {
    return `<section class="card stack">
      <div class="label">Account</div>
      <p class="muted sm" style="margin:0">Sign in to save your log to your Google account and use it on any device. Without signing in, data stays on this device only.</p>
      <button class="btn primary block" data-act="sign-in">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#052e14" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"/></svg>
        Sign in with Google</button>
    </section>`;
  }
  const u = ui.user;
  return `<section class="card">
    <div class="label" style="margin-bottom:10px">Account</div>
    <div class="row">
      ${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer" style="width:40px;height:40px;border-radius:50%">` : ''}
      <div class="grow"><div style="font-weight:600">${esc(u.displayName || 'Signed in')}</div><div class="muted xs">${esc(u.email || '')}</div></div>
      <span class="pill ok">Synced</span>
    </div>
    <p class="muted xs" style="margin:10px 0">Your log and API key are stored in your private Firebase database and sync to every device you sign in on. Works offline; changes upload when you reconnect.</p>
    <button class="btn block" data-act="sign-out">Sign out</button>
  </section>`;
}

// ---------- meal sheet ----------
async function resizeImage(file, max = 768, q = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const cleanItem = (i) => ({
  name: String(i.name || 'Item').slice(0, 60), portion: String(i.portion || ''),
  kcal: n0(i.kcal), protein: n1(i.protein), carbs: n1(i.carbs), fat: n1(i.fat),
  fiber: n1(i.fiber), sugar: n1(i.sugar), sodium: n0(i.sodium),
});

// ---------- personal food database (built from every item ever logged) ----------
const normName = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
function foodIndex(excludeMealId) {
  const meals = S.meals.filter((m) => m.id !== excludeMealId)
    .sort((a, b) => (a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date < b.date ? -1 : 1));
  const foods = new Map();
  for (const m of meals) {
    for (const it of m.items) {
      const key = normName(it.name);
      if (!key) continue;
      const f = foods.get(key) || { count: 0 };
      foods.set(key, { item: it, count: f.count + 1, last: m.date }); // latest version wins
    }
  }
  return { foods: [...foods.values()], meals: meals.reverse() };
}
function searchFoods(index, q) {
  const toks = normName(q).split(' ').filter(Boolean);
  if (!toks.length) return [...index.foods].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1)).slice(0, 8);
  return index.foods
    .filter((f) => { const hay = normName(f.item.name + ' ' + f.item.portion); return toks.every((t) => hay.includes(t)); })
    .sort((a, b) => (normName(b.item.name).startsWith(toks[0]) - normName(a.item.name).startsWith(toks[0])) || b.count - a.count)
    .slice(0, 8);
}
function recentMeals(index, type, q) {
  const toks = normName(q).split(' ').filter(Boolean), seen = new Set(), out = [];
  for (const m of index.meals) {
    if (toks.length ? m.items.length < 2 : m.type !== type) continue; // single items already show as foods
    const label = m.items.map((i) => i.name).join(', ');
    const key = normName(label);
    if (!key || seen.has(key) || !toks.every((t) => key.includes(t))) continue;
    seen.add(key);
    out.push({ meal: m, label });
    if (out.length === 3) break;
  }
  return out;
}

async function openMealSheet({ id, type }) {
  const existing = id && S.meals.find((m) => m.id === id);
  const draft = existing ? clone(existing) : {
    id: uid(), date: ui.date, type: type || C.guessMealType(), note: '', photoIds: [], items: [],
    confidence: null, aiNotes: '', createdAt: Date.now(),
  };
  const photos = new Map(); // id -> dataURL
  for (const pid of draft.photoIds) photos.set(pid, await getPhoto(pid));
  let busy = false, refineText = '', query = '';
  const index = foodIndex(draft.id);
  const el = openSheet({ persistent: true });

  const suggestionsHtml = () => {
    if (!index.foods.length) return '';
    const foods = searchFoods(index, query);
    const meals = recentMeals(index, draft.type, query);
    if (!foods.length && !meals.length) return `<div class="empty-hint">No match in your foods. Use a photo or notes with AI below.</div>`;
    const typeLabel = C.MEAL_TYPES.find((x) => x.key === draft.type).label.toLowerCase();
    return `
      ${meals.length ? `<div class="label xs" style="margin:2px 0 6px">${query ? 'Past meals' : `Repeat a recent ${typeLabel}`}</div>
        ${meals.map((x, i) => `<button class="sugg-row" data-m="use-meal" data-i="${i}"><div class="grow"><div class="entry-title">${esc(x.label)}</div>
          <div class="muted xs">${dateLabel(x.meal.date)} · ${x.meal.items.length} item${x.meal.items.length === 1 ? '' : 's'}</div></div>
          <b class="num">${fmt(C.sumItems(x.meal.items).kcal)}</b><span class="plus">+</span></button>`).join('')}` : ''}
      ${foods.length ? `<div class="label xs" style="margin:10px 0 6px">${query ? 'Your foods' : 'Frequent foods'}</div>
        ${foods.map((f, i) => `<button class="sugg-row" data-m="use-food" data-i="${i}"><div class="grow"><div class="entry-title">${esc(f.item.name)}</div>
          <div class="muted xs">${esc(f.item.portion || '')}${f.count > 1 ? ` · logged ${f.count}×` : ''}</div></div>
          <b class="num">${fmt(f.item.kcal)}</b><span class="plus">+</span></button>`).join('')}` : ''}`;
  };
  const paintSuggestions = () => { const box = $('#m-sugg', el); if (box) box.innerHTML = suggestionsHtml(); };

  const paint = () => {
    const t = C.sumItems(draft.items);
    const canAnalyze = (photos.size || draft.note.trim()) && !busy;
    el.innerHTML = `
      <div class="sheet-head"><button class="link" data-m="cancel">Cancel</button><h2>${existing ? 'Edit meal' : 'Log meal'}</h2>
        <button class="link strong" data-m="save" ${busy ? 'disabled' : ''}>Save</button></div>
      <div class="sheet-body">
        <div class="seg">${C.MEAL_TYPES.map((m) => `<button data-m="type" data-v="${m.key}" class="${draft.type === m.key ? 'on' : ''}">${m.label}</button>`).join('')}</div>
        ${index.foods.length ? `<input type="search" data-f="search" value="${esc(query)}" placeholder="Search foods you've logged before (no AI)" autocomplete="off">
          <div id="m-sugg">${draft.items.length && !query ? '' : suggestionsHtml()}</div>` : ''}
        <div class="photo-grid">
          ${[...photos].map(([pid, src]) => `<div class="photo"><img src="${src}" alt=""><button class="x" data-m="rm-photo" data-id="${pid}" aria-label="Remove">×</button></div>`).join('')}
          <label class="photo-add"><b>+</b>Photo<input type="file" accept="image/*" multiple hidden data-m-file></label>
        </div>
        <textarea data-f="note" placeholder="Optional notes: what it is, how much you ate, e.g. 'beef noodle soup, ate 2/3, no broth'">${esc(draft.note)}</textarea>
        <button class="btn ${draft.items.length ? '' : 'primary'} block" data-m="analyze" ${canAnalyze ? '' : 'disabled'}>
          ${busy === 'analyze' ? spinner + ' Analyzing…' : draft.items.length ? '↻ Re-analyze with AI' : '✦ Analyze with AI'}</button>
        ${draft.items.length ? `
          <div class="totals"><div><b data-t="kcal">${fmt(t.kcal)}</b><span class="xs muted">kcal</span></div>
            <div><b data-t="protein" style="color:var(--protein)">${n0(t.protein)}</b><span class="xs muted">protein g</span></div>
            <div><b data-t="carbs" style="color:var(--carbs)">${n0(t.carbs)}</b><span class="xs muted">carbs g</span></div>
            <div><b data-t="fat" style="color:var(--fat)">${n0(t.fat)}</b><span class="xs muted">fat g</span></div></div>
          ${draft.aiNotes ? `<div class="ai-note">${draft.confidence ? `<span class="pill ${draft.confidence === 'high' ? 'ok' : draft.confidence === 'medium' ? 'warn' : 'bad'}">${draft.confidence} confidence</span> ` : ''}${esc(draft.aiNotes)}</div>` : ''}
          <div class="row"><input data-f="refine" placeholder="Adjust in words: 'rice was half a bowl'" value="${esc(refineText)}" class="grow">
            <button class="btn" data-m="refine" ${busy ? 'disabled' : ''}>${busy === 'refine' ? spinner : 'Apply'}</button></div>` : ''}
        <div class="stack">${draft.items.map(itemHtml).join('')}</div>
        <button class="btn ghost block" data-m="add-item">+ Add item manually</button>
        ${existing ? '<button class="btn danger block" data-m="delete">Delete meal</button>' : ''}
      </div>`;
  };

  const itemHtml = (it, i) => {
    const f = (k, label) => `<label><span>${label}</span><input type="number" inputmode="decimal" data-i="${i}" data-k="${k}" value="${it[k] ?? ''}"></label>`;
    return `<div class="item">
      <div class="row"><input class="name grow" data-i="${i}" data-k="name" value="${esc(it.name)}" placeholder="Food name">
        <button class="icon-btn plain" data-m="del-item" data-i="${i}" aria-label="Remove item">×</button></div>
      <div class="row"><input class="grow" data-i="${i}" data-k="portion" value="${esc(it.portion)}" placeholder="Portion, e.g. 1 bowl (200 g)">
        <div class="scale">${[0.5, 1.5, 2].map((f) => `<button data-m="scale" data-i="${i}" data-x="${f}">${f === 0.5 ? '½' : f}×</button>`).join('')}</div></div>
      <div class="nums">${f('kcal', 'kcal')}${f('protein', 'Protein')}${f('carbs', 'Carbs')}${f('fat', 'Fat')}</div>
      <details><summary>Fiber · sugar · sodium ›</summary><div class="nums">${f('fiber', 'Fiber g')}${f('sugar', 'Sugar g')}${f('sodium', 'Sodium mg')}</div></details>
    </div>`;
  };

  const updateTotals = () => {
    const t = C.sumItems(draft.items);
    for (const k of ['kcal', 'protein', 'carbs', 'fat']) { const b = $(`[data-t="${k}"]`, el); if (b) b.textContent = k === 'kcal' ? fmt(t[k]) : n0(t[k]); }
  };

  const applyResult = (res) => {
    draft.items = (res.items || []).map(cleanItem);
    draft.confidence = res.confidence || null;
    draft.aiNotes = res.notes || '';
  };

  el.addEventListener('input', (e) => {
    const tg = e.target;
    if (tg.dataset.f === 'note') { draft.note = tg.value; const b = $('[data-m="analyze"]', el); if (b && !busy) b.disabled = !(photos.size || draft.note.trim()); }
    else if (tg.dataset.f === 'refine') refineText = tg.value;
    else if (tg.dataset.f === 'search') { query = tg.value; paintSuggestions(); }
    else if (tg.dataset.k) {
      const it = draft.items[+tg.dataset.i];
      it[tg.dataset.k] = ['name', 'portion'].includes(tg.dataset.k) ? tg.value : tg.value === '' ? 0 : +tg.value;
      updateTotals();
    }
  });

  el.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-m-file]')) return;
    const files = [...e.target.files];
    for (const f of files) {
      try { photos.set(uid(), await resizeImage(f)); } catch { toast('Could not read one of the images'); }
    }
    paint();
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b || b.disabled) return;
    const m = b.dataset.m;
    if (m === 'cancel') {
      if (!existing && draft.items.length && !confirm('Discard this meal?')) return;
      closeSheet();
    } else if (m === 'type') { draft.type = b.dataset.v; paint(); }
    else if (m === 'rm-photo') { photos.delete(b.dataset.id); paint(); }
    else if (m === 'add-item') { draft.items.push(cleanItem({ name: '', kcal: 0 })); paint(); $$('.item .name', el).at(-1)?.focus(); }
    else if (m === 'del-item') { draft.items.splice(+b.dataset.i, 1); paint(); }
    else if (m === 'use-food' || m === 'use-meal') {
      const picked = m === 'use-food'
        ? [searchFoods(index, query)[+b.dataset.i].item]
        : recentMeals(index, draft.type, query)[+b.dataset.i].meal.items;
      draft.items.push(...picked.map((it) => cleanItem(clone(it))));
      query = '';
      paint();
      toast(`Added ${picked.length > 1 ? picked.length + ' items' : picked[0].name} from your foods`);
    } else if (m === 'scale') {
      const it = draft.items[+b.dataset.i], x = +b.dataset.x;
      for (const k of C.NUTRIENTS) it[k] = k === 'kcal' || k === 'sodium' ? n0(it[k] * x) : n1(it[k] * x);
      it.portion = `${x === 0.5 ? '½' : x}× ${it.portion}`.trim();
      paint();
    }
    else if (m === 'analyze') {
      busy = 'analyze'; paint();
      try {
        const label = C.MEAL_TYPES.find((x) => x.key === draft.type).label;
        applyResult(await AI.analyzeMeal({ images: [...photos.values()], mealType: label, note: draft.note }));
        if (AI.lastProvider()?.includes('backup')) toast(`Used ${AI.lastProvider()}`);
      } catch (err) { toast(err.message); }
      busy = false; paint();
    } else if (m === 'refine') {
      if (!refineText.trim()) return toast('Type what to change first');
      busy = 'refine'; paint();
      try {
        applyResult(await AI.refineMeal({ items: draft.items, note: draft.note, correction: refineText }));
        refineText = '';
      } catch (err) { toast(err.message); }
      busy = false; paint();
    } else if (m === 'delete') {
      if (!confirm('Delete this meal?')) return;
      draft.photoIds.forEach(deletePhoto);
      S.meals = S.meals.filter((x) => x.id !== draft.id);
      markDirty(draft.date); save(); closeSheet(); render();
    } else if (m === 'save') {
      draft.items = draft.items.filter((i) => i.name.trim() || +i.kcal);
      if (!draft.items.length) return toast('Analyze with AI or add at least one item');
      const keep = new Set(photos.keys());
      for (const pid of draft.photoIds) if (!keep.has(pid)) deletePhoto(pid);
      for (const [pid, src] of photos) if (!draft.photoIds.includes(pid)) await savePhoto(pid, src);
      draft.photoIds = [...keep];
      draft.items = draft.items.map(cleanItem);
      const idx = S.meals.findIndex((x) => x.id === draft.id);
      if (idx >= 0) S.meals[idx] = draft; else S.meals.push(draft);
      markDirty(draft.date); save(); closeSheet(); render();
      toast(`Saved · ${fmt(C.sumItems(draft.items).kcal)} kcal`);
    }
  });

  paint();
}

// ---------- workout sheet ----------
function openWorkoutSheet({ id, date }) {
  const existing = id && S.workouts.find((w) => w.id === id);
  const kg = curWeight() || 70;
  const draft = existing ? clone(existing) : {
    id: uid(), date: date || ui.date, key: 'walk', name: 'Walking', minutes: 30, intensity: 'moderate',
    met: 3.5, kcal: 0, manual: false, note: '', createdAt: Date.now(),
  };
  let busy = false, describe = '';
  const recalc = () => { if (!draft.manual) draft.kcal = C.workoutKcal(draft.met, draft.minutes, kg, draft.intensity); };
  recalc();
  const el = openSheet();

  const paint = () => {
    el.innerHTML = `
      <div class="sheet-head"><button class="link" data-w="cancel">Cancel</button><h2>${existing ? 'Edit workout' : 'Log workout'}</h2>
        <button class="link strong" data-w="save">Save</button></div>
      <div class="sheet-body">
        <div class="row"><input data-wf="describe" class="grow" placeholder="Describe it: '45 min tennis doubles'" value="${esc(describe)}">
          <button class="btn" data-w="ai" ${busy ? 'disabled' : ''}>${busy ? spinner : '✦ AI'}</button></div>
        <div class="grid2">
          <label class="field"><span>Activity</span><select data-wf="key">
            ${C.ACTIVITIES.map((a) => `<option value="${a.key}" ${draft.key === a.key ? 'selected' : ''}>${a.name}</option>`).join('')}</select></label>
          <label class="field"><span>Date</span><input type="date" data-wf="date" value="${draft.date}" max="${C.today()}"></label>
        </div>
        ${draft.key === 'other' ? `<label class="field"><span>Name</span><input data-wf="name" value="${esc(draft.name)}"></label>` : ''}
        <div class="seg">${Object.keys(C.INTENSITY).map((k) => `<button data-w="int" data-v="${k}" class="${draft.intensity === k ? 'on' : ''}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
        <div class="grid2">
          <label class="field"><span>Minutes</span><input type="number" inputmode="numeric" data-wf="minutes" value="${draft.minutes}"></label>
          <label class="field"><span>kcal burned ${draft.manual ? '(edited)' : '(auto)'}</span><input type="number" inputmode="numeric" data-wf="kcal" value="${draft.kcal}"></label>
        </div>
        <p class="muted xs" style="margin-top:6px">Auto estimate = (MET − 1) × ${n1(kg)} kg × hours: active calories above resting. MET ${n1(draft.met * C.INTENSITY[draft.intensity])}.
          ${draft.manual ? '<button class="link" style="font-size:12px;color:var(--accent);padding:0" data-w="auto">Reset to auto</button>' : ''}</p>
        <label class="field"><span>Note</span><input data-wf="note" value="${esc(draft.note)}" placeholder="Optional"></label>
        ${existing ? '<button class="btn danger block" data-w="delete">Delete workout</button>' : ''}
      </div>`;
  };

  el.addEventListener('input', (e) => {
    const k = e.target.dataset.wf, v = e.target.value;
    if (!k) return;
    if (k === 'describe') describe = v;
    else if (k === 'minutes') { draft.minutes = +v || 0; recalc(); const kc = $('[data-wf="kcal"]', el); if (kc && !draft.manual) kc.value = draft.kcal; }
    else if (k === 'kcal') { draft.kcal = +v || 0; draft.manual = true; }
    else if (k === 'name' || k === 'note') draft[k] = v;
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.wf;
    if (k === 'key') {
      const a = C.ACTIVITIES.find((x) => x.key === e.target.value);
      Object.assign(draft, { key: a.key, name: a.key === 'other' ? draft.name : a.name, met: a.met, manual: false });
      recalc(); paint();
    } else if (k === 'date') draft.date = e.target.value || draft.date;
    else if (k === 'kcal') paint();
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-w]');
    if (!b || b.disabled) return;
    const m = b.dataset.w;
    if (m === 'cancel') closeSheet();
    else if (m === 'int') { draft.intensity = b.dataset.v; recalc(); paint(); }
    else if (m === 'auto') { draft.manual = false; recalc(); paint(); }
    else if (m === 'ai') {
      if (!describe.trim()) return toast('Describe the workout first');
      busy = true; paint();
      try {
        const r = await AI.estimateWorkout({ text: describe, profile: { ...S.profile, weightKg: kg } });
        Object.assign(draft, { key: 'other', name: r.name, minutes: n0(r.minutes), met: +r.met || 5, kcal: n0(r.kcal), manual: true, note: draft.note || describe });
      } catch (err) { toast(err.message); }
      busy = false; paint();
    } else if (m === 'delete') {
      if (!confirm('Delete this workout?')) return;
      S.workouts = S.workouts.filter((w) => w.id !== draft.id);
      markDirty(draft.date); save(); closeSheet(); render();
    } else if (m === 'save') {
      if (!draft.minutes && !draft.kcal) return toast('Add a duration');
      if (existing && existing.date !== draft.date) markDirty(existing.date);
      const idx = S.workouts.findIndex((w) => w.id === draft.id);
      if (idx >= 0) S.workouts[idx] = draft; else S.workouts.push(draft);
      markDirty(draft.date); save(); closeSheet(); render();
      toast(`Logged · ${fmt(draft.kcal)} kcal burned`);
    }
  });
  paint();
}

// ---------- weigh-in sheet ----------
function openWeighIn(date) {
  const existing = date && S.weights.find((w) => w.date === date);
  let d = existing?.date || C.today(), kg = existing?.kg ?? curWeight() ?? '';
  const el = openSheet();
  el.innerHTML = `
    <div class="sheet-head"><button class="link" data-x="cancel">Cancel</button><h2>Weigh-in</h2><button class="link strong" data-x="save">Save</button></div>
    <div class="sheet-body">
      <div class="grid2"><label class="field"><span>Date</span><input type="date" id="wi-d" value="${d}" max="${C.today()}"></label>
        <label class="field"><span>Weight (kg)</span><input type="number" inputmode="decimal" step="0.1" id="wi-kg" value="${kg}"></label></div>
      <p class="muted xs">Tip: weigh in the morning after the bathroom, before eating. The trend line smooths out daily water swings.</p>
      ${existing ? '<button class="btn danger block" data-x="delete">Delete entry</button>' : ''}
    </div>`;
  el.addEventListener('click', (e) => {
    const m = e.target.closest('[data-x]')?.dataset.x;
    if (m === 'cancel') closeSheet();
    if (m === 'delete') { S.weights = S.weights.filter((w) => w.date !== existing.date); save(); closeSheet(); render(); }
    if (m === 'save') {
      d = $('#wi-d', el).value || C.today();
      kg = +$('#wi-kg', el).value;
      if (!(kg > 20 && kg < 400)) return toast('Enter a valid weight');
      if (existing) S.weights = S.weights.filter((w) => w.date !== existing.date);
      setWeight(d, kg);
      save(); closeSheet(); render(); toast('Weight saved');
    }
  });
}
function setWeight(date, kg) {
  S.weights = S.weights.filter((w) => w.date !== date);
  S.weights.push({ date, kg: n1(kg) });
  S.profile.weightKg = curWeight();
}

// ---------- day review ----------
function reviewContext(d) {
  const t = targets(), tot = dayTotals(d);
  const prev = Array.from({ length: 7 }, (_, i) => C.addDays(d, -i - 1)).map(dayTotals).filter((x) => x.meals);
  const ws = C.weekStart(d);
  return {
    date: d,
    profile: { sex: S.profile.sex, age: S.profile.age, heightCm: S.profile.heightCm, weightKg: curWeight(), goalWeightKg: S.profile.goalWeightKg, paceKgPerWeek: S.profile.rate },
    targets: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, activeDaysPerWeek: t.activeDays, workoutMinutesPerWeek: t.weeklyMinutes, maintenanceKcal: t.calc?.tdee ?? null },
    intake: { kcal: n0(tot.kcal), protein: n0(tot.protein), carbs: n0(tot.carbs), fat: n0(tot.fat), fiber: n0(tot.fiber), sugar: n0(tot.sugar), sodiumMg: n0(tot.sodium) },
    exerciseKcal: n0(tot.burn),
    meals: mealsOn(d).map((m) => ({ meal: m.type, kcal: n0(C.sumItems(m.items).kcal), items: m.items.map((i) => `${i.name} (${i.portion}) ${n0(i.kcal)} kcal`), note: m.note || undefined })),
    workouts: workoutsOn(d).map((w) => `${w.name}, ${w.minutes} min, ${w.intensity}, ~${w.kcal} kcal`),
    previous7Days: { loggedDays: prev.length, avgKcal: prev.length ? n0(prev.reduce((s, x) => s + x.kcal, 0) / prev.length) : null },
    thisWeekSoFar: (({ days, minutes }) => ({ activeDays: days, workoutMinutes: minutes }))(weekStats(ws)),
  };
}

function localReview(ctx) {
  const { intake: i, targets: t } = ctx;
  const pct = (i.kcal - t.kcal) / t.kcal;
  const pRatio = t.protein ? i.protein / t.protein : 1;
  let score = 10 - Math.min(5, Math.abs(pct) * 20);
  if (pRatio < 0.8) score -= 1.5;
  if (ctx.workouts.length) score += 0.5;
  score = Math.max(1, Math.min(10, Math.round(score)));
  const wins = [], imp = [];
  if (Math.abs(pct) <= 0.1) wins.push(`Calories on target (${fmt(i.kcal)} vs ${fmt(t.kcal)}).`);
  else if (pct > 0.1) imp.push(`${fmt(i.kcal - t.kcal)} kcal over goal. Look at the biggest item and trim the portion next time.`);
  else imp.push(`${fmt(t.kcal - i.kcal)} kcal under goal. Very low days can backfire with cravings, so add a protein-rich snack.`);
  if (pRatio >= 0.9) wins.push(`Protein ${i.protein} g, close to your ${t.protein} g target.`);
  else imp.push(`Protein ${i.protein}/${t.protein} g. Add eggs, Greek yogurt, tofu, fish or lean meat.`);
  if (ctx.workouts.length) wins.push(`Trained today: ${ctx.workouts.join('; ')}.`);
  if (i.fiber > 0 && i.fiber < 20) imp.push(`Fiber ~${i.fiber} g. Aim for 25 g+ with vegetables, fruit and whole grains.`);
  return {
    score, source: 'local',
    headline: score >= 8 ? 'Solid day' : score >= 5 ? 'Decent, with room to tune' : 'Off track, reset tomorrow',
    summary: `You ate ${fmt(i.kcal)} kcal (goal ${fmt(t.kcal)}) and burned ~${fmt(ctx.exerciseKcal)} kcal in workouts. Macros: P ${i.protein} g · C ${i.carbs} g · F ${i.fat} g.`,
    wins: wins.slice(0, 3), improvements: imp.slice(0, 3),
    tomorrow: pRatio < 0.9 ? 'Plan a protein source for every meal.' : ctx.workouts.length ? 'Keep the momentum: same plan tomorrow.' : 'Fit in a 20–30 min walk or workout.',
  };
}

async function finishDay() {
  const d = ui.date;
  const el = openSheet({ persistent: true });
  el.innerHTML = `<div class="sheet-head"><span></span><h2>Day review</h2><span style="width:50px"></span></div>
    <div class="sheet-body center" style="padding:48px 16px"><div class="row" style="justify-content:center">${spinner}<span class="muted">Reviewing your day…</span></div></div>`;
  const ctx = reviewContext(d);
  let review, note = '';
  try {
    review = await AI.dayReview(ctx);
    review.source = 'ai';
  } catch (err) {
    review = localReview(ctx);
    note = `AI unavailable (${err.message}). Showing an offline summary.`;
  }
  S.days[d] = { closed: true, closedAt: Date.now(), review, stale: false };
  save(); render();
  el.innerHTML = `<div class="sheet-head"><span style="width:50px"></span><h2>Day review</h2><button class="link strong" data-x="close">Done</button></div>
    <div class="sheet-body">${note ? `<div class="ai-note">${esc(note)}</div>` : ''}${reviewCard(review)}</div>`;
  el.querySelector('[data-x="close"]').onclick = closeSheet;
}

// ---------- global events ----------
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) { ui.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  switch (b.dataset.act) {
    case 'tab': ui.tab = b.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'open-settings': if (ui.tab !== 'settings') ui.prevTab = ui.tab; ui.tab = 'settings'; render(); window.scrollTo(0, 0); break;
    case 'close-settings': ui.tab = ui.prevTab || 'today'; render(); window.scrollTo(0, 0); break;
    case 'set-provider': S.settings.provider = b.dataset.v; save(); render(); break;
    case 'test-claude':
      b.innerHTML = spinner; b.disabled = true;
      try { await AI.testClaude(S.settings.claudeKey, S.settings.claudeModel); toast('Claude key works'); } catch (err) { toast(err.message); }
      render(); break;
    case 'prev-day': ui.date = C.addDays(ui.date, -1); ui.followToday = false; render(); break;
    case 'next-day': ui.date = C.addDays(ui.date, 1); ui.followToday = ui.date >= C.today(); render(); break;
    case 'goto-day': ui.date = b.dataset.date; ui.followToday = ui.date === C.today(); ui.tab = 'today'; render(); window.scrollTo(0, 0); break;
    case 'add-meal': openMealSheet({ type: b.dataset.type }); break;
    case 'edit-meal': openMealSheet({ id: b.dataset.id }); break;
    case 'add-workout': openWorkoutSheet({ date: b.dataset.today ? C.today() : ui.date }); break;
    case 'edit-workout': openWorkoutSheet({ id: b.dataset.id }); break;
    case 'weigh-in': openWeighIn(b.dataset.date); break;
    case 'finish-day': finishDay(); break;
    case 'reopen-day': delete S.days[ui.date]; save(); render(); break;
    case 'detect-models': {
      b.innerHTML = spinner; b.disabled = true;
      try {
        const list = await AI.listModels(S.settings.apiKey);
        S.settings.models = list;
        if (!S.settings.model || !list.includes(S.settings.model)) S.settings.model = AI.pickModel(list);
        save(); toast(`Key works · using ${S.settings.model}`);
      } catch (err) { toast(err.message); }
      render(); break;
    }
    case 'export': exportData(); break;
    case 'prune-photos': prunePhotos(); break;
    case 'sign-in':
      b.disabled = true;
      try { await cloud.signIn(); } catch (err) { toast(err.message); b.disabled = false; }
      break;
    case 'sign-out':
      if (!confirm('Sign out? Your data stays in your Google account.')) return;
      await cloud.signOut();
      break;
    case 'reset':
      if (ui.user) {
        if (!confirm('Erase ALL meals, workouts, weights and settings in your account, on every device?')) return;
        b.disabled = true;
        try { await cloud.eraseAll(); } catch (err) { return toast('Erase failed: ' + err.message); }
        await db.clearAll(); photoCache.clear(); toast('All account data erased');
        break;
      }
      if (!confirm('Erase ALL meals, workouts, weights and settings on this device?')) return;
      await db.clearAll(); photoCache.clear(); S = hydrateState(null); await flush(); render(); toast('All data erased');
      break;
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.closest('.sheet')) return;
  if (t.dataset.change === 'pick-date' && t.value) { ui.date = t.value > C.today() ? C.today() : t.value; ui.followToday = ui.date === C.today(); render(); return; }
  if (t.dataset.change === 'import' && t.files[0]) return importData(t.files[0]);
  const path = t.dataset.path;
  if (!path) return;
  let v = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.num !== undefined && t.type !== 'checkbox') v = v === '' ? null : +v;
  if (path === 'current-weight') { if (v > 20 && v < 400) setWeight(C.today(), v); }
  else {
    const [a, k] = path.split('.');
    S[a][k] = typeof v === 'string' ? v.trim() : v;
    if (path === 'goals.custom' && v) { const c = C.calcGoals(S.profile, curWeight()); if (c) Object.assign(S.goals, { kcal: c.kcal, protein: c.protein, carbs: c.carbs, fat: c.fat }); }
    if (path === 'settings.apiKey') { S.settings.model = ''; S.settings.models = []; }
  }
  save(); render();
  if (path === 'settings.apiKey' && S.settings.apiKey) $('[data-act="detect-models"]')?.click();
});

// ---------- data management ----------
async function exportData() {
  await flush();
  let full = clone(S);
  if (ui.user) {
    try { full = hydrateState(await cloud.fetchAll()); } catch { toast('Offline: exporting loaded data only'); }
  }
  const data = { ...full, settings: { ...full.settings, apiKey: '', claudeKey: '', models: [] }, exportedAt: new Date().toISOString() };
  const file = new File([JSON.stringify(data, null, 1)], `fitlog-backup-${C.today()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'FitLog backup' }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.meals) || !data.profile) throw new Error('Not a FitLog backup');
    if (!confirm(`Replace current data with backup (${data.meals.length} meals, ${data.workouts?.length || 0} workouts)? Photos are not included in backups.`)) return;
    const { apiKey, claudeKey } = S.settings;
    S = hydrateState(data);
    delete S.exportedAt;
    S.settings.apiKey ||= apiKey;
    S.settings.claudeKey ||= claudeKey;
    await flush(); render(); toast('Backup restored');
  } catch (err) { toast('Import failed: ' + err.message); }
}

async function prunePhotos() {
  const cutoff = C.addDays(C.today(), -60);
  let n = 0;
  for (const m of S.meals) {
    if (m.date < cutoff && m.photoIds?.length) {
      for (const pid of m.photoIds) { deletePhoto(pid); n++; }
      m.photoIds = [];
    }
  }
  save(); toast(`Deleted ${n} photo${n === 1 ? '' : 's'}`);
}

// ---------- account / sync ----------
async function loadLocal() {
  try { return hydrateState(await db.kvGet('state')); } catch (err) { toast('Storage unavailable: ' + err.message); return hydrateState(null); }
}
const hasData = (s) => s.meals.length || s.workouts.length || s.weights.length || s.profile.age;

function applyCloud(data) {
  const models = S?.settings?.models || [];
  const s = hydrateState({ ...(data.root || {}), meals: data.meals, workouts: data.workouts, weights: data.weights, days: data.days });
  s.settings.models = models;
  return s;
}

async function onUser(u) {
  ui.user = u;
  if (!u) { S = await loadLocal(); render(); return; }
  ui.syncing = true;
  render();
  const { data, empty } = await cloud.start();
  if (ui.user !== u) return; // signed out meanwhile
  S = applyCloud(data);
  if (empty) {
    const local = await loadLocal();
    if (hasData(local) && confirm('Copy the meals, workouts and weights on this device into your Google account?')) {
      S = local;
      uploadLocalPhotos(local);
    } else {
      for (const k of ['apiKey', 'model', 'claudeKey', 'claudeModel', 'provider']) S.settings[k] ||= local.settings[k];
    }
    cloud.push(S);
  }
  ui.syncing = false;
  render();
}

async function uploadLocalPhotos(s) {
  const ids = s.meals.flatMap((m) => m.photoIds || []);
  for (const id of ids) {
    const src = await db.photoGet(id).catch(() => null);
    if (src) cloud.photoSet(id, src);
  }
  if (ids.length) toast(`Uploading ${ids.length} photo${ids.length === 1 ? '' : 's'}`);
}

// ---------- boot ----------
async function boot() {
  S = await loadLocal();
  AI.configure(() => S.settings, (m) => { S.settings.model = m; save(); });
  render();
  cloud.init({
    onUser,
    onData: (data) => { S = applyCloud(data); render(); },
    onError: (msg) => toast(msg),
  });
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
  else if (S && !$('#sheet-root').classList.contains('open')) render(); // picks up a new day after midnight
});

boot();
