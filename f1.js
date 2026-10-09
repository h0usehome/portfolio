'use strict';

/* ============================== Настройки ============================== */
const CFG = {
  url: 'https://xqqeiigpamtegingzjda.supabase.co',
  // anon-ключ публичный по замыслу: он даёт только то, что разрешено grant select на view
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M',
};
const DEMO = new URLSearchParams(location.search).has('demo');

// Цвета команд подбираются по названию (Jolpica отдаёт актуальные названия, в 2026 это в том числе Audi и Cadillac)
const TEAM_COLORS = [['red bull', '#4F86F7'], ['ferrari', '#E8002D'], ['mercedes', '#27F4D2'], ['mclaren', '#FF8000'], ['aston', '#2BB586'],
  ['alpine', '#FF87BC'], ['williams', '#64C4FF'], ['racing bulls', '#7F9CFF'], ['rb f1', '#7F9CFF'], ['haas', '#B6BABD'],
  ['audi', '#F50537'], ['sauber', '#52E252'], ['cadillac', '#D9D9D9']];
const FALLBACK = ['#FFB020', '#B388FF', '#3DDC97', '#FF5C8A', '#4DA3FF', '#C9A227'];
const teamColor = (name = '') => {
  const n = name.toLowerCase();
  const hit = TEAM_COLORS.find(([k]) => n.includes(k));
  if (hit) return hit[1];
  let sum = 0; for (const ch of n) sum += ch.charCodeAt(0);
  return FALLBACK[sum % FALLBACK.length];
};

const state = {
  race: null, results: [], laps: [], pits: [], top: [], bestLaps: [], bestPits: [], standings: [], news: [],
  f: { team: 'all', driver: 'all' }, mode: 'heat', leftView: 'drivers',
};

/* ============================== Утилиты ============================== */
const $ = (s) => document.querySelector(s);
/** Создание DOM без innerHTML: данные из базы и RSS всегда попадают в текстовые узлы (защита от XSS). */
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
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtLap = (ms) => { if (ms == null) return '—'; const m = Math.floor(ms / 60000), s = (ms - m * 60000) / 1000; return `${m}:${s.toFixed(3).padStart(6, '0')}`; };
const fmtPit = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' с');
const dot = (color) => { const d = h('span', { class: 'team-dot' }); d.style.background = color; return d; };

async function rest(view, query = '') {
  const rows = [], PAGE = 1000;                         // PostgREST отдаёт максимум 1000 строк за запрос
  for (let off = 0; ; off += PAGE) {
    const url = `${CFG.url}/rest/v1/${view}?${query}${query ? '&' : ''}limit=${PAGE}&offset=${off}`;
    const r = await fetch(url, { headers: { apikey: CFG.key, Authorization: `Bearer ${CFG.key}` } });
    if (!r.ok) throw new Error(`${view}: HTTP ${r.status}`);
    const part = await r.json();
    rows.push(...part);
    if (part.length < PAGE) return rows;
  }
}

/* ============================== Производные данные ============================== */
const resById = () => new Map(state.results.map((r) => [r.driver_id, r]));

/** Пилоты, попадающие под фильтры (по порядку финиша). */
function selectedDrivers() {
  const { team, driver } = state.f;
  return state.results.filter((r) => (team === 'all' || r.team === team) && (driver === 'all' || r.driver_id === driver));
}
const isFiltered = () => state.f.team !== 'all' || state.f.driver !== 'all';

/** Таблица кругов: driver_id -> массив времени по кругам (индекс = номер круга - 1). */
function lapMatrix() {
  const by = new Map();
  for (const l of state.laps) {
    if (!by.has(l.driver_id)) by.set(l.driver_id, { times: [], pos: [] });
    const e = by.get(l.driver_id);
    e.times[num(l.lap) - 1] = l.lap_time_ms == null ? null : num(l.lap_time_ms);
    e.pos[num(l.lap) - 1] = num(l.position);
  }
  return by;
}
const totalLaps = () => Math.max(0, ...state.laps.map((l) => num(l.lap)), num(state.race?.total_laps));

/** Опорный темп гонки: медиана «нормальных» кругов (без первого круга и круга на пит-стопе/машины безопасности). */
function paceStats(m) {
  const all = []; for (const e of m.values()) e.times.forEach((t, i) => { if (t && i > 0) all.push(t); });
  const med = median(all);
  const clean = all.filter((t) => t < med * 1.12);
  return { med, best: Math.min(...all) };
}

