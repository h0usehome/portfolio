'use strict';

/* ============================== Настройки ============================== */
const CFG = {
  url: 'https://xqqeiigpamtegingzjda.supabase.co',
  // anon-ключ публичный по замыслу: через него доступны только view с grant select
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M',
};
const DEMO = new URLSearchParams(location.search).has('demo');
const EX = window.PIPE_EXAMPLES || null;     // примеры «до и после», сгенерированные build_pipeline_examples.py из настоящего кода ETL

const $ = (s) => document.querySelector(s);
/** Создание DOM без innerHTML: любые данные попадают в текстовые узлы. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}
const num = (v) => Number(v) || 0;
const eur = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('ru-RU')} €`);

/* ============================== Живые данные ============================== */
const live = { ok: false, runs: [], active: null };
const lastOk = () => { const m = {}; for (const r of live.runs) if (r.status === 'ok' && !m[r.source]) m[r.source] = r; return Object.values(m); };
const sum = (key) => lastOk().reduce((a, r) => a + num(r[key]), 0);

async function loadLive() {
  if (DEMO) {
    const now = new Date().toISOString();
    live.runs = [{ source: 'remotive', status: 'ok', fetched: 214, kept: 93, new_jobs: 11, started_at: now }, { source: 'arbeitnow', status: 'ok', fetched: 500, kept: 62, new_jobs: 9, started_at: now }];
    live.active = 571; live.ok = true; return;
  }
  const headers = { apikey: CFG.key, Authorization: `Bearer ${CFG.key}` };
  try {
    const r = await fetch(`${CFG.url}/rest/v1/v_jobs_etl_health?select=*&limit=20`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    live.runs = await r.json(); live.ok = live.runs.length > 0;
    const c = await fetch(`${CFG.url}/rest/v1/v_jobs_active?select=job_key&limit=1`, { headers: { ...headers, Prefer: 'count=exact' } });
    const range = c.headers.get('content-range');
    live.active = range && range.includes('/') ? Number(range.split('/')[1]) : null;
  } catch (e) { console.error(e); }
}

/* ============================== Содержимое этапов ============================== */
const ICONS = {
  cloud: 'M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9.5H7z',
  download: 'M12 4v10m0 0l-4-4m4 4l4-4M5 19h14',
  filter: 'M4 5h16l-6 8v5l-4 2v-7L4 5z',
  db: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6m-14 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6',
  chart: 'M4 20V4m0 16h16M8 16v-4m4 4V8m4 8v-6',
};
const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name]); s.append(p); return s; };

/** Блок кода: комментарии подсвечиваются приглушённым цветом. */
function codeBlock(text, comment = '#') {
  const pre = h('pre', { class: 'code' });
  text.split('\n').forEach((line, i) => {
    const at = line.indexOf(comment);
    if (i) pre.append('\n');
    if (at < 0) pre.append(line); else { pre.append(line.slice(0, at)); pre.append(h('span', { class: 'cm', text: line.slice(at) })); }
  });
  return pre;
}
const list = (items) => h('ul', {}, items.map((t) => h('li', {}, typeof t === 'string' ? t : t)));
const li = (strong, rest) => h('span', {}, h('b', { text: strong }), ' ' + rest);
const col = (title, ...kids) => h('div', { class: 'col' }, h('h3', { text: title }), ...kids);

const CODE_EXTRACT = `def fetch_remotive():
    # все вакансии категории data одним запросом
    return http_get_json(REMOTIVE_URL, {'category': 'data'}).get('jobs', [])

def http_get_json(url, params=None, retries=3):
    for attempt in range(retries):
        r = requests.get(url, params=params, headers=HEADERS, timeout=30)
        if r.status_code == 429:              # слишком много запросов
            time.sleep(60 * (attempt + 1))    # ждём дольше с каждой попыткой
            continue
        r.raise_for_status()                  # остальные ошибки сразу наружу
        return r.json()
    raise RuntimeError(f'Не удалось получить {url}')`;

