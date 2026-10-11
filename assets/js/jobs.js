'use strict';

/* ============================== Настройки ============================== */
const CFG = {
  url: 'https://xqqeiigpamtegingzjda.supabase.co',
  // anon-ключ публичный по замыслу: он даёт только то, что разрешено grant select на view
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M',
};
const DEMO = new URLSearchParams(location.search).has('demo');
const TOP_K = 14;            // сколько навыков показываем на heatmap
const MIN_SAL = 5;           // минимум вакансий с зарплатой для медианы

const state = {
  jobs: [], latest: [], trend: [], health: [],
  f: { role: 'all', level: 'all', source: 'all', remote: 'all', salaryOnly: false },
  mode: 'co', leftView: 'skills',
};

/* ============================== Утилиты ============================== */
const $ = (s) => document.querySelector(s);
/** Создание DOM без innerHTML: данные из базы всегда попадают в текстовые узлы (защита от XSS). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}
const num = (v) => Number(v) || 0;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const kEur = (v) => (v == null ? '—' : `${Math.round(v / 1000)}k €`);
const pct = (v, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);

async function rest(view, query = '') {
  const rows = [], PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const url = `${CFG.url}/rest/v1/${view}?${query}${query ? '&' : ''}limit=${PAGE}&offset=${off}`;
    const r = await fetch(url, { headers: { apikey: CFG.key, Authorization: `Bearer ${CFG.key}` } });
    if (!r.ok) throw new Error(`${view}: HTTP ${r.status}`);
    const part = await r.json();
    rows.push(...part);
    if (part.length < PAGE) return rows;
  }
}

/* ============================== Фильтры и статистика ============================== */
function filtered(skip = []) {
  const f = state.f;
  return state.jobs.filter((j) =>
    (skip.includes('role') || f.role === 'all' || j.role_group === f.role) &&
    (f.level === 'all' || j.seniority === f.level) &&
    (f.source === 'all' || j.source === f.source) &&
    (f.remote === 'all' || (f.remote === 'yes') === !!j.is_remote) &&
    (!f.salaryOnly || j.salary_year_eur != null));
}

function skillStats(arr) {
  const m = new Map();
  for (const j of arr) for (const s of j.skills || []) {
    let e = m.get(s); if (!e) { e = { skill: s, n: 0, sal: [] }; m.set(s, e); }
    e.n++; if (j.salary_year_eur != null) e.sal.push(num(j.salary_year_eur));
  }
  return [...m.values()].map((e) => ({ ...e, share: arr.length ? e.n / arr.length : 0, nSal: e.sal.length, median: e.sal.length >= MIN_SAL ? median(e.sal) : null }))
    .sort((a, b) => b.n - a.n || a.skill.localeCompare(b.skill));
}
const overallMedian = (arr) => { const s = arr.filter((j) => j.salary_year_eur != null).map((j) => num(j.salary_year_eur)); return s.length >= MIN_SAL ? median(s) : null; };

/* ============================== Графики (canvas) ============================== */
const cv = $('#cv'), ctx = cv.getContext('2d'), tip = $('#tip');
let hit = null;

function setup(canvas, c, w, hgt) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); canvas.style.height = hgt + 'px';
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, hgt);
}
const RAMP = [[0, [43, 108, 176]], [0.35, [77, 163, 255]], [0.6, [61, 220, 151]], [0.8, [255, 176, 32]], [1, [255, 92, 138]]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
    const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i], u = (t - t0) / (t1 - t0);
    return c0.map((c, j) => Math.round(c + (c1[j] - c) * u));
  }
  return RAMP[RAMP.length - 1][1];
}
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function drawChart() {
  const arr = filtered(), w = $('#chart').clientWidth;
  $('#mapEmpty').hidden = arr.length > 0; hit = null; tip.hidden = true;
  $('#chartTitle').textContent = { co: 'Какие навыки идут вместе', lift: 'Лифт: связь навыков сильнее случайной', sal: 'Медианная зарплата по навыкам' }[state.mode];
  renderLegend();
  if (!arr.length || !w) { setup(cv, ctx, w || 300, 260); return; }
  (state.mode === 'sal' ? drawSalary : drawMatrix)(arr, w);
}