/* ============================== Графики (canvas) ============================== */
const cv = $('#cv'), ctx = cv.getContext('2d'), tip = $('#tip');
let hit = null;   // функция поиска элемента под курсором для подсказки

function setup(w, hgt) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr);
  cv.style.height = hgt + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
}

const RAMP = [[0, [43, 108, 176]], [0.35, [77, 163, 255]], [0.6, [61, 220, 151]], [0.8, [255, 176, 32]], [1, [255, 92, 92]]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
    const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i], u = (t - t0) / (t1 - t0);
    return c0.map((c, j) => Math.round(c + (c1[j] - c) * u));
  }
  return RAMP[RAMP.length - 1][1];
}

function drawChart() {
  const n = totalLaps(), w = $('#chart').clientWidth;
  $('#mapEmpty').hidden = state.laps.length > 0;
  hit = null; tip.hidden = true;
  if (!state.laps.length || !w) { setup(w || 300, 260); return renderLegend(); }
  ({ heat: drawHeat, pos: drawPos, gap: drawGap }[state.mode])(n, w);
  renderLegend();
}

function drawHeat(n, w) {
  const m = lapMatrix(), { med, best } = paceStats(m);
  const rows = (isFiltered() ? selectedDrivers() : state.results).filter((r) => m.has(r.driver_id));
  const M = { l: 52, t: 26, r: 10, b: 12 }, rowH = rows.length > 8 ? 24 : 34;
  const hgt = M.t + rows.length * rowH + M.b;
  setup(w, hgt);
  const cw = (w - M.l - M.r) / n;
  ctx.font = '11px IBM Plex Mono, monospace'; ctx.textBaseline = 'middle';

  ctx.fillStyle = '#9AA5B5'; ctx.textAlign = 'center';
  for (let lap = 1; lap <= n; lap++) if (lap === 1 || lap % 5 === 0) ctx.fillText(String(lap), M.l + (lap - 0.5) * cw, M.t - 12);

  const pitLaps = new Set(state.pits.map((p) => `${p.driver_id}:${p.lap}`));
  rows.forEach((r, i) => {
    const y = M.t + i * rowH, e = m.get(r.driver_id);
    ctx.fillStyle = teamColor(r.team); ctx.fillRect(2, y + 3, 4, rowH - 6);
    ctx.fillStyle = '#ECECEF'; ctx.textAlign = 'left'; ctx.fillText(r.code || r.driver_id.slice(0, 3).toUpperCase(), 12, y + rowH / 2);
    for (let lap = 1; lap <= n; lap++) {
      const t = e.times[lap - 1], x = M.l + (lap - 1) * cw;
      if (t == null) { ctx.fillStyle = '#161C26'; ctx.fillRect(x, y + 1, cw + 0.5, rowH - 2); continue; }
      const delta = (t - best) / best;                      // отставание от лучшего круга гонки
      if (delta > 0.12) ctx.fillStyle = '#2A2F3A';          // медленные круги: пит-стоп, машина безопасности, красный флаг
      else { const c = ramp(1 - delta / 0.06); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; }
      ctx.fillRect(x, y + 1, cw + 0.5, rowH - 2);
      if (pitLaps.has(`${r.driver_id}:${lap}`)) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x + cw / 2, y + rowH / 2, Math.min(3.5, cw / 3), 0, 7); ctx.fill(); }
    }
  });

  hit = (px, py) => {
    const i = Math.floor((py - M.t) / rowH), lap = Math.floor((px - M.l) / cw) + 1;
    if (i < 0 || i >= rows.length || lap < 1 || lap > n) return null;
    const r = rows[i], t = m.get(r.driver_id).times[lap - 1];
    const pit = pitLaps.has(`${r.driver_id}:${lap}`);
    return { x: M.l + (lap - 0.5) * cw, y: M.t + (i + 0.5) * rowH, text: `${r.code} · круг ${lap}\n${fmtLap(t)}${t ? ` (+${(((t - best) / best) * 100).toFixed(1)}%)` : ''}${pit ? '\nпит-стоп' : ''}` };
  };
}