const CODE_LOAD = `known = existing_first_seen(sb, source)          # что уже есть в базе
for p in postings:
    # дата первого появления сохраняется, новая ставится только новым вакансиям
    p['first_seen_date'] = known.get(p['job_key'], today.isoformat())

sb.table('job_postings').upsert(part, on_conflict='job_key').execute()   # повторный запуск не дублирует
sb.table('job_posting_skills').delete().in_('job_key', keys).execute()   # навыки заменяем целиком
sb.table('jobs_etl_log').insert(stats).execute()                         # итог запуска в журнал`;

const CODE_SERVE = `-- Активная вакансия: её видели не позже 2 дней назад (ничего не удаляем)
create view v_jobs_active as
select p.job_key, p.role_group, p.seniority, p.is_remote, p.salary_year_eur,
       coalesce(array_agg(s.skill order by s.skill)
                filter (where s.skill is not null), '{}') as skills
from job_postings p
left join job_posting_skills s using (job_key)
where p.last_seen_date >= current_date - 2
group by p.job_key;

grant select on v_jobs_active to anon;       -- сайту доступно только чтение view`;

/* Живая воронка и примеры для этапа «Очистка» */
function funnel() {
  const runs = lastOk();
  if (!runs.length) return h('p', { class: 'empty', text: 'Воронка появится после первого запуска пайплайна.' });
  const box = h('div', { class: 'funnel' });
  for (const r of runs) {
    const max = Math.max(1, num(r.fetched));
    box.append(h('b', { text: r.source }));
    [['Получено', r.fetched], ['Прошло фильтры', r.kept], ['Новых', r.new_jobs]].forEach(([l, v]) =>
      box.append(h('div', { class: 'fr' }, h('span', { text: l }), h('span', { class: 'bar' }, h('i', { style: `width:${Math.min(100, num(v) / max * 100).toFixed(1)}%` })), h('span', { class: 'val', text: num(v) }))));
  }
  box.append(h('p', { class: 'note mu', text: 'Отсев нормален: большинство вакансий не про данные, часть оказывается дублями другого источника.' }));
  return box;
}

const exampleTabs = [
  ['one', 'Одна вакансия'], ['salary', 'Зарплаты'], ['role', 'Роли'], ['skills', 'Навыки'], ['funnel', 'Воронка'],
];
let exTab = 'one';