function drawMatrix(arr, w) {
  const stats = skillStats(arr).filter((s) => s.n >= 2).slice(0, TOP_K), K = stats.length, N = arr.length;
  if (!K) { setup(cv, ctx, w, 260); return; }
  const idx = new Map(stats.map((s, i) => [s.skill, i])), pair = Array.from({ length: K }, () => new Array(K).fill(0));
  for (const j of arr) {
    const ids = (j.skills || []).map((s) => idx.get(s)).filter((i) => i != null);
    for (const a of ids) for (const b of ids) pair[a][b]++;
  }
  const M = { l: 92, t: 86, r: 10, b: 10 }, cell = Math.max(24, (w - M.l - M.r) / K), hgt = Math.round(M.t + K * cell + M.b);
  setup(cv, ctx, w, hgt);
  ctx.font = '11px IBM Plex Mono, monospace'; ctx.textBaseline = 'middle';
  stats.forEach((s, i) => {
    ctx.fillStyle = '#ECECEF'; ctx.textAlign = 'right'; ctx.fillText(s.skill, M.l - 8, M.t + (i + 0.5) * cell);
    ctx.save(); ctx.translate(M.l + (i + 0.5) * cell, M.t - 8); ctx.rotate(-Math.PI / 3); ctx.textAlign = 'left'; ctx.fillText(s.skill, 0, 0); ctx.restore();
  });
  const lift = state.mode === 'lift';
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
    const x = M.l + b * cell, y = M.t + a * cell, na = stats[a].n, nb = stats[b].n;
    let t, label;
    if (a === b) { t = null; label = pct(na / N); }
    else if (lift) { const l = (pair[a][b] * N) / (na * nb); t = 0.5 + Math.log2(l || 0.0625) / 4; label = l.toFixed(1); }
    else { const p = pair[a][b] / na; t = p; label = Math.round(p * 100) + '%'; }
    ctx.fillStyle = t == null ? '#232B38' : rgb(ramp(t)); ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    if (cell >= 34) { ctx.fillStyle = t == null ? '#9AA5B5' : '#0A0A0C'; ctx.textAlign = 'center'; ctx.fillText(label, x + cell / 2, y + cell / 2); }
  }
  hit = (px, py) => {
    const b = Math.floor((px - M.l) / cell), a = Math.floor((py - M.t) / cell);
    if (a < 0 || b < 0 || a >= K || b >= K) return null;
    const x = M.l + (b + 0.5) * cell, y = M.t + (a + 0.5) * cell, A = stats[a], B = stats[b];
    if (a === b) return { x, y, text: `${A.skill}: в ${A.n} из ${N} вакансий (${pct(A.n / N)})` };
    const p = pair[a][b] / A.n, l = (pair[a][b] * N) / (A.n * B.n);
    return { x, y, text: `Из ${A.n} вакансий с ${A.skill} ${pct(p)} требуют ${B.skill} (всего вместе ${pair[a][b]}). Лифт ${l.toFixed(2)}` };
  };
}