/** Линейные графики: позиции по кругам и отрыв от лидера. Выбранные пилоты яркие, остальные приглушены. */
function drawLines(n, w, series, yMax, yInvert, yLabelFn, ticks) {
  const M = { l: 40, t: 14, r: 46, b: 28 }, hgt = Math.round(w * 0.64);
  setup(w, hgt);
  const px = (lap) => M.l + (lap / n) * (w - M.l - M.r);
  const py = (v) => M.t + (v / yMax) * (hgt - M.t - M.b);
  ctx.font = '11px IBM Plex Mono, monospace'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#243041'; ctx.lineWidth = 1; ctx.fillStyle = '#9AA5B5'; ctx.textAlign = 'right';
  for (const t of ticks) { const y = py(t); ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke(); ctx.fillText(yLabelFn(t), M.l - 6, y); }
  ctx.textAlign = 'center';
  for (let lap = 0; lap <= n; lap += 5) ctx.fillText(String(lap), px(lap), hgt - M.b + 14);

  const sel = new Set(selectedDrivers().map((r) => r.driver_id)), dim = isFiltered();
  const order = [...series].sort((a, b) => (sel.has(a.id) ? 1 : 0) - (sel.has(b.id) ? 1 : 0));   // выбранные рисуем поверх
  for (const s of order) {
    const on = !dim || sel.has(s.id);
    ctx.strokeStyle = on ? s.color : 'rgba(154,165,181,.22)'; ctx.lineWidth = on ? (dim ? 3 : 2) : 1; ctx.setLineDash(on && s.dash ? [6, 4] : []);
    ctx.beginPath(); let started = false;
    s.pts.forEach((v, lap) => { if (v == null) return; const x = px(lap), y = py(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
    ctx.stroke();
    const last = s.pts.length - 1;
    if (on && s.pts[last] != null) { ctx.setLineDash([]); ctx.fillStyle = s.color; ctx.textAlign = 'left'; ctx.fillText(s.code, px(last) + 6, py(s.pts[last])); }
  }
  ctx.setLineDash([]);
  hit = (x, y) => {
    const lap = Math.max(0, Math.min(n, Math.round(((x - M.l) / (w - M.l - M.r)) * n)));
    let best = null, bd = 14;
    for (const s of series) { if (dim && !sel.has(s.id)) continue; const v = s.pts[lap]; if (v == null) continue; const d = Math.abs(py(v) - y); if (d < bd) { bd = d; best = { s, v }; } }
    return best ? { x: px(lap), y: py(best.v), text: `${best.s.code} · круг ${lap}\n${yLabelFn(best.v, true)}` } : null;
  };
}

function seriesBase() {
  const teamSeen = new Map();
  return state.results.map((r) => {
    const k = teamSeen.get(r.team) || 0; teamSeen.set(r.team, k + 1);
    return { id: r.driver_id, code: r.code || r.driver_id.slice(0, 3).toUpperCase(), color: teamColor(r.team), dash: k > 0, r };
  });
}

function drawPos(n, w) {
  const m = lapMatrix(), cnt = state.results.length;
  const series = seriesBase().map((s) => {
    const pts = [s.r.grid > 0 ? s.r.grid : cnt];                       // круг 0 = стартовая позиция (пит-лейн считаем последним)
    const e = m.get(s.id); for (let lap = 1; lap <= n; lap++) pts.push(e && e.pos[lap - 1] ? e.pos[lap - 1] : null);
    return { ...s, pts };
  });
  drawLines(n, w, series, cnt + 0.5, true, (v, tipMode) => (tipMode ? `позиция ${v}` : String(v)), Array.from({ length: cnt }, (_, i) => i + 1).filter((v) => v === 1 || v % 5 === 0));
}

function drawGap(n, w) {
  const m = lapMatrix(), cum = new Map(), lead = [0];
  for (const [id, e] of m) { let c = 0; const arr = [0]; e.times.forEach((t) => { c = t == null ? null : (c == null ? null : c + t); arr.push(c); }); cum.set(id, arr); }
  for (let lap = 1; lap <= n; lap++) { const vs = [...cum.values()].map((a) => a[lap]).filter((v) => v != null); lead.push(vs.length ? Math.min(...vs) : null); }
  const series = seriesBase().map((s) => ({ ...s, pts: (cum.get(s.id) || []).map((c, lap) => (c == null || lead[lap] == null ? null : (c - lead[lap]) / 1000)) }));
  const all = series.flatMap((s) => s.pts).filter((v) => v != null).sort((a, b) => a - b);
  const yMax = Math.max(10, Math.ceil((all[Math.floor(all.length * 0.97)] || 60) / 10) * 10);   // обрезаем отставших на круг, чтобы масштаб был читаем
  series.forEach((s) => { s.pts = s.pts.map((v) => (v == null ? null : Math.min(v, yMax))); });
  drawLines(n, w, series, yMax, false, (v, tipMode) => (tipMode ? `+${v.toFixed(1)} с к лидеру` : `+${v}с`), Array.from({ length: 5 }, (_, i) => (yMax / 4) * i).map((v) => Math.round(v)));
}

function renderLegend() {
  const box = $('#legend'); box.replaceChildren();
  if (state.mode === 'heat') {
    const bar = h('span', { class: 'bar' });
    bar.style.background = `linear-gradient(90deg, ${[0, .2, .4, .6, .8, 1].map((t) => `rgb(${ramp(t).join()})`).join(', ')})`;
    box.append(h('span', { text: 'медленнее' }), bar, h('span', { text: 'быстрее' }), h('span', {}, h('span', { class: 'dot' }), 'пит-стоп'), h('span', {}, h('span', { class: 'gray' }), 'круг на 12%+ медленнее'));
  } else {
    box.append(h('span', { text: state.mode === 'pos' ? 'Линия = пилот, цвет = команда, пунктир = второй пилот команды' : 'Время до лидера по кругам, отставшие на круг обрезаны' }));
  }
  $('#chartTitle').textContent = { heat: 'Темп гонки по кругам', pos: 'Позиции по кругам', gap: 'Отрыв от лидера' }[state.mode];
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
new ResizeObserver(() => drawChart()).observe($('#chart'));

/* ============================== Блоки ============================== */
function renderHead() {
  const r = state.race;
  if (!r) { $('#subtitle').textContent = 'Нет данных о гонках'; return; }
  $('#title').textContent = r.race_name;
  const [y, m, d] = r.race_date.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/\s*г\.$/, '');
  $('#subtitle').textContent = `${r.circuit_name}, ${r.locality}, ${r.country} · ${date} г. · этап ${r.round} сезона ${r.season} · кругов: ${r.total_laps ?? '—'}`;
  const box = $('#results'); box.replaceChildren();
  const all = h('button', { type: 'button', class: 'chip-game', 'aria-pressed': !isFiltered(), text: 'Все пилоты' });
  all.onclick = () => setFilter({ team: 'all', driver: 'all' }); box.append(all);
  state.results.filter((x) => x.position && x.position <= 3).forEach((x) => {
    const b = h('button', { type: 'button', class: 'chip-game', 'aria-pressed': state.f.driver === x.driver_id }, dot(teamColor(x.team)), h('b', { text: `P${x.position}` }), h('span', { text: x.code }), h('span', { class: 'mu', text: x.team }));
    b.onclick = () => setFilter({ team: x.team, driver: x.driver_id }); box.append(b);
  });
}

function fillSelect(id, options, value) {
  const el = $(id); el.replaceChildren();
  for (const [v, label] of options) el.append(h('option', { value: v, text: label }));
  el.value = options.some(([v]) => v === value) ? value : options[0][0];
  return el.value;
}

function renderFilters() {
  const teams = [...new Set(state.results.map((r) => r.team))].sort();
  state.f.team = fillSelect('#fTeam', [['all', 'Все'], ...teams.map((t) => [t, t])], state.f.team);
  const drivers = state.results.filter((r) => state.f.team === 'all' || r.team === state.f.team);
  state.f.driver = fillSelect('#fDriver', [['all', 'Все'], ...drivers.map((r) => [r.driver_id, r.driver_name])], state.f.driver);
}

function renderStats() {
  const sel = selectedDrivers(), ids = new Set(sel.map((r) => r.driver_id));
  const m = lapMatrix(), { med } = paceStats(m);
  const times = []; let bestLap = null;
  for (const [id, e] of m) if (ids.has(id)) e.times.forEach((t) => { if (t) { times.push(t); if (!bestLap || t < bestLap.t) bestLap = { t, code: resById().get(id)?.code }; } });
  const typical = times.filter((t) => t < med * 1.12), pits = state.pits.filter((p) => ids.has(p.driver_id) && p.duration_ms != null && p.duration_ms < 60000);
  const gained = sel.reduce((a, r) => a + (r.grid > 0 && r.position ? r.grid - r.position : 0), 0);
  const fin = sel.filter((r) => r.position).length;
  const label = !isFiltered() ? 'Вся гонка' : state.f.driver !== 'all' ? sel[0]?.driver_name : state.f.team;
  $('#selLabel').textContent = `Выборка: ${label || '—'}`;

  const kpis = [['Лучший круг', bestLap ? fmtLap(bestLap.t) : '—'], ['Медиана круга', fmtLap(median(typical))], ['Пит-стопы', String(pits.length)],
    ['Ср. пит-стоп', pits.length ? fmt(pits.reduce((a, p) => a + p.duration_ms, 0) / pits.length / 1000, 2) + ' с' : '—'],
    ['Места +/−', (gained > 0 ? '+' : '') + gained], ['Финиш', `${fin}/${sel.length}`]];
  $('#kpis').replaceChildren(...kpis.map(([l, v]) => h('div', { class: 'kpi' }, h('div', { class: 'v', text: v }), h('div', { class: 'l', text: l }))));

  const bestById = new Map([...m].map(([id, e]) => [id, Math.min(...e.times.filter(Boolean))]));
  const rt = $('#resTable'); rt.replaceChildren(h('thead', {}, h('tr', {}, ...['Пилот', 'Ст', 'Фин', 'Круг'].map((t) => h('th', { text: t })))));
  const rb = h('tbody');
  for (const r of sel) rb.append(h('tr', {}, h('td', {}, dot(teamColor(r.team)), r.code || r.driver_id), h('td', { class: 'mono', text: r.grid || 'PL' }), h('td', { class: 'mono', text: r.position ?? r.position_text }), h('td', { class: 'mono', text: Number.isFinite(bestById.get(r.driver_id)) ? fmtLap(bestById.get(r.driver_id)) : '—' })));
  if (!sel.length) rb.append(h('tr', {}, h('td', { colspan: 4, text: 'Нет данных' })));
  rt.append(rb);

  const pt = $('#pitTable'); pt.replaceChildren(h('thead', {}, h('tr', {}, ...['Пилот', 'Круг', 'Время'].map((t) => h('th', { text: t })))));
  const pb = h('tbody');
  [...state.pits].filter((p) => ids.has(p.driver_id)).sort((a, b) => num(a.lap) - num(b.lap)).forEach((p) =>
    pb.append(h('tr', {}, h('td', {}, dot(teamColor(p.team)), p.code), h('td', { class: 'mono', text: p.lap }), h('td', { class: 'mono', text: fmtPit(p.duration_ms) }))));
  if (!pb.children.length) pb.append(h('tr', {}, h('td', { colspan: 3, text: 'Нет пит-стопов' })));
  pt.append(pb);
}

function renderLeft() {
  const has = { drivers: state.top.length, laps: state.bestLaps.length, pits: state.bestPits.length, standings: state.standings.length };
  const tabs = [...document.querySelectorAll('#leftTabs button')];
  tabs.forEach((b) => { b.hidden = !has[b.dataset.view]; });
  const visible = tabs.filter((b) => !b.hidden);
  if (!visible.some((b) => b.dataset.view === state.leftView)) state.leftView = visible[0]?.dataset.view || 'drivers';
  tabs.forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.leftView));

  const ol = $('#leftList'); ol.replaceChildren();
  const row = (i, name, meta, big, small, team) => ol.append(h('li', {}, h('span', { class: 'rank', text: i + 1 }),
    h('div', { class: 'who' }, h('b', {}, dot(teamColor(team)), name), h('span', { text: meta })), h('div', { class: 'score' }, big, h('small', { text: small }))));
  const v = state.leftView;
  if (v === 'drivers') {
    $('#leftNote').textContent = 'По очкам, затем по числу обогнанных мест';
    state.top.forEach((p, i) => row(i, p.driver_name, `${p.team} · старт ${p.grid || 'PL'} → финиш ${p.position}`, String(num(p.points)), `${p.gained > 0 ? '+' : ''}${num(p.gained)} мест`, p.team));
  } else if (v === 'laps') {
    $('#leftNote').textContent = 'Лучший круг каждого пилота';
    state.bestLaps.forEach((p, i) => row(i, p.driver_name, `${p.team} · круг ${p.lap}`, fmtLap(num(p.best_ms)), 'время', p.team));
  } else if (v === 'pits') {
    $('#leftNote').textContent = 'Самые быстрые стопы (до минуты)';
    state.bestPits.forEach((p, i) => row(i, p.driver_name, `${p.team} · круг ${p.lap}, стоп №${p.stop}`, (num(p.duration_ms) / 1000).toFixed(2), 'секунд', p.team));
  } else {
    $('#leftNote').textContent = 'Чемпионат пилотов после гонки';
    state.standings.slice(0, 5).forEach((p, i) => row(i, p.driver_name, `${p.team || ''} · побед ${num(p.wins)}`, String(num(p.points)), 'очков', p.team));
  }
  if (!ol.children.length) ol.append(h('li', { class: 'mu', text: 'Нет данных' }));
}

function renderNews() {
  const ul = $('#news'); ul.replaceChildren();
  const day = Date.now() - 24 * 3600 * 1000;
  const fresh = state.news.filter((n) => new Date(n.published_at).getTime() >= day);
  const list = fresh.length ? fresh : state.news.slice(0, 10);
  $('#newsNote').textContent = !state.news.length ? 'Новостей пока нет' : fresh.length ? 'За последние 24 часа' : 'За последние сутки новостей нет, показаны самые свежие';
  const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
  for (const n of list) {
    const hrs = Math.round((new Date(n.published_at).getTime() - Date.now()) / 3600000);
    const when = Math.abs(hrs) < 48 ? rtf.format(hrs, 'hour') : new Date(n.published_at).toLocaleDateString('ru-RU');
    const safe = /^https?:\/\//.test(n.url) ? n.url : null;           // только http(s)-ссылки
    ul.append(h('li', {}, h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: n.title }), h('span', { class: 'meta', text: `${n.source || 'Источник'} · ${when}` })));
  }
}

