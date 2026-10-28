'use strict';

/* ============================== Настройки ============================== */
const CFG = {
  url: 'https://xqqeiigpamtegingzjda.supabase.co',
  // anon-ключ публичный по замыслу: он даёт только то, что разрешено grant select на view
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M',
};
// Геометрия площадки в координатах Basketball-Reference: 10 px = 1 фут, кольцо около (250, 52).
// Если карта выглядит сдвинутой, проверьте калибровку запросом из sql/nba_views.sql и поправьте bx, by.
const COURT = { w: 500, h: 470, bx: 250, by: 52 };
// Видимая область = поле + поля вокруг него. Она расширяется под данные, чтобы броски на краю и за линиями не пропадали.
const VIEW = { x0: -28, y0: -28, w: COURT.w + 56, h: COURT.h + 56 };
const SCALE = 2;                                   // разрешение canvas: 2 пикселя на единицу координат
// Параметры плавности карты: сигма размытия (в координатах площадки) и шаг расчётной сетки
const HEAT = { cell: 4, sigmaDensity: 15, sigmaEff: 22, prior: 2.2 };
const ZONES = [
  { label: '0–3 фт', min: 0, max: 4 }, { label: '4–9 фт', min: 4, max: 10 },
  { label: '10–15 фт', min: 10, max: 16 }, { label: '16–22 фт', min: 16, max: 23 },
  { label: '23+ фт', min: 23, max: Infinity },
];
const DEMO = new URLSearchParams(location.search).has('demo');

const state = {
  games: [], shots: [], top: [], lineups: [], news: [], teamAssets: [], playerAssets: [],
  teamLogo: new Map(), photos: new Map(),
  f: { game: 'all', team: 'all', player: 'all', quarter: 'all' },
  mode: 'dots', leftView: 'players',
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
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const share = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '—');
const num = (v) => Number(v) || 0;
const quarterLabel = (q) => (Number(q) <= 4 ? `${q}-я четверть` : `Овертайм ${q - 4}`);
const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

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