function exampleBlock() {
  const wrap = h('div');
  const tabs = h('div', { class: 'mini', role: 'group', 'aria-label': 'Примеры' });
  for (const [id, label] of exampleTabs) {
    const b = h('button', { type: 'button', 'aria-pressed': id === exTab, text: label });
    b.onclick = () => { exTab = id; render(); };
    tabs.append(b);
  }
  wrap.append(tabs);
  if (!EX && exTab !== 'funnel') return wrap.appendChild(h('p', { class: 'empty', text: 'Файл pipeline-examples.js не найден. Сгенерируйте его: python3 build_pipeline_examples.py' })) && wrap;

  if (exTab === 'one') {
    const raw = { ...EX.raw, description: EX.raw.description };
    wrap.append(h('div', { class: 'ba' }, h('div', {}, h('h4', { text: 'ДО: ответ API' }), codeBlock(JSON.stringify(raw, null, 1), '\u0000')),
      h('span', { class: 'arrow-mid', text: '→' }), h('div', {}, h('h4', { text: 'ПОСЛЕ: строка в базе' }), codeBlock(JSON.stringify(EX.normalized, null, 1), '\u0000'))));
    wrap.append(h('p', { class: 'note mu', style: 'margin-top:10px', text: 'Описание не сохраняется: из него извлечены только навыки.' }));
  } else if (exTab === 'salary') {
    const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['Текст в вакансии', 'Распознано', 'В евро за год'].map((x) => h('th', { text: x })))));
    const b = h('tbody');
    for (const s of EX.salaries) {
      const p = s.parsed;
      b.append(h('tr', {}, h('td', { class: 'mono', text: s.raw }),
        h('td', { class: p ? '' : 'drop', text: p ? `${p.min.toLocaleString('ru-RU')}–${p.max.toLocaleString('ru-RU')} ${p.currency || '?'} / ${p.period === 'hour' ? 'час→год' : p.period === 'month' ? 'мес→год' : 'год'}` : 'отброшено' }),
        h('td', { class: p ? 'good mono' : 'mono', text: p ? eur(p.year_eur) : '—' })));
    }
    t.append(b); wrap.append(h('div', { class: 'scroll' }, t), h('p', { class: 'note mu', style: 'margin-top:10px', text: 'Нет цифр или нереалистичная сумма: честнее оставить пусто, чем угадывать.' }));
  } else if (exTab === 'role') {
    const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['Название', 'Роль', 'Уровень'].map((x) => h('th', { text: x })))));
    const b = h('tbody');
    for (const r of EX.roles) b.append(h('tr', {}, h('td', { text: r.raw }), h('td', { class: r.role === 'Other' ? 'drop' : '', text: r.role === 'Other' ? 'не про данные: отбрасывается' : r.role }), h('td', { text: r.level })));
    t.append(b); wrap.append(h('div', { class: 'scroll' }, t));
  } else if (exTab === 'skills') {
    wrap.append(h('h4', { class: 'mu', style: 'margin:0 0 6px;font-size:12px;font-weight:500', text: 'Текст из описания' }), codeBlock(EX.skills.text, '\u0000'),
      h('h4', { class: 'mu', style: 'margin:12px 0 6px;font-size:12px;font-weight:500', text: `Найдено навыков: ${EX.skills.found.length} (словарь из ${EX.rules.skills_in_dictionary})` }),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, EX.skills.found.map((s) => h('span', { class: 'pill live', text: s }))),
      h('p', { class: 'note mu', style: 'margin-top:10px', text: '«NoSQL» не засчитан как SQL, а «R&D» как язык R: поиск идёт по границам слов и с учётом контекста.' }));
  } else wrap.append(funnel());
  return wrap;
}

function schema() {
  const t = (name, cols, note) => h('div', { class: 'tbl' }, h('b', { text: name }), h('span', { text: cols }), h('em', { text: note }));
  return h('div', { class: 'schema' },
    t('jobs_raw', 'source, source_id, fetched_date, payload (jsonb)', 'Сырой снимок без описаний, хранится 30 дней'),
    h('div', { class: 'down', text: '↓ нормализация' }),
    t('job_postings', 'job_key PK · role_group · seniority · salary_year_eur · first_seen_date · last_seen_date', 'Ядро: одна строка на вакансию'),
    h('div', { class: 'down', text: '↓ один ко многим' }),
    t('job_posting_skills', 'job_key FK · skill (PK вместе)', 'Навыки вакансии'),
    t('jobs_etl_log', 'source · status · fetched · kept · new_jobs · notes', 'Журнал запусков: питает блок «Здоровье пайплайна»'));
}

function sourcesTable() {
  const rows = [['Remotive', 'Удалённые вакансии, категория data', 'JSON, один запрос', 'Просят обращаться раз в сутки и сохранять ссылку на источник'],
    ['Arbeitnow', 'Европа, в основном Германия', 'JSON, постранично', 'Нет поля категории и зарплаты: фильтруем по названию']];
  const t = h('table', { class: 't' }, h('thead', {}, h('tr', {}, ...['Источник', 'Охват', 'Формат', 'Нюанс'].map((x) => h('th', { text: x })))));
  const b = h('tbody'); rows.forEach((r) => b.append(h('tr', {}, r.map((c, i) => h('td', { class: i === 0 ? 'mono' : '', text: c }))))); t.append(b);
  return h('div', { class: 'scroll' }, t);
}