function drawSalary(arr, w) {
  const stats = skillStats(arr).slice(0, TOP_K), base = overallMedian(arr);
  const M = { l: 110, t: 24, r: 70, b: 10 }, rowH = 26, hgt = M.t + stats.length * rowH + M.b;
  setup(cv, ctx, w, hgt);
  const vals = stats.map((s) => s.median).filter((v) => v != null), max = Math.max(1, ...vals, base || 0) * 1.05;
  const X = (v) => M.l + (v / max) * (w - M.l - M.r);
  ctx.font = '11px IBM Plex Mono, monospace'; ctx.textBaseline = 'middle';
  stats.forEach((s, i) => {
    const y = M.t + i * rowH;
    ctx.fillStyle = '#ECECEF'; ctx.textAlign = 'right'; ctx.fillText(s.skill, M.l - 8, y + rowH / 2);
    if (s.median == null) { ctx.fillStyle = '#9AA5B5'; ctx.textAlign = 'left'; ctx.fillText(`мало данных (${s.nSal})`, M.l + 6, y + rowH / 2); return; }
    const above = base == null || s.median >= base;
    ctx.fillStyle = above ? '#3DDC97' : '#FF5C8A'; ctx.fillRect(M.l, y + 4, X(s.median) - M.l, rowH - 8);
    ctx.fillStyle = '#ECECEF'; ctx.textAlign = 'left'; ctx.fillText(kEur(s.median), X(s.median) + 6, y + rowH / 2);
  });
  if (base != null) {
    ctx.strokeStyle = '#FFB020'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(X(base), M.t - 8); ctx.lineTo(X(base), hgt - M.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#FFB020'; ctx.textAlign = 'center'; ctx.fillText(`медиана выборки ${kEur(base)}`, X(base), M.t - 14);
  }
  hit = (px, py) => {
    const i = Math.floor((py - M.t) / rowH); if (i < 0 || i >= stats.length) return null;
    const s = stats[i]; return { x: M.l + 40, y: M.t + (i + 0.5) * rowH, text: s.median == null ? `${s.skill}: вакансий ${s.n}, с зарплатой ${s.nSal} (нужно от ${MIN_SAL})` : `${s.skill}: медиана ${kEur(s.median)}, вакансий ${s.n}, с зарплатой ${s.nSal}${base ? `, разница с выборкой ${s.median - base >= 0 ? '+' : ''}${kEur(s.median - base)}` : ''}` };
  };
}

function renderLegend() {
  const box = $('#legend'); box.replaceChildren();
  if (state.mode === 'sal') { box.append(h('span', { text: 'Зелёный: медиана выше выборки, розовый: ниже. Пунктир: медиана выборки' })); return; }
  const bar = h('span', { class: 'bar' });
  bar.style.background = `linear-gradient(90deg, ${[0, .2, .4, .6, .8, 1].map((t) => rgb(ramp(t))).join(', ')})`;
  const [lo, hi] = state.mode === 'co' ? ['0% вакансий', '100% вакансий'] : ['реже случайного', 'чаще случайного'];
  box.append(h('span', { text: lo }), bar, h('span', { text: hi }), h('span', { text: state.mode === 'co' ? 'Строка = навык, столбец = какой ещё навык требуют' : 'Лифт 1.0 = независимость' }));
}

cv.addEventListener('mousemove', (e) => {
  if (!hit) return;
  const b = cv.getBoundingClientRect(), r = hit(e.clientX - b.left, e.clientY - b.top);
  if (!r) { tip.hidden = true; return; }
  tip.hidden = false; tip.textContent = r.text;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.min(Math.max(4, r.x + 12), b.width - tw - 4) + 'px';
  tip.style.top = Math.min(Math.max(4, r.y - th - 8), b.height - th - 4) + 'px';
});
cv.addEventListener('mouseleave', () => { tip.hidden = true; });

/* Динамика */
const tcv = $('#trend'), tctx = tcv.getContext('2d');
const ROLE_COLORS = ['#3DDC97', '#4DA3FF', '#FFB020', '#FF5C8A', '#B388FF', '#9AA5B5'];
function drawTrend() {
  const w = $('#trendBox').clientWidth, days = [...new Set(state.trend.map((r) => r.day))].sort();
  const box = $('#trendLegend'); box.replaceChildren();
  $('#trendNote').textContent = days.length < 2 ? `История копится: данных за ${days.length} дн. График заполнится по мере ежедневных запусков.` : `Активные вакансии по дням, ${days.length} дн.`;
  const hgt = 240; setup(tcv, tctx, w || 300, hgt);
  if (days.length < 2 || !w) return;
  const roles = [...new Set(state.trend.map((r) => r.role_group))];
  const by = new Map(roles.map((r) => [r, new Map()]));
  state.trend.forEach((r) => by.get(r.role_group).set(r.day, num(r.active_jobs)));
  const total = new Map(days.map((d) => [d, roles.reduce((a, r) => a + (by.get(r).get(d) || 0), 0)]));
  const series = [{ name: 'Все', map: total, color: '#ECECEF', wide: true }, ...roles.map((r, i) => ({ name: r, map: by.get(r), color: ROLE_COLORS[i % ROLE_COLORS.length] }))];
  const M = { l: 44, t: 12, r: 12, b: 26 }, max = Math.max(...total.values()) * 1.08;
  const X = (i) => M.l + (i / (days.length - 1)) * (w - M.l - M.r), Y = (v) => M.t + (1 - v / max) * (hgt - M.t - M.b);
  tctx.font = '11px IBM Plex Mono, monospace'; tctx.textBaseline = 'middle'; tctx.strokeStyle = '#243041'; tctx.fillStyle = '#9AA5B5';
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k, y = Y(v); tctx.beginPath(); tctx.moveTo(M.l, y); tctx.lineTo(w - M.r, y); tctx.stroke(); tctx.textAlign = 'right'; tctx.fillText(String(Math.round(v)), M.l - 6, y); }
  [0, Math.floor(days.length / 2), days.length - 1].forEach((i, k) => { tctx.textAlign = k === 0 ? 'left' : k === 2 ? 'right' : 'center'; tctx.fillText(days[i].slice(5), X(i), hgt - 10); });
  for (const s of series) {
    tctx.strokeStyle = s.color; tctx.lineWidth = s.wide ? 2.5 : 1.5; tctx.beginPath();
    days.forEach((d, i) => { const v = s.map.get(d) || 0; i ? tctx.lineTo(X(i), Y(v)) : tctx.moveTo(X(i), Y(v)); }); tctx.stroke();
    const sw = h('span', { class: 'sw' }); sw.style.background = s.color; box.append(h('span', {}, sw, s.name));
  }
}