/* ============================== Логотипы и фото ============================== */
/** Логотип команды. Если ссылки нет или она не открылась, показывается короткий значок с кодом команды. */
function teamLogo(abbr, size = 20) {
  const badge = () => h('span', { class: 'tbadge', text: String(abbr || '?').slice(0, 3) });
  const url = state.teamLogo.get(abbr);
  if (!url) return badge();
  const img = h('img', { class: 'tlogo', src: url, alt: '', width: size, height: size, loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(badge()), { once: true });
  return img;
}
/** Фото игрока. Нет фото или не загрузилось: круг с инициалами. */
function avatar(pid, name, cls = '') {
  const fallback = () => h('span', { class: `avatar initials ${cls}`.trim(), text: initials(name) });
  const url = state.photos.get(pid)?.url;
  if (!url) return fallback();
  const img = h('img', { class: `avatar ${cls}`.trim(), src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/* ============================== Подсказки ============================== */
const tt = h('div', { class: 'tt', role: 'tooltip', hidden: true });
document.body.append(tt);
let ttTarget = null;
function placeTip(x, y) {
  const w = tt.offsetWidth, hh = tt.offsetHeight;
  let left = x + 14, top = y + 16;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top + hh > innerHeight - 8) top = y - hh - 14;
  tt.style.left = Math.max(8, left) + 'px'; tt.style.top = Math.max(8, top) + 'px';
}
function showTip(el, x, y) {
  ttTarget = el; tt.textContent = el.dataset.tip; tt.hidden = false;
  if (x == null) { const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.bottom; }
  placeTip(x, y);
}
function hideTip() { ttTarget = null; tt.hidden = true; }
document.addEventListener('mouseover', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) { if (el !== ttTarget) showTip(el, e.clientX, e.clientY); } else hideTip(); });
document.addEventListener('mousemove', (e) => { if (ttTarget && !tt.hidden) placeTip(e.clientX, e.clientY); });
document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
document.addEventListener('scroll', hideTip, true);

/* Определения показателей для подсказок */
const GLOSS = {
  'FG%': 'Процент попаданий с игры: попадания ÷ броски.',
  '3P%': 'Точность трёхочковых: попадания ÷ попытки трёхочковых.',
  'eFG%': 'Эффективный FG%. Трёхочковое попадание стоит в 1,5 раза больше двухочкового, поэтому оно считается с весом 1,5.\n(попадания + 0,5 × трёхочковые попадания) ÷ броски',
  'Очки/бросок': 'Сколько очков с игры приносит один бросок (штрафные не учитываются).',
  'Дистанция': 'Средняя дистанция бросков в футах (1 фут ≈ 30 см).',
};

/* ============================== Статистика ============================== */
function summarize(arr) {
  let m = 0, t3 = 0, t3m = 0, pts = 0, dist = 0;
  for (const s of arr) {
    const val = num(s.shot_value);
    if (s.is_made) { m++; pts += val; if (val === 3) t3m++; }
    if (val === 3) t3++;
    dist += num(s.distance_ft);
  }
  const n = arr.length;
  return { n, m, t3, t3m, pts, fg: n ? m / n : null, tp: t3 ? t3m / t3 : null,
           efg: n ? (m + 0.5 * t3m) / n : null, pps: n ? pts / n : null, avgd: n ? dist / n : null };
}

function filteredShots(skip = []) {
  const f = state.f;
  return state.shots.filter((s) =>
    (skip.includes('game') || f.game === 'all' || s.game_id === f.game) &&
    (skip.includes('team') || f.team === 'all' || s.team_abbr === f.team) &&
    (skip.includes('player') || f.player === 'all' || s.player_id === f.player) &&
    (skip.includes('quarter') || f.quarter === 'all' || String(s.quarter) === f.quarter));
}

/* ============================== Карта бросков ============================== */
const canvas = $('#heat');
const ctx = canvas.getContext('2d');
const gx2px = (x) => (x - VIEW.x0) * SCALE;
const gy2px = (y) => (y - VIEW.y0) * SCALE;

/** Подгоняет видимую область под данные: бросок у края или за линией не должен обрезаться. */
function fitView(shots) {
  // Жестко фиксируем симметричную площадку 500x470 с небольшими рамками 28px по краям
  Object.assign(VIEW, { x0: -28, y0: -28, w: COURT.w + 56, h: COURT.h + 56 });
  canvas.width = Math.round(VIEW.w * SCALE); 
  canvas.height = Math.round(VIEW.h * SCALE);
  $('#court').style.setProperty('--ar', (VIEW.w / VIEW.h).toFixed(4));
  $('#court svg').setAttribute('viewBox', `${VIEW.x0} ${VIEW.y0} ${VIEW.w} ${VIEW.h}`);
}

/**
 * Оценка плотности ядром Гаусса: каждый бросок «размазывается» по соседним клеткам в его настоящих координатах.
 * Возвращает суммарный вес (sc) и сумму набранных очков (sp) на мелкой сетке.
 */
function kde(arr, sigmaPx) {
  const cell = HEAT.cell, gw = Math.ceil(VIEW.w / cell), gh = Math.ceil(VIEW.h / cell);
  const sig = sigmaPx / cell, R = Math.ceil(sig * 3);
  const k = []; for (let d = -R; d <= R; d++) k.push(Math.exp(-(d * d) / (2 * sig * sig)));
  const sc = new Float32Array(gw * gh), sp = new Float32Array(gw * gh);
  for (const s of arr) {
    const gx = Math.round((num(s.coord_x) - VIEW.x0) / cell), gy = Math.round((num(s.coord_y) - VIEW.y0) / cell);
    if (gx < -R || gx > gw + R || gy < -R || gy > gh + R) continue;
    const val = s.is_made ? num(s.shot_value) : 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = gy + dy; if (yy < 0 || yy >= gh) continue;
      const wy = k[dy + R];
      for (let dx = -R; dx <= R; dx++) {
        const xx = gx + dx; if (xx < 0 || xx >= gw) continue;
        const w = wy * k[dx + R], i = yy * gw + xx;
        sc[i] += w; sp[i] += w * val;
      }
    }
  }
  return { gw, gh, sc, sp };
}

const RAMP = [[0, [43, 108, 176]], [0.35, [77, 163, 255]], [0.6, [61, 220, 151]], [0.8, [255, 176, 32]], [1, [255, 92, 138]]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
    const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i], u = (t - t0) / (t1 - t0);
    return c0.map((c, j) => c + (c1[j] - c) * u);
  }
  return RAMP[RAMP.length - 1][1];
}
const smooth = (t) => t * t * (3 - 2 * t);                       // smoothstep: мягкое появление и затухание краёв