function renderAll() { renderHead(); renderFilters(); drawChart(); renderStats(); }
function setFilter(patch) {
  state.f = { ...state.f, ...patch };
  if (patch.team && !patch.driver) state.f.driver = 'all';
  renderAll();
}

/* ============================== Демо-данные (f1.html?demo=1) ============================== */
function demoData() {
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const teams = ['Red Bull', 'Ferrari', 'Mercedes', 'McLaren', 'Aston Martin', 'Alpine', 'Williams', 'Racing Bulls', 'Haas', 'Audi'];
  const N = 57, drivers = [];
  teams.forEach((t, ti) => [0, 1].forEach((k) => drivers.push({ id: `d${ti}${k}`, code: `${t.slice(0, 2).toUpperCase()}${k + 1}`.slice(0, 3), name: `Пилот ${t.split(' ')[0]} ${k + 1}`, team: t, pace: 91.0 + ti * 0.18 + k * 0.2 + rnd() * 0.15 })));
  const grid = [...drivers].sort((a, b) => a.pace - b.pace + gauss() * 0.15);
  grid.forEach((d, i) => { d.grid = i + 1; d.stops = [16 + Math.floor(rnd() * 8), 36 + Math.floor(rnd() * 8)].slice(0, rnd() < .3 ? 1 : 2); d.dnf = rnd() < .08 ? 20 + Math.floor(rnd() * 25) : null; });
  const laps = [], pits = [];
  drivers.forEach((d) => {
    let deg = 0;
    for (let lap = 1; lap <= N; lap++) {
      if (d.dnf && lap > d.dnf) break;
      let t = d.pace + deg * 0.045 + gauss() * 0.22 + (lap === 1 ? 6.5 : 0) + ((lap >= 22 && lap <= 24) ? 20 : 0);
      deg++;
      if (d.stops.includes(lap)) { t += 21.5 + rnd() * 2; deg = 0; pits.push({ driver_id: d.id, code: d.code, team: d.team, stop: d.stops.indexOf(lap) + 1, lap, duration_ms: Math.round((21.4 + rnd() * 2.6) * 1000) }); }
      laps.push({ driver_id: d.id, code: d.code, team: d.team, lap, lap_time_ms: Math.round(t * 1000), position: 0 });
    }
  });
  const cum = new Map(); drivers.forEach((d) => cum.set(d.id, 0));
  for (let lap = 1; lap <= N; lap++) {
    const cur = laps.filter((l) => l.lap === lap); cur.forEach((l) => { cum.set(l.driver_id, cum.get(l.driver_id) + l.lap_time_ms); l.cum = cum.get(l.driver_id); });
    [...cur].sort((a, b) => a.cum - b.cum).forEach((l, i) => { l.position = i + 1; });
  }
  const finish = new Map(laps.filter((l) => l.lap === N).sort((a, b) => a.position - b.position).map((l, i) => [l.driver_id, i + 1]));
  const results = [...drivers].sort((a, b) => (finish.get(a.id) || 99) - (finish.get(b.id) || 99)).map((d, i) => ({
    driver_id: d.id, code: d.code, driver_name: d.name, team: d.team, grid: d.grid, position: finish.get(d.id) || null, position_text: finish.get(d.id) ? String(finish.get(d.id)) : 'R',
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1][i] || 0, laps: d.dnf || N, status: d.dnf ? 'Retired' : 'Finished' }));
  const dnfIds = new Set(drivers.filter((d) => d.dnf).map((d) => d.id));
  results.forEach((r) => { if (dnfIds.has(r.driver_id)) r.position = null; });
  const race = { season: 2026, round: 17, race_name: 'Демо Гран-при', race_date: '2026-10-04', circuit_name: 'Demo Circuit', locality: 'Город', country: 'Страна', total_laps: N };
  const best = laps.reduce((m, l) => { if (l.lap > 1 && (!m[l.driver_id] || l.lap_time_ms < m[l.driver_id].best_ms)) m[l.driver_id] = { driver_id: l.driver_id, best_ms: l.lap_time_ms, lap: l.lap }; return m; }, {});
  const byId = new Map(results.map((r) => [r.driver_id, r]));
  const bestLaps = Object.values(best).sort((a, b) => a.best_ms - b.best_ms).slice(0, 5).map((b) => ({ ...b, driver_name: byId.get(b.driver_id).driver_name, team: byId.get(b.driver_id).team }));
  const bestPits = [...pits].sort((a, b) => a.duration_ms - b.duration_ms).slice(0, 5).map((p) => ({ ...p, driver_name: byId.get(p.driver_id).driver_name }));
  const top = results.filter((r) => r.position).slice(0, 5).map((r) => ({ ...r, gained: r.grid - r.position }));
  const standings = results.slice(0, 5).map((r, i) => ({ position: i + 1, points: 240 - i * 17, wins: 5 - i, driver_name: r.driver_name, team: r.team, code: r.code }));
  const now = Date.now();
  const news = [['Команда подтвердила состав на следующий этап', 'Formula1.com', 3], ['Пилот получил штраф после гонки', 'Autosport', 7], ['Регламент 2027: что решили на совещании', 'ESPN', 15]]
    .map(([title, source, hrs]) => ({ title, source, url: 'https://example.com/', published_at: new Date(now - hrs * 3600000).toISOString() }));
  return { race, results, laps, pits, top, bestLaps, bestPits, standings, news };
}