const STAGES = [
  { id: 'sources', name: 'Источники', sub: 'Открытые API без ключа', flow: 'JSON по HTTPS', icon: 'cloud',
    chip: () => (live.ok ? `${new Set(live.runs.map((r) => r.source)).size} источника` : '2 источника'),
    title: 'Где берутся данные', tag: 'Два открытых источника вакансий, каждый с отдельным адаптером.',
    what: () => col('Что происходит', list(['Выбираем API без ключа и с понятными правилами использования.', 'Remotive: удалённые вакансии категории data одним запросом.', 'Arbeitnow: вакансии Европы, до пяти страниц.', 'Запуск раз в сутки: источники просят не частить.'])),
    mid: () => col('Источники', sourcesTable()),
    why: () => col('Почему так', list([li('hh.ru был бы естественным выбором,', 'но публичный поиск вакансий там, по публикациям, закрыт для неавторизованных запросов. Поэтому источник подключается отдельным адаптером.'), li('Описания не сохраняются:', 'только метаданные и ссылка на источник.'), li('Источник может упасть:', 'каждый обрабатывается отдельно, ошибка одного не останавливает остальные.')])) },
  { id: 'extract', name: 'Извлечение', sub: 'Запросы, повторы, пагинация', flow: 'сырые словари', icon: 'download',
    chip: () => (live.ok ? `получено ${sum('fetched')}` : 'ждёт запуска'),
    title: 'Как данные скачиваются', tag: 'Надёжный HTTP-клиент: таймаут, повторы при лимитах, понятные ошибки.',
    what: () => col('Что происходит', list(['GET с таймаутом 30 секунд.', 'При ответе 429 пауза растёт с каждой попыткой.', 'Для постраничных источников пауза между страницами.', 'Результат: список сырых словарей, у каждого источника свой формат.'])),
    mid: () => col('Код (jobs_etl.py)', codeBlock(CODE_EXTRACT)),
    why: () => col('Почему так', list([li('Адаптер на источник:', 'форматы JSON разные, а дальше идёт единая модель.'), li('Повторы только для лимитов:', 'остальные ошибки сразу попадают в журнал, а не маскируются.'), li('Сырой снимок сохраняется', 'в слое jobs_raw, чтобы пересчитать данные без повторных запросов к API.')])) },
  { id: 'transform', name: 'Очистка', sub: 'Нормализация и проверки', flow: 'единая модель', icon: 'filter',
    chip: () => (live.ok ? `оставлено ${sum('kept')}` : '6 шагов'),
    title: 'Очистка и трансформация', tag: 'Из разнородных объявлений получаем единую модель: роль, уровень, зарплата в евро, навыки.',
    what: () => col('Что происходит', list([li('1. Фильтр:', 'оставляем роли про данные.'), li('2. Роль и уровень', 'по названию вакансии.'), li('3. Зарплата:', 'текст → числа → евро за год.'), li('4. Навыки', 'из описания по словарю.'), li('5. Дедупликация', 'между источниками.'), li('6. Проверки качества,', 'предупреждения идут в журнал.')])),
    mid: () => col('Примеры «до и после» (настоящие результаты кода)', exampleBlock()),
    why: () => col('Почему так', list([li('Нереалистичные зарплаты отбрасываются,', 'а не угадываются: пустое значение честнее выдуманного.'), li('Курсы валют приблизительные', 'и заданы в коде: для сравнения порядков, не для бухгалтерии.'), li('Правила покрыты тестами,', 'поэтому изменение словаря навыков или ролей не сломает данные незаметно.')])) },
  { id: 'load', name: 'Загрузка', sub: 'PostgreSQL, идемпотентно', flow: 'таблицы', icon: 'db',
    chip: () => (live.ok ? `новых ${sum('new_jobs')}` : 'upsert'),
    title: 'Как данные попадают в базу', tag: 'Слои raw → core, запись повторяема: перезапуск ничего не дублирует.',
    what: () => col('Что происходит', list(['Сначала снимок в jobs_raw.', 'Затем upsert в job_postings по ключу «источник:id».', 'first_seen_date хранится с первого появления, last_seen_date обновляется при каждом запуске.', 'Навыки вакансии заменяются целиком.', 'Итог запуска пишется в jobs_etl_log.'])),
    mid: () => col('Таблицы и код', schema(), h('div', { style: 'height:12px' }), codeBlock(CODE_LOAD)),
    why: () => col('Почему так', list([li('Идемпотентность:', 'пайплайн можно безопасно перезапускать.'), li('Вакансия активна, если её видели не позже 2 дней назад:', 'ничего не удаляется, и сбой одного запуска не «закрывает» вакансии ложно.'), li('Динамика копится сама:', 'по first_seen и last_seen видно, когда вакансия появилась и сколько провисела.')])) },
  { id: 'serve', name: 'Представление', sub: 'View, браузер, график', flow: 'дашборд', icon: 'chart',
    chip: () => (live.ok && live.active != null ? `активных ${live.active}` : 'view → график'),
    title: 'Как это попадает на сайт', tag: 'База отдаёт готовые представления, а фильтры и графики считаются в браузере.',
    what: () => col('Что происходит', list(['В PostgreSQL созданы view: v_jobs_active, v_jobs_latest, v_jobs_trend, v_jobs_etl_health.', 'Страница загружает активные вакансии и считает фильтры, heatmap и медианы на месте.', 'Доступ к базе только на чтение через публичный ключ.', 'GitHub Actions по расписанию запускает тесты, а затем загрузку.'])),
    mid: () => col('SQL-представление', codeBlock(CODE_SERVE, '--'), h('p', { style: 'margin:14px 0 0' }, h('a', { class: 'btn pri', href: 'jobs.html', text: 'Открыть дашборд' }))),
    why: () => col('Почему так', list([li('Агрегаты в браузере:', 'фильтры мгновенные, без лишних запросов к базе.'), li('Только view и grant select:', 'таблицы закрыты от анонимных запросов.'), li('Тесты идут перед загрузкой:', 'сломанное правило не попадёт в данные.')])) },
];