function drawMap() {
  const arr = filteredShots();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('#mapEmpty').hidden = arr.length > 0;
  canvas.setAttribute('aria-label', `Карта бросков, ${arr.length} бросков`);
  if (!arr.length) return renderLegend();

  if (state.mode === 'dots') {
    for (const s of arr) {
      const x = gx2px(num(s.coord_x)), y = gy2px(num(s.coord_y));
      ctx.lineWidth = 2.5;
      if (s.is_made) { ctx.strokeStyle = 'rgba(61,220,151,.95)'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke(); }
      else { ctx.strokeStyle = 'rgba(255,92,138,.8)'; ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke(); }
    }
    return renderLegend();
  }

  const eff = state.mode === 'eff';
  const { gw, gh, sc, sp } = kde(arr, eff ? HEAT.sigmaEff : HEAT.sigmaDensity);
  let max = 0; for (const v of sc) if (v > max) max = v;
  const avg = summarize(arr).pps || 1;                           // средняя отдача выбранных бросков: точка отсчёта для эффективности
  const off = document.createElement('canvas'); off.width = gw; off.height = gh;
  const octx = off.getContext('2d'), img = octx.createImageData(gw, gh);
  for (let i = 0; i < gw * gh; i++) {
    const c = sc[i], d = c / max;
    if (d < 0.015) continue;
    let rgb, a;
    if (!eff) { rgb = ramp(Math.pow(d, 0.85)); a = smooth(Math.min(1, d / 0.35)) * 0.92; }
    else { const pps = (sp[i] + HEAT.prior * avg) / (c + HEAT.prior); rgb = ramp(0.5 + (pps - avg) / (avg * 1.1)); a = smooth(Math.min(1, d / 0.3)) * 0.92; }
    img.data.set([rgb[0], rgb[1], rgb[2], Math.round(a * 255)], i * 4);
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = 'blur(3px)';                 // дополнительное сглаживание там, где браузер умеет
  ctx.drawImage(off, 0, 0, gw * HEAT.cell * SCALE, gh * HEAT.cell * SCALE);
  if ('filter' in ctx) ctx.filter = 'none';
  renderLegend();
}

function renderLegend() {
  const box = $('#legend'); box.replaceChildren();
  if (state.mode === 'dots') { box.append(h('span', { text: '○ попадание' }), h('span', { text: '✕ промах' })); return; }
  const bar = h('span', { class: 'bar' });
  bar.style.background = `linear-gradient(90deg, ${[0, .2, .4, .6, .8, 1].map((t) => `rgb(${ramp(t).map(Math.round).join()})`).join(', ')})`;
  const [lo, hi] = state.mode === 'density' ? ['реже', 'чаще'] : ['хуже среднего', 'лучше среднего'];
  box.append(h('span', { text: lo }), bar, h('span', { text: hi }));
}

/* ============================== Блоки ============================== */
function renderSubtitle() {
  const d = state.games[0]?.game_date;
  if (!d) { $('#subtitle').textContent = 'Нет данных об играх'; return; }
  const [y, m, day] = d.split('-').map(Number);
  const label = new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('#subtitle').textContent = `Последний игровой день: ${label.replace(/\s*г\.$/, '')} г. Матчей: ${state.games.length}, бросков: ${state.shots.length}.`;
}

function renderResults() {
  const box = $('#results'); box.replaceChildren();
  
  // Явно передаем 'true' или 'false' текстом
  const all = h('button', { type: 'button', class: 'chip-game all', 'aria-pressed': state.f.game === 'all' ? 'true' : 'false', text: 'Все матчи' });
  all.onclick = () => setFilter('game', 'all');
  box.append(all);
  
  for (const g of state.games) {
    const hw = num(g.home_pts) > num(g.visitor_pts);
    const line = (abbr, pts, win) => h('span', { class: `tm ${win ? 'win' : 'lose'}` }, teamLogo(abbr), h('span', { class: 'ab', text: abbr }), h('b', { text: pts }));
    
    // Здесь тоже заменяем булево значение на строку
    const btn = h('button', { 
        type: 'button', 
        class: 'chip-game', 
        'aria-pressed': state.f.game === g.game_id ? 'true' : 'false', 
        'aria-label': `${g.visitor_abbr} ${g.visitor_pts}, ${g.home_abbr} ${g.home_pts}` 
      },
      line(g.visitor_abbr, g.visitor_pts, !hw), line(g.home_abbr, g.home_pts, hw)
    );
    btn.onclick = () => setFilter('game', g.game_id);
    box.append(btn);
  }
}

function fillSelect(id, options, value) {
  const el = $(id); el.replaceChildren();
  for (const [v, label] of options) el.append(h('option', { value: v, text: label }));
  el.value = options.some(([v]) => v === value) ? value : options[0][0];
  return el.value;
}

function renderFilters() {
  const f = state.f;
  fillSelect('#fGame', [['all', 'Все матчи'], ...state.games.map((g) => [g.game_id, `${g.visitor_abbr} @ ${g.home_abbr}`])], f.game);
  const teams = [...new Set(filteredShots(['team', 'player', 'quarter']).map((s) => s.team_abbr))].sort();
  f.team = fillSelect('#fTeam', [['all', 'Все'], ...teams.map((t) => [t, t])], f.team);
  const pl = new Map();
  for (const s of filteredShots(['player', 'quarter'])) {
    const p = pl.get(s.player_id) || { name: s.player_name, n: 0 }; p.n++; pl.set(s.player_id, p);
  }
  const players = [...pl].sort((a, b) => b[1].n - a[1].n);
  f.player = fillSelect('#fPlayer', [['all', 'Все'], ...players.map(([id, p]) => [id, `${p.name} (${p.n})`])], f.player);
  const qs = [...new Set(state.shots.map((s) => num(s.quarter)))].sort((a, b) => a - b);
  f.quarter = fillSelect('#fQuarter', [['all', 'Все'], ...qs.map((q) => [String(q), quarterLabel(q)])], f.quarter);
}

/** Строка «Выборка: ...» с логотипами команд выбранного матча или команды. */
function renderSelLabel() {
  const f = state.f, g = state.games.find((x) => x.game_id === f.game), box = $('#selLabel');
  box.replaceChildren('Выборка:');
  if (f.team !== 'all') box.append(teamLogo(f.team, 18), f.team);
  else if (g) box.append(teamLogo(g.visitor_abbr, 18), `${g.visitor_abbr} @ ${g.home_abbr}`, teamLogo(g.home_abbr, 18));
  else box.append('все матчи');
  if (f.player !== 'all') box.append(`· ${state.shots.find((s) => s.player_id === f.player)?.player_name || f.player}`);
  if (f.quarter !== 'all') box.append(`· ${quarterLabel(f.quarter)}`);
}

/** Карточка игрока: появляется в правом блоке только когда выбран конкретный игрок. */
function renderPlayerCard() {
  const box = $('#playerCard'), pid = state.f.player;
  if (pid === 'all') { box.hidden = true; box.replaceChildren(); return; }
  const sample = state.shots.find((s) => s.player_id === pid);
  const name = sample?.player_name || state.photos.get(pid)?.name || pid;
  const s = summarize(filteredShots());
  box.replaceChildren(avatar(pid, name, 'lg'), h('div', {}, h('b', { text: name }),
    h('div', { class: 'meta' }, sample ? teamLogo(sample.team_abbr, 16) : null, sample?.team_abbr || '', h('span', { text: `· ${s.n} бросков · FG% ${pct(s.fg)}` }))));
  box.hidden = false;
}

function renderStats() {
  hideTip();
  const arr = filteredShots(), s = summarize(arr), N = arr.length;
  renderSelLabel(); renderPlayerCard();

  const kpis = [
    ['Попад. / броски', `${s.m}/${s.n}`, `Попадания и все броски выборки.\n${s.m} попаданий, ${s.n - s.m} промахов.`],
    ['FG%', pct(s.fg), `${GLOSS['FG%']}\n${s.m} ÷ ${s.n}`],
    ['3P%', pct(s.tp), `${GLOSS['3P%']}\n${s.t3m} из ${s.t3}`],
    ['eFG%', pct(s.efg), `${GLOSS['eFG%']}\n(${s.m} + 0,5 × ${s.t3m}) ÷ ${s.n}`.replace('GLOSS.eFG%', '')],
    ['Очки / бросок', fmt(s.pps, 2), `${GLOSS['Очки/бросок']}\n${s.pts} очков с ${s.n} бросков`],
    ['Дистанция, фт', s.avgd == null ? '—' : fmt(s.avgd, 1), GLOSS['Дистанция']],
  ];
  $('#kpis').replaceChildren(...kpis.map(([l, v, tip]) => h('div', { class: 'kpi', tabindex: 0, 'data-tip': tip }, h('div', { class: 'v', text: String(v) }), h('div', { class: 'l', text: l }))));

  const th = (label, tip) => h('th', { text: label, 'data-tip': tip });
  const zt = $('#zones'); zt.replaceChildren(h('thead', {}, h('tr', {},
    th('Зона', 'Расстояние от кольца до места броска. Полоска под названием показывает долю зоны во всех бросках выборки.'),
    th('Броски', 'Количество бросков из зоны.'), th('FG%', GLOSS['FG%']), th('Оч/бр', GLOSS['Очки/бросок']))));
  const zb = h('tbody');
  for (const z of ZONES) {
    const zs = summarize(arr.filter((x) => num(x.distance_ft) >= z.min && num(x.distance_ft) < z.max));
    const frac = N ? zs.n / N : 0;
    zb.append(h('tr', {},
      h('td', { 'data-tip': `${z.label}: ${zs.n} из ${N} бросков (${share(zs.n, N)} выборки)` }, z.label, h('span', { class: 'share' }, h('i', { style: `width:${(frac * 100).toFixed(0)}%` }))),
      h('td', { class: 'mono', text: String(zs.n), 'data-tip': `${zs.n} бросков: ${zs.m} попаданий, ${zs.n - zs.m} промахов` }),
      h('td', { class: 'mono', text: pct(zs.fg), 'data-tip': zs.n ? `${zs.m} попаданий из ${zs.n} бросков` : 'Бросков из этой зоны нет' }),
      h('td', { class: 'mono', text: fmt(zs.pps, 2), 'data-tip': zs.n ? `${zs.pts} очков с ${zs.n} бросков` : 'Бросков из этой зоны нет' })));
  }
  zt.append(zb);

  const by = new Map();
  for (const x of arr) { if (!by.has(x.player_id)) by.set(x.player_id, { name: x.player_name, team: x.team_abbr, rows: [] }); by.get(x.player_id).rows.push(x); }
  const rows = [...by.values()].map((p) => ({ ...p, s: summarize(p.rows) })).sort((a, b) => b.s.n - a.s.n).slice(0, 8);
  const pt = $('#players'); pt.replaceChildren(h('thead', {}, h('tr', {},
    th('Игрок', 'Игроки выборки с наибольшим числом бросков (не более восьми).'), th('Бр.', 'Количество бросков.'), th('FG%', GLOSS['FG%']), th('eFG%', GLOSS.eFG))));
  const pb = h('tbody');
  for (const p of rows) pb.append(h('tr', {},
    h('td', { 'data-tip': `${p.name} (${p.team})\n${p.s.m} попаданий из ${p.s.n} бросков` }, h('span', { class: 'who' }, h('span', {}, teamLogo(p.team, 16), p.name))),
    h('td', { class: 'mono', text: String(p.s.n), 'data-tip': `${p.s.n} бросков, ${share(p.s.n, N)} выборки` }),
    h('td', { class: 'mono', text: pct(p.s.fg), 'data-tip': `${p.s.m} из ${p.s.n}` }),
    h('td', { class: 'mono', text: pct(p.s.efg), 'data-tip': `(${p.s.m} + 0,5 × ${p.s.t3m}) ÷ ${p.s.n}\nТрёхочковые: ${p.s.t3m} из ${p.s.t3}` })));
  if (!rows.length) pb.append(h('tr', {}, h('td', { colspan: 4, text: 'Нет данных' })));
  pt.append(pb);
}

/** Левая панель: лучшие игроки (с фото) и лучшие связки (с фото участников). */
function renderLeft() {
  // Скрываем блок с кнопками вкладок, так как вкладка теперь одна
  const tabs = $('#leftTabs');
  if (tabs) tabs.hidden = true;

  const ol = $('#leftList'); ol.replaceChildren();
  const meta = (abbr, text) => h('span', {}, teamLogo(abbr, 16), h('span', { text }));
  
  $('#leftNote').textContent = 'Очки + передачи − потери за ночь';
  
  if (!state.top.length) return ol.append(h('li', { class: 'mu', text: 'Нет данных' }));
  
  state.top.forEach((p, i) => ol.append(h('li', { class: 'has-avatar' },
    h('span', { class: 'rank', text: i + 1 }), avatar(p.player_id, p.player_name),
    h('div', { class: 'who' }, h('b', { text: p.player_name }), meta(p.team_abbr, `${num(p.pts)} оч · ${num(p.ast)} аст · ${num(p.tov)} пот`)),
    h('div', { class: 'score' }, String(num(p.score)), h('small', { text: 'баллов' }))
  )));
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

function renderAll() { renderResults(); renderFilters(); drawMap(); renderStats(); }
function setFilter(key, value) {
  state.f[key] = value;
  if (key === 'game') { state.f.team = 'all'; state.f.player = 'all'; }
  if (key === 'team') state.f.player = 'all';
  renderAll();
}

/* ============================== Демо-данные (sport.html?demo=1) ============================== */
function svgUri(svg) { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); }
function demoLogo(abbr, hue) { return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="hsl(${hue},55%,40%)"/><text x="20" y="25" font-family="sans-serif" font-size="13" font-weight="700" text-anchor="middle" fill="#fff">${abbr}</text></svg>`); }
function demoPhoto(name, hue) { return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 190"><rect width="260" height="190" fill="hsl(${hue},30%,22%)"/><circle cx="130" cy="78" r="38" fill="hsl(${hue},25%,62%)"/><path d="M50 190c8-48 40-62 80-62s72 14 80 62z" fill="hsl(${hue},25%,48%)"/></svg>`); }