/* ============================== Блоки ============================== */
const ROLES = () => [...new Set(state.jobs.map((j) => j.role_group))];
function renderHead() {
  const n = state.jobs.length, last = state.health.find((r) => r.status === 'ok');
  const when = last ? new Date(last.finished_at || last.started_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;
  $('#subtitle').textContent = n ? `Активных вакансий: ${n}${when ? `. Последнее обновление: ${when}` : ''}.` : 'Нет данных о вакансиях';
  const box = $('#results'); box.replaceChildren();
  const base = filtered(['role']);
  const all = h('button', { type: 'button', class: 'chip-game', 'aria-pressed': state.f.role === 'all' }, h('b', { text: base.length }), h('span', { text: 'Все роли' }));
  all.onclick = () => setFilter({ role: 'all' }); box.append(all);
  ROLES().sort().forEach((r) => {
    const c = base.filter((j) => j.role_group === r).length;
    const b = h('button', { type: 'button', class: 'chip-game', 'aria-pressed': state.f.role === r }, h('b', { text: c }), h('span', { text: r }));
    b.onclick = () => setFilter({ role: r }); box.append(b);
  });
}

function fillSelect(id, options, value) {
  const el = $(id); el.replaceChildren();
  for (const [v, label] of options) el.append(h('option', { value: v, text: label }));
  el.value = options.some(([v]) => v === value) ? value : options[0][0];
  return el.value;
}
function renderFilters() {
  const f = state.f;
  f.level = fillSelect('#fLevel', [['all', 'Все'], ['Junior', 'Junior'], ['Middle', 'Middle'], ['Senior', 'Senior']], f.level);
  f.source = fillSelect('#fSource', [['all', 'Все'], ...[...new Set(state.jobs.map((j) => j.source))].sort().map((s) => [s, s])], f.source);
  f.remote = fillSelect('#fRemote', [['all', 'Все'], ['yes', 'Удалённо'], ['no', 'Офис или гибрид']], f.remote);
  $('#fSalary').checked = f.salaryOnly;
}

function renderStats() {
  const arr = filtered(), N = arr.length, f = state.f;
  const parts = [f.role === 'all' ? 'Все роли' : f.role]; if (f.level !== 'all') parts.push(f.level); if (f.source !== 'all') parts.push(f.source);
  if (f.remote !== 'all') parts.push(f.remote === 'yes' ? 'удалённо' : 'офис'); if (f.salaryOnly) parts.push('с зарплатой');
  $('#selLabel').textContent = `Выборка: ${parts.join(' · ')}`;
  const withSal = arr.filter((j) => j.salary_year_eur != null).length, week = Date.now() - 7 * 864e5;
  const fresh = arr.filter((j) => new Date(j.first_seen_date).getTime() >= week).length;
  const kpis = [['Вакансий', N], ['С зарплатой', N ? `${Math.round(withSal / N * 100)}%` : '—'], ['Медиана, €/год', kEur(overallMedian(arr))],
    ['Удалёнка', N ? `${Math.round(arr.filter((j) => j.is_remote).length / N * 100)}%` : '—'], ['Новые за 7 дн.', fresh],
    ['Навыков в вакансии', N ? (arr.reduce((a, j) => a + (j.skills || []).length, 0) / N).toFixed(1) : '—']];
  $('#kpis').replaceChildren(...kpis.map(([l, v]) => h('div', { class: 'kpi' }, h('div', { class: 'v', text: String(v) }), h('div', { class: 'l', text: l }))));

  const st = $('#skillTable'); st.replaceChildren(h('thead', {}, h('tr', {}, ...['Навык', 'Вак.', '%', 'Медиана'].map((t) => h('th', { text: t })))));
  const sb = h('tbody');
  skillStats(arr).slice(0, 8).forEach((s) => sb.append(h('tr', {}, h('td', { text: s.skill }), h('td', { class: 'mono', text: s.n }), h('td', { class: 'mono', text: pct(s.share) }), h('td', { class: 'mono', text: kEur(s.median) }))));
  if (!sb.children.length) sb.append(h('tr', {}, h('td', { colspan: 4, text: 'Нет данных' })));
  st.append(sb);

  const ht = $('#healthTable'); ht.replaceChildren(h('thead', {}, h('tr', {}, ...['Запуск', 'Источник', 'Статус', 'Новых'].map((t) => h('th', { text: t })))));
  const hb = h('tbody');
  state.health.slice(0, 5).forEach((r) => hb.append(h('tr', { title: r.notes || '' }, h('td', { class: 'mono', text: new Date(r.started_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) }),
    h('td', { text: r.source }), h('td', { class: r.status === 'ok' ? 'ok' : 'err', text: r.status === 'ok' ? (r.notes ? 'ok, есть замечания' : 'ok') : 'ошибка' }), h('td', { class: 'mono', text: num(r.new_jobs) }))));
  if (!hb.children.length) hb.append(h('tr', {}, h('td', { colspan: 4, text: 'Запусков пока нет' })));
  ht.append(hb);
}

function renderLeft() {
  const arr = filtered(), tabs = [...document.querySelectorAll('#leftTabs button')];
  tabs.forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.leftView));
  const ol = $('#leftList'); ol.replaceChildren();
  const row = (i, name, meta, big, small) => ol.append(h('li', {}, h('span', { class: 'rank', text: i + 1 }), h('div', { class: 'who' }, h('b', { text: name }), h('span', { text: meta })), h('div', { class: 'score' }, big, h('small', { text: small }))));
  const base = overallMedian(arr), v = state.leftView;
  if (v === 'skills') {
    $('#leftNote').textContent = 'Чаще всего встречаются в вакансиях выборки';
    skillStats(arr).slice(0, 5).forEach((s, i) => row(i, s.skill, `${s.n} вакансий`, pct(s.share), 'доля'));
  } else if (v === 'salary') {
    $('#leftNote').textContent = `Медиана зарплаты вакансий с навыком (от ${MIN_SAL} вакансий с зарплатой)`;
    skillStats(arr).filter((s) => s.median != null).sort((a, b) => b.median - a.median).slice(0, 5)
      .forEach((s, i) => row(i, s.skill, base ? `${s.median - base >= 0 ? '+' : ''}${kEur(s.median - base)} к медиане выборки` : `${s.nSal} с зарплатой`, kEur(s.median), 'в год'));
  } else if (v === 'roles') {
    $('#leftNote').textContent = 'Число вакансий по ролям';
    const m = new Map(); filtered(['role']).forEach((j) => m.set(j.role_group, [...(m.get(j.role_group) || []), j]));
    [...m].sort((a, b) => b[1].length - a[1].length).slice(0, 5).forEach(([r, js], i) => row(i, r, `медиана ${kEur(overallMedian(js))}`, String(js.length), 'вакансий'));
  } else {
    $('#leftNote').textContent = 'Кто нанимает больше всех';
    const m = new Map(); arr.forEach((j) => j.company && m.set(j.company, [...(m.get(j.company) || []), j]));
    [...m].sort((a, b) => b[1].length - a[1].length).slice(0, 5).forEach(([c, js], i) => row(i, c, [...new Set(js.map((j) => j.role_group))].slice(0, 2).join(', '), String(js.length), 'вакансий'));
  }
  if (!ol.children.length) ol.append(h('li', { class: 'mu', text: 'Нет данных' }));
}