/* ============================== Отрисовка ============================== */
let current = Math.max(0, Math.min(STAGES.length - 1, (Number((location.hash.match(/stage=(\d)/) || [])[1]) || 1) - 1));

function renderFlow() {
  const flow = $('#flow'); flow.replaceChildren();
  STAGES.forEach((s, i) => {
    const btn = h('button', { type: 'button', class: 'node', role: 'tab', id: `tab-${s.id}`, 'aria-selected': i === current, 'aria-controls': 'detail', tabindex: i === current ? 0 : -1 },
      h('div', { class: 'top-row' }, h('span', { class: 'num', text: `0${i + 1}` }), icon(s.icon)), h('b', { text: s.name }), h('span', { class: 'sub', text: s.sub }), h('span', { class: `pill${live.ok ? ' live' : ''}`, text: s.chip() }));
    btn.onclick = () => select(i);
    btn.onkeydown = (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); select(Math.min(STAGES.length - 1, i + 1), true); } if (e.key === 'ArrowLeft') { e.preventDefault(); select(Math.max(0, i - 1), true); } };
    flow.append(btn);
    if (i < STAGES.length - 1) flow.append(h('div', { class: 'link', 'aria-hidden': 'true' }, h('span', { text: s.flow }), h('span', { class: 'line' }), h('span', { class: 'arrow' })));
  });
}
function renderDetail() {
  const s = STAGES[current], d = $('#detail'); d.replaceChildren();
  d.setAttribute('aria-labelledby', `tab-${s.id}`);
  d.append(h('h2', { text: `${current + 1}. ${s.title}` }), h('p', { class: 'tag', text: s.tag }), h('div', { class: `cols${s.id === 'transform' ? ' wide-mid' : ''}` }, s.what(), s.mid(), s.why()));
}
function render() { renderFlow(); renderDetail(); }
function select(i, focus = false) {
  current = i; history.replaceState(null, '', `#stage=${i + 1}`); render();
  if (focus) $(`#tab-${STAGES[i].id}`).focus();
}

(async function init() {
  render();                                   // сначала статика, чтобы страница не была пустой
  await loadLive();
  const last = live.runs[0];
  $('#liveNote').textContent = live.ok ? `Последний запуск: ${new Date(last.started_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}, статус: ${last.status === 'ok' ? 'успешно' : 'ошибка'}${DEMO ? ' (демо-данные)' : ''}.` : 'Живых цифр пока нет: они появятся после первого запуска пайплайна.';
  render();
})();