function demoData() {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const pairs = [['LAL', 'DEN', 118, 112], ['BOS', 'NYK', 104, 109], ['GSW', 'OKC', 121, 99]];
  const games = [], shots = [], teamAssets = [], playerAssets = [];
  let id = 1;
  pairs.forEach(([v, hm, vp, hp], gi) => {
    const gid = `20251225${gi}${hm}`;
    games.push({ game_id: gid, game_date: '2025-12-25', visitor_abbr: v, home_abbr: hm, visitor_pts: vp, home_pts: hp });
    [v, hm].forEach((team) => {
      for (let n = 0; n < 85; n++) {
        const r = rnd(); let x, y, val = 2;
        if (r < 0.34) { x = COURT.bx + gauss() * 18; y = COURT.by + Math.abs(gauss()) * 22; }
        else if (r < 0.5) { x = COURT.bx + gauss() * 55; y = COURT.by + 80 + rnd() * 70; }
        else if (r < 0.6) { x = COURT.bx + gauss() * 80; y = COURT.by + 130 + rnd() * 40; }
        else if (r < 0.68) { x = rnd() < .5 ? 30 : 470; y = 5 + rnd() * 130; val = 3; }
        else { const a = (22 + rnd() * 136) * Math.PI / 180; x = COURT.bx + 237.5 * Math.cos(a); y = COURT.by + 237.5 * Math.sin(a); val = 3; }
        const dist = Math.hypot(x - COURT.bx, y - COURT.by) / 10;
        const made = rnd() < (val === 3 ? 0.36 : dist < 4 ? 0.62 : 0.42);
        const pn = 1 + Math.floor(rnd() * rnd() * 6);
        shots.push({ shot_id: id++, game_id: gid, team_abbr: team, player_id: `${team}${pn}`.toLowerCase(), player_name: `Игрок ${team}-${pn}`,
          quarter: 1 + Math.floor(rnd() * 4), coord_x: x, coord_y: y, is_made: made, shot_value: val, distance_ft: dist });
      }
    });
  });
  // крайние броски: у самой линии, за боковой линией и из-за средней линии (проверка, что они видны)
  [[-14, 6, 2], [512, 12, 2], [250, 478, 3], [488, 468, 3], [4, 4, 2]].forEach(([x, y, val], k) => shots.push({ shot_id: id++, game_id: games[0].game_id, team_abbr: 'LAL', player_id: 'lal1', player_name: 'Игрок LAL-1', quarter: 4, coord_x: x, coord_y: y, is_made: k % 2 === 0, shot_value: val, distance_ft: Math.hypot(x - COURT.bx, y - COURT.by) / 10 }));
  const teams = [...new Set(games.flatMap((g) => [g.visitor_abbr, g.home_abbr]))];
  teams.forEach((t, i) => teamAssets.push({ team_id: t, logo_url: demoLogo(t, 30 + i * 50) }));
  const names = new Map(shots.map((s) => [s.player_id, s.player_name]));
  [...names].forEach(([pid, nm], i) => playerAssets.push({ player_id: pid, player_name: nm, photo_url: demoPhoto(nm, 200 + (i * 37) % 160) }));
  const top = [['lal1', 'Игрок LAL-1', 'LAL', 34, 11, 3], ['bos1', 'Игрок BOS-1', 'BOS', 29, 9, 2], ['den2', 'Игрок DEN-2', 'DEN', 27, 12, 4], ['gsw1', 'Игрок GSW-1', 'GSW', 31, 6, 2], ['nyk1', 'Игрок NYK-1', 'NYK', 28, 7, 3]]
    .map(([player_id, player_name, team_abbr, pts, ast, tov]) => ({ player_id, player_name, team_abbr, pts, ast, tov, score: pts + ast - tov })).sort((a, b) => b.score - a.score);
  const lineups = [], pool = ['lal1', 'lal2', 'lal3', 'bos1', 'bos2', 'den1', 'den2', 'gsw1', 'gsw2', 'nyk1'];
  [2, 3].forEach((size) => ['LAL', 'BOS', 'GSW', 'DEN', 'NYK'].forEach((t, i) => lineups.push({ team_abbr: t, lineup_type: size, minutes_played: 600 - i * 70, plus_minus: 120 - i * 18, pts_per_100_poss: 128 - i * 3.1 - size,
    lineup: Array.from({ length: size }, (_, k) => `Игрок${k + 1}`).join(' / '), player_ids: Array.from({ length: size }, (_, k) => pool[(i * 2 + k) % pool.length]) })));
  const now = Date.now();
  const news = [['Тренер объявил состав на следующую игру', 'ESPN', 2], ['Лидер лиги по передачам пропустит матч из-за травмы', 'CBS Sports', 5], ['Клубы обсуждают обмен перед дедлайном', 'ESPN', 9], ['Новичок обновил рекорд по очкам', 'CBS Sports', 20]]
    .map(([title, source, hrs]) => ({ title, source, url: 'https://example.com/', published_at: new Date(now - hrs * 3600000).toISOString() }));
  return { games, shots, top, lineups, news, teamAssets, playerAssets };
}

