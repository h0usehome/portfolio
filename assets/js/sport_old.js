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
// Параметры плавности карты: сигма размытия в координатах площадки (px) и шаг расчётной сетки
const HEAT = { cell: 4, sigmaDensity: 15, sigmaEff: 22, prior: 2.2 };
const ZONES = [
  { label: '0–3 фт', min: 0, max: 4 }, { label: '4–9 фт', min: 4, max: 10 },
  { label: '10–15 фт', min: 10, max: 16 }, { label: '16–22 фт', min: 16, max: 23 },
  { label: '23+ фт', min: 23, max: Infinity },
];
const DEMO = new URLSearchParams(location.search).has('demo');

const state = {
  games: [], shots: [], top: [], lineups: [], news: [],
  f: { game: 'all', team: 'all', player: 'all', quarter: 'all' },
  mode: 'density', leftView: 'players',
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
const num = (v) => Number(v) || 0;
const quarterLabel = (q) => (Number(q) <= 4 ? `${q}-я четверть` : `Овертайм ${q - 4}`);

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
  return { n, m, fg: n ? m / n : null, t3, t3m, tp: t3 ? t3m / t3 : null,
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
const SCALE = canvas.width / COURT.w;

/**
 * Оценка плотности ядром Гаусса: каждый бросок «размазывается» по соседним клеткам в его настоящих координатах.
 * В отличие от суммирования по крупным клеткам, пятно получается плавным и не зависит от сетки.
 * Возвращает суммарный вес (sc) и сумму набранных очков (sp) на мелкой сетке.
 */
function kde(arr, sigmaPx) {
  const cell = HEAT.cell, gw = Math.ceil(COURT.w / cell), gh = Math.ceil(COURT.h / cell);
  const sig = sigmaPx / cell, R = Math.ceil(sig * 3);
  const k = []; for (let d = -R; d <= R; d++) k.push(Math.exp(-(d * d) / (2 * sig * sig)));
  const sc = new Float32Array(gw * gh), sp = new Float32Array(gw * gh);
  for (const s of arr) {
    const gx = Math.round(num(s.coord_x) / cell), gy = Math.round(num(s.coord_y) / cell);
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
      const x = num(s.coord_x) * SCALE, y = num(s.coord_y) * SCALE;
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
    if (!eff) {
      rgb = ramp(Math.pow(d, 0.85));
      a = smooth(Math.min(1, d / 0.35)) * 0.92;                  // край плавно уходит в прозрачность, без резкой границы
    } else {
      // сглаживание к среднему: в редких областях цвет не прыгает из-за пары бросков
      const pps = (sp[i] + HEAT.prior * avg) / (c + HEAT.prior);
      rgb = ramp(0.5 + (pps - avg) / (avg * 1.1));
      a = smooth(Math.min(1, d / 0.3)) * 0.92;
    }
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
  const all = h('button', { type: 'button', class: 'chip-game', 'aria-pressed': state.f.game === 'all', text: 'Все матчи' });
  all.onclick = () => setFilter('game', 'all');
  box.append(all);
  for (const g of state.games) {
    const hw = num(g.home_pts) > num(g.visitor_pts);
    const btn = h('button', { type: 'button', class: 'chip-game', 'aria-pressed': state.f.game === g.game_id },
      h('span', { class: hw ? 'lose' : 'win', text: g.visitor_abbr }), h('b', { class: hw ? 'lose' : 'win', text: g.visitor_pts }),
      h('span', { text: '–' }),
      h('b', { class: hw ? 'win' : 'lose', text: g.home_pts }), h('span', { class: hw ? 'win' : 'lose', text: g.home_abbr }));
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

function selectionLabel() {
  const f = state.f, g = state.games.find((x) => x.game_id === f.game);
  const parts = [g ? `${g.visitor_abbr} @ ${g.home_abbr}` : 'Все матчи'];
  if (f.team !== 'all') parts.push(f.team);
  if (f.player !== 'all') parts.push(state.shots.find((s) => s.player_id === f.player)?.player_name || f.player);
  if (f.quarter !== 'all') parts.push(quarterLabel(f.quarter));
  return parts.join(' · ');
}

function renderStats() {
  const arr = filteredShots(), s = summarize(arr);
  $('#selLabel').textContent = `Выборка: ${selectionLabel()}`;
  const kpis = [['Попад. / броски', `${s.m}/${s.n}`], ['FG%', pct(s.fg)], ['3P%', pct(s.tp)], ['eFG%', pct(s.efg)], ['Очки / бросок', fmt(s.pps, 2)], ['Дистанция, фт', s.avgd == null ? '—' : fmt(s.avgd, 1)]];
  $('#kpis').replaceChildren(...kpis.map(([l, v]) => h('div', { class: 'kpi' }, h('div', { class: 'v', text: String(v) }), h('div', { class: 'l', text: l }))));

  const zt = $('#zones'); zt.replaceChildren(h('thead', {}, h('tr', {}, ...['Зона', 'Броски', 'FG%', 'Оч/бр'].map((t) => h('th', { text: t })))));
  const zb = h('tbody');
  for (const z of ZONES) {
    const zs = summarize(arr.filter((x) => num(x.distance_ft) >= z.min && num(x.distance_ft) < z.max));
    const share = arr.length ? zs.n / arr.length : 0;
    const first = h('td', {}, z.label, h('span', { class: 'share' }, h('i', { style: `width:${(share * 100).toFixed(0)}%` })));
    zb.append(h('tr', {}, first, h('td', { class: 'mono', text: String(zs.n) }), h('td', { class: 'mono', text: pct(zs.fg) }), h('td', { class: 'mono', text: fmt(zs.pps, 2) })));
  }
  zt.append(zb);

  const by = new Map();
  for (const x of arr) { if (!by.has(x.player_id)) by.set(x.player_id, { name: x.player_name, team: x.team_abbr, rows: [] }); by.get(x.player_id).rows.push(x); }
  const rows = [...by.values()].map((p) => ({ ...p, s: summarize(p.rows) })).sort((a, b) => b.s.n - a.s.n).slice(0, 8);
  const pt = $('#players'); pt.replaceChildren(h('thead', {}, h('tr', {}, ...['Игрок', 'Бр.', 'FG%', 'eFG%'].map((t) => h('th', { text: t })))));
  const pb = h('tbody');
  for (const p of rows) pb.append(h('tr', {}, h('td', { text: `${p.name} · ${p.team}` }), h('td', { class: 'mono', text: p.s.n }), h('td', { class: 'mono', text: pct(p.s.fg) }), h('td', { class: 'mono', text: pct(p.s.efg) })));
  if (!rows.length) pb.append(h('tr', {}, h('td', { colspan: 4, text: 'Нет данных' })));
  pt.append(pb);
}

/** Левая панель: лучшие игроки и лучшие связки (вкладки без данных скрываются). */
function renderLeft() {
  const tabs = [...document.querySelectorAll('#leftTabs button')];
  for (const b of tabs) {
    const v = b.dataset.view;
    b.hidden = !(v === 'players' ? state.top.length : state.lineups.some((l) => String(l.lineup_type) === v));
  }
  const visible = tabs.filter((b) => !b.hidden);
  if (!visible.some((b) => b.dataset.view === state.leftView)) state.leftView = visible[0]?.dataset.view || 'players';
  tabs.forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.leftView));

  const ol = $('#leftList'); ol.replaceChildren();
  if (state.leftView === 'players') {
    $('#leftNote').textContent = 'Очки + передачи − потери за ночь';
    if (!state.top.length) return ol.append(h('li', { class: 'mu', text: 'Нет данных' }));
    state.top.forEach((p, i) => ol.append(h('li', {},
      h('span', { class: 'rank', text: i + 1 }),
      h('div', { class: 'who' }, h('b', { text: p.player_name }), h('span', { text: `${p.team_abbr} · ${num(p.pts)} оч · ${num(p.ast)} аст · ${num(p.tov)} пот` })),
      h('div', { class: 'score' }, String(num(p.score)), h('small', { text: 'баллов' })))));
    return;
  }
  $('#leftNote').textContent = 'Сезонные данные команд, игравших этой ночью. Очки за 100 владений';
  const rows = state.lineups.filter((l) => String(l.lineup_type) === state.leftView);
  if (!rows.length) return ol.append(h('li', { class: 'mu', text: 'Нет данных' }));
  rows.forEach((l, i) => ol.append(h('li', {},
    h('span', { class: 'rank', text: i + 1 }),
    h('div', { class: 'who' }, h('b', { text: l.lineup }), h('span', { text: `${l.team_abbr} · ${fmt(l.minutes_played, 0)} мин · +/- ${num(l.plus_minus)}` })),
    h('div', { class: 'score' }, fmt(l.pts_per_100_poss, 1), h('small', { text: 'очк./100' })))));
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
function demoData() {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const pairs = [['LAL', 'DEN', 118, 112], ['BOS', 'NYK', 104, 109], ['GSW', 'OKC', 121, 99]];
  const games = [], shots = [];
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
  const top = [['Игрок LAL-1', 'LAL', 34, 11, 3], ['Игрок BOS-1', 'BOS', 29, 9, 2], ['Игрок DEN-2', 'DEN', 27, 12, 4], ['Игрок GSW-1', 'GSW', 31, 6, 2], ['Игрок NYK-1', 'NYK', 28, 7, 3]]
    .map(([player_name, team_abbr, pts, ast, tov]) => ({ player_name, team_abbr, pts, ast, tov, score: pts + ast - tov })).sort((a, b) => b.score - a.score);
  const lineups = [];
  [2, 3].forEach((size) => ['LAL', 'BOS', 'GSW', 'DEN', 'NYK'].forEach((t, i) => lineups.push({ team_abbr: t, lineup_type: size, minutes_played: 600 - i * 70, plus_minus: 120 - i * 18, pts_per_100_poss: 128 - i * 3.1 - size,
    lineup: Array.from({ length: size }, (_, k) => `Игрок${k + 1}`).join(' / ') })));
  const now = Date.now();
  const news = [['Тренер объявил состав на следующую игру', 'ESPN', 2], ['Лидер лиги по передачам пропустит матч из-за травмы', 'CBS Sports', 5], ['Клубы обсуждают обмен перед дедлайном', 'ESPN', 9], ['Новичок обновил рекорд по очкам', 'CBS Sports', 20]]
    .map(([title, source, hrs]) => ({ title, source, url: 'https://example.com/', published_at: new Date(now - hrs * 3600000).toISOString() }));
  return { games, shots, top, lineups, news };
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
    const jobs = { games: 'v_nba_last_games', shots: 'v_nba_last_shots', top: 'v_nba_top_players', lineups: 'v_nba_best_lineups', news: 'v_nba_news' };
    const res = await Promise.allSettled(Object.values(jobs).map((v) => rest(v)));
    Object.keys(jobs).forEach((k, i) => {
      if (res[i].status === 'fulfilled') state[k] = res[i].value;
      else console.error(res[i].reason);
    });
    const failed = Object.keys(jobs).filter((_, i) => res[i].status === 'rejected');
    if (failed.length) $('#subtitle').after(h('p', { class: 'error', text: `Не удалось загрузить: ${failed.join(', ')}. Проверьте sql/nba_views.sql и права anon.` }));
  }
  renderSubtitle(); renderAll(); renderLeft(); renderNews();
}
init();