function renderLatest() {
  const ul = $('#latest'); ul.replaceChildren();
  const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  for (const j of state.latest) {
    const hrs = j.published_at ? Math.round((new Date(j.published_at).getTime() - Date.now()) / 3600000) : null;
    const when = hrs == null ? '' : Math.abs(hrs) < 48 ? rtf.format(hrs, 'hour') : new Date(j.published_at).toLocaleDateString('ru-RU');
    const safe = /^https?:\/\//.test(j.url) ? j.url : null;      // только http(s)-ссылки
    ul.append(h('li', {}, h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: j.title }), h('span', { class: 'meta', text: [j.company, j.seniority, j.role_group, j.source, when].filter(Boolean).join(' · ') })));
  }
  if (!ul.children.length) ul.append(h('li', { class: 'mu', text: 'Нет данных' }));
}

function renderAll() { renderHead(); renderFilters(); drawChart(); renderStats(); renderLeft(); }
function setFilter(p) { state.f = { ...state.f, ...p }; renderAll(); }

/* ============================== Демо-данные (jobs.html?demo=1) ============================== */
function demoData() {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const roles = { 'Data Analyst': 0.38, 'Data Engineer': 0.2, 'Data Scientist / ML': 0.16, 'BI / Reporting': 0.14, 'Analytics Engineer': 0.12 };
  const SK = { sql: ['SQL', 'Python', 'Excel', 'Power BI', 'Tableau', 'Statistics', 'A/B testing', 'Looker', 'Pandas', 'R'], eng: ['SQL', 'Python', 'Airflow', 'Spark', 'dbt', 'Snowflake', 'AWS', 'Docker', 'Kafka', 'ETL', 'BigQuery', 'Databricks', 'Git', 'Terraform'], ml: ['Python', 'Machine Learning', 'Pandas', 'scikit-learn', 'PyTorch', 'TensorFlow', 'SQL', 'Statistics', 'AWS', 'Spark'] };
  const pools = { 'Data Analyst': SK.sql, 'BI / Reporting': SK.sql, 'Data Engineer': SK.eng, 'Analytics Engineer': ['SQL', 'dbt', 'Snowflake', 'Python', 'BigQuery', 'Git', 'Looker', 'Data modeling', 'Airflow'], 'Data Scientist / ML': SK.ml };
  const companies = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Soylent', 'Vandelay', 'Cyberdyne', 'Tyrell'];
  const jobs = [];
  for (let i = 0; i < 650; i++) {
    let r = rnd(), role = 'Data Analyst'; for (const [k, p] of Object.entries(roles)) { if ((r -= p) < 0) { role = k; break; } }
    const lvl = rnd() < 0.12 ? 'Junior' : rnd() < 0.62 ? 'Middle' : 'Senior', pool = pools[role], skills = new Set();
    pool.forEach((s, k) => { if (rnd() < 0.62 - k * 0.035) skills.add(s); });
    if (skills.has('Power BI') && rnd() < 0.5) skills.add('Excel');
    let sal = null;
    if (rnd() < 0.42) sal = Math.round((38000 + (lvl === 'Senior' ? 28000 : lvl === 'Middle' ? 12000 : 0) + (role === 'Data Engineer' ? 9000 : 0) + (skills.has('Snowflake') ? 6000 : 0) + (skills.has('Excel') ? -4000 : 0) + rnd() * 18000) / 100) * 100;
    jobs.push({ job_key: `demo:${i}`, source: rnd() < 0.55 ? 'remotive' : 'arbeitnow', company: pick(companies), role_group: role, seniority: lvl, is_remote: rnd() < 0.7, salary_year_eur: sal,
      first_seen_date: new Date(Date.now() - Math.floor(rnd() * 30) * 864e5).toISOString().slice(0, 10), skills: [...skills].sort() });
  }
  const trend = [];
  for (let d = 29; d >= 0; d--) { const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10); Object.keys(roles).forEach((r) => trend.push({ day, role_group: r, active_jobs: Math.round(roles[r] * (380 + (29 - d) * 9) + rnd() * 8), new_jobs: Math.round(rnd() * 8) })); }
  const health = [0, 0, 1, 1, 2, 3].map((d, i) => ({ source: i % 2 ? 'arbeitnow' : 'remotive', started_at: new Date(Date.now() - (d + (i % 2) * 0.01) * 864e5).toISOString(), finished_at: new Date(Date.now() - d * 864e5).toISOString(), status: i === 3 ? 'error' : 'ok', new_jobs: Math.round(rnd() * 20), notes: i === 3 ? 'HTTPError: 503' : null }));
  const latest = jobs.slice(0, 8).map((j, i) => ({ title: `${j.seniority === 'Senior' ? 'Senior ' : ''}${j.role_group.replace(' / ML', '')}`, company: j.company, seniority: j.seniority, role_group: j.role_group, source: j.source, url: 'https://example.com/', published_at: new Date(Date.now() - (i * 3 + 1) * 3600000).toISOString() }));
  return { jobs, trend, health, latest };
}