/* ============================== Запуск ============================== */
async function init() {
  document.querySelectorAll('#modes button').forEach((b) => b.onclick = () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('#modes button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    drawChart();
  });
  document.querySelectorAll('#leftTabs button').forEach((b) => b.onclick = () => { state.leftView = b.dataset.view; renderLeft(); });
  $('#fTeam').onchange = (e) => setFilter({ team: e.target.value });
  $('#fDriver').onchange = (e) => setFilter({ driver: e.target.value });
  $('#fReset').onclick = () => { state.f = { team: 'all', driver: 'all' }; renderAll(); };

  if (DEMO) {
    Object.assign(state, demoData());
    $('.head .lbl').textContent = 'Спорт · Формула 1 · демо-данные';
  } else {
    const jobs = { race: 'v_f1_last_race', results: 'v_f1_last_results', laps: 'v_f1_last_laps', pits: 'v_f1_last_pitstops', top: 'v_f1_top_drivers',
      bestLaps: 'v_f1_best_laps', bestPits: 'v_f1_best_pitstops', standings: 'v_f1_standings', news: 'v_f1_news' };
    const res = await Promise.allSettled(Object.values(jobs).map((v) => rest(v)));   // блоки грузятся независимо
    Object.keys(jobs).forEach((k, i) => { if (res[i].status === 'fulfilled') state[k] = res[i].value; else console.error(res[i].reason); });
    state.race = state.race[0] || null;
    const failed = Object.keys(jobs).filter((_, i) => res[i].status === 'rejected');
    if (failed.length) $('#subtitle').after(h('p', { class: 'error', text: `Не удалось загрузить: ${failed.join(', ')}. Проверьте sql/f1_views.sql и права anon.` }));
  }
  renderAll(); renderLeft(); renderNews();
}
init();