/* ============================== Запуск ============================== */
async function init() {
  document.querySelectorAll('#modes button').forEach((b) => b.onclick = () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('#modes button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    drawMap();
  });
  document.querySelectorAll('#leftTabs button').forEach((b) => b.onclick = () => { state.leftView = b.dataset.view; renderLeft(); });
  $('#fGame').onchange = (e) => setFilter('game', e.target.value);
  $('#fTeam').onchange = (e) => setFilter('team', e.target.value);
  $('#fPlayer').onchange = (e) => setFilter('player', e.target.value);
  $('#fQuarter').onchange = (e) => setFilter('quarter', e.target.value);
  $('#fReset').onclick = () => { state.f = { game: 'all', team: 'all', player: 'all', quarter: 'all' }; renderAll(); };

  if (DEMO) {
    Object.assign(state, demoData());
  } else {
    // блоки грузятся независимо: сбой одного не ломает остальные
    const jobs = { games: 'v_nba_last_games', shots: 'v_nba_last_shots', top: 'v_nba_top_players', news: 'v_nba_news' };
    const optional = { teamAssets: 'v_nba_team_assets', playerAssets: 'v_nba_player_assets' };   // логотипы и фото: без них страница работает
    const res = await Promise.allSettled([...Object.values(jobs), ...Object.values(optional)].map((v) => rest(v)));
    [...Object.keys(jobs), ...Object.keys(optional)].forEach((k, i) => {
      if (res[i].status === 'fulfilled') state[k] = res[i].value; else console.error(res[i].reason);
    });
    const failed = Object.keys(jobs).filter((_, i) => res[i].status === 'rejected');
    if (failed.length) $('#subtitle').after(h('p', { class: 'error', text: `Не удалось загрузить: ${failed.join(', ')}. Проверьте sql/nba_views.sql и права anon.` }));
    if (res.slice(Object.keys(jobs).length).some((r) => r.status === 'rejected')) console.warn('Логотипы и фото недоступны: выполните sql/nba_assets.sql и команду assets.');
  }
  state.teamLogo = new Map(state.teamAssets.map((r) => [r.team_id, r.logo_url]));
  state.photos = new Map(state.playerAssets.map((r) => [r.player_id, { url: r.photo_url, name: r.player_name }]));
  fitView(state.shots);

if (state.games && state.games.length > 0) {
    state.f.game = state.games[0].game_id;
  }

  renderSubtitle(); renderAll(); renderLeft(); renderNews();




}




init();