/* ============================== Запуск ============================== */
async function init() {
  document.querySelectorAll('#modes button').forEach((b) => b.onclick = () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('#modes button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    drawChart();
  });
  document.querySelectorAll('#leftTabs button').forEach((b) => b.onclick = () => { state.leftView = b.dataset.view; renderLeft(); });
  $('#fLevel').onchange = (e) => setFilter({ level: e.target.value });
  $('#fSource').onchange = (e) => setFilter({ source: e.target.value });
  $('#fRemote').onchange = (e) => setFilter({ remote: e.target.value });
  $('#fSalary').onchange = (e) => setFilter({ salaryOnly: e.target.checked });
  $('#fReset').onclick = () => { state.f = { role: 'all', level: 'all', source: 'all', remote: 'all', salaryOnly: false }; renderAll(); };

  if (DEMO) { Object.assign(state, demoData()); $('.head .lbl').textContent = 'Данные · Рынок труда · демо-данные'; }
  else {
    const jobs = { jobs: 'v_jobs_active', latest: 'v_jobs_latest', trend: 'v_jobs_trend', health: 'v_jobs_etl_health' };
    const res = await Promise.allSettled(Object.values(jobs).map((v) => rest(v)));     // блоки грузятся независимо
    Object.keys(jobs).forEach((k, i) => { if (res[i].status === 'fulfilled') state[k] = res[i].value; else console.error(res[i].reason); });
    const failed = Object.keys(jobs).filter((_, i) => res[i].status === 'rejected');
    if (failed.length) $('#subtitle').after(h('p', { class: 'error', text: `Не удалось загрузить: ${failed.join(', ')}. Проверьте sql/jobs_views.sql и права anon.` }));
  }
  renderAll(); renderLatest(); drawTrend();
}
new ResizeObserver(() => { drawChart(); drawTrend(); }).observe($('#chart'));
init();
