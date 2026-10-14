"""
NBA ETL: Basketball-Reference -> Supabase (PostgreSQL). Версия для загрузки исторических данных (backfill).

Команды:
  python nba_etl.py seed                                         # справочник из 30 команд (один раз)
  python nba_etl.py games --from 2025-12-20 --to 2025-12-26      # игры, статистика игроков и броски за диапазон дат
  python nba_etl.py games --date 2025-12-25 --no-shots           # один день, без карты бросков (быстрее)
  python nba_etl.py games --from 2025-10-21 --to 2025-10-31 --force    # перезагрузить уже загруженные игры
  python nba_etl.py lineups --season 2026 --teams BOS,LAL        # связки; --teams all для всех команд
  python nba_etl.py news                                         # новости NBA из RSS (таблица news)

Ключи Supabase заданы в константах SUPABASE_URL и SUPABASE_KEY в начале файла.
Это anon-ключ: для записи в таблицы в Supabase нужны политики RLS на insert/update (см. объяснение в чате).

Скорость: ~7 секунд на матч (2 запроса с паузой 3,5 с). Сутки с 10 матчами займут около 70 секунд.
Загрузка идёт по одному матчу, поэтому прерванный запуск можно просто повторить: загруженные игры пропускаются.
"""
import argparse
import io
import os
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import pandas as pd
import requests
from bs4 import BeautifulSoup
from supabase import Client, create_client

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:          # python-dotenv не обязателен, если переменные заданы в терминале
    pass

# --- Supabase: ключи прямо в скрипте (по вашему решению) ---
SUPABASE_URL = 'https://xqqeiigpamtegingzjda.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M'

BASE = "https://www.basketball-reference.com"
PAUSE = 3.5          # минимальный интервал между запросами к сайту; он ограничивает частоту, не уменьшайте
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
}

# Коды как на Basketball-Reference (у Бруклина BRK, у Шарлотт CHO). Если страница команды не открывается, сверьте код с адресом на сайте.
NBA_TEAMS = {
    'ATL': {'city': 'Atlanta', 'name': 'Hawks'}, 'BOS': {'city': 'Boston', 'name': 'Celtics'},
    'BRK': {'city': 'Brooklyn', 'name': 'Nets'}, 'CHO': {'city': 'Charlotte', 'name': 'Hornets'},
    'CHI': {'city': 'Chicago', 'name': 'Bulls'}, 'CLE': {'city': 'Cleveland', 'name': 'Cavaliers'},
    'DAL': {'city': 'Dallas', 'name': 'Mavericks'}, 'DEN': {'city': 'Denver', 'name': 'Nuggets'},
    'DET': {'city': 'Detroit', 'name': 'Pistons'}, 'GSW': {'city': 'Golden State', 'name': 'Warriors'},
    'HOU': {'city': 'Houston', 'name': 'Rockets'}, 'IND': {'city': 'Indiana', 'name': 'Pacers'},
    'LAC': {'city': 'Los Angeles', 'name': 'Clippers'}, 'LAL': {'city': 'Los Angeles', 'name': 'Lakers'},
    'MEM': {'city': 'Memphis', 'name': 'Grizzlies'}, 'MIA': {'city': 'Miami', 'name': 'Heat'},
    'MIL': {'city': 'Milwaukee', 'name': 'Bucks'}, 'MIN': {'city': 'Minnesota', 'name': 'Timberwolves'},
    'NOP': {'city': 'New Orleans', 'name': 'Pelicans'}, 'NYK': {'city': 'New York', 'name': 'Knicks'},
    'OKC': {'city': 'Oklahoma City', 'name': 'Thunder'}, 'ORL': {'city': 'Orlando', 'name': 'Magic'},
    'PHI': {'city': 'Philadelphia', 'name': '76ers'}, 'PHO': {'city': 'Phoenix', 'name': 'Suns'},
    'POR': {'city': 'Portland', 'name': 'Trail Blazers'}, 'SAC': {'city': 'Sacramento', 'name': 'Kings'},
    'SAS': {'city': 'San Antonio', 'name': 'Spurs'}, 'TOR': {'city': 'Toronto', 'name': 'Raptors'},
    'UTA': {'city': 'Utah', 'name': 'Jazz'}, 'WAS': {'city': 'Washington', 'name': 'Wizards'},
}
DNP_MARKERS = ['Did Not Play', 'Did Not Dress', 'Not With Team', 'Player Suspended']

_client = None
_last_request = 0.0


def get_client() -> Client:
    """Клиент создаётся при первом обращении. Переменные окружения, если заданы, имеют приоритет над ключами в коде."""
    global _client
    if _client is None:
        url = os.environ.get('SUPABASE_URL') or SUPABASE_URL
        key = os.environ.get('SUPABASE_SERVICE_KEY') or SUPABASE_KEY
        _client = create_client(url, key)
    return _client


# ---------------------------------------------------------------- вспомогательные функции
def get(url: str, retries: int = 3) -> requests.Response:
    """GET с общей паузой между запросами, повтором при 429 и понятной ошибкой при других кодах."""
    global _last_request
    for attempt in range(retries):
        wait = PAUSE - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        r = requests.get(url, headers=HEADERS, timeout=30)
        _last_request = time.time()
        if r.status_code == 429:
            delay = 60 * (attempt + 1)
            print(f'  429 Too Many Requests, жду {delay} с...')
            time.sleep(delay)
            continue
        r.raise_for_status()
        return r
    raise RuntimeError(f'Не удалось получить {url}')


def to_num(x, default: float = 0.0) -> float:
    """Одно значение -> число. NaN и мусор превращаются в default."""
    v = pd.to_numeric(x, errors='coerce')
    return default if pd.isna(v) else float(v)


def clean_minutes(min_str) -> float:
    if pd.isna(min_str) or any(m in str(min_str) for m in DNP_MARKERS):
        return 0.0
    try:
        if ':' in str(min_str):
            m, s = str(min_str).split(':')
            return round(int(m) + int(s) / 60.0, 1)
        return float(min_str)
    except (ValueError, TypeError):
        return 0.0


def extract_player_id(name_str) -> str:
    """Jokić -> jokic, Dončić -> doncic: сначала убираем диакритику, иначе буквы пропадают (jokic -> joki)."""
    ascii_name = unicodedata.normalize('NFKD', str(name_str)).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-zA-Z0-9]', '', ascii_name).lower()


def uncomment(html: str) -> str:
    """Basketball-Reference прячет часть таблиц в HTML-комментариях."""
    return re.sub(r'<!--|-->', '', html)


def first_value(row, col):
    v = row[col]
    return v.iloc[0] if isinstance(v, pd.Series) else v


def last_value(row, col):
    v = row[col]
    return v.iloc[-1] if isinstance(v, pd.Series) else v


def per_100(row, df) -> float:
    """PTS на странице связок встречается дважды (итого и на 100 владений). Pandas отдаёт это либо Series, либо колонку 'PTS.1'."""
    if isinstance(row['PTS'], pd.Series):
        return to_num(row['PTS'].iloc[-1])
    if 'PTS.1' in df.columns:
        return to_num(row['PTS.1'])
    return 0.0


def chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def season_of(d: date) -> int:
    """Сезон = год окончания: матчи с сентября по декабрь 2025 относятся к сезону 2026."""
    return d.year + 1 if d.month >= 9 else d.year


def daterange(start: date, end: date):
    for i in range((end - start).days + 1):
        yield start + timedelta(days=i)


# ---------------------------------------------------------------- справочник команд
def seed_teams():
    rows = [{"team_id": t, "abbreviation": t, "city": v["city"], "name": v["name"]}
            for t, v in NBA_TEAMS.items()]
    get_client().table("teams").upsert(rows).execute()
    print(f'В teams записано {len(rows)} команд')


# ---------------------------------------------------------------- разбор броска
def parse_shot(raw_tip: str, style: str):
    """
    Подсказка: '1st quarter, 11:21.0 remaining<br>Sam Merrill missed 3-pointer from 26 ft<br>Cleveland 0, Los Angeles 0'
    Нужна строка с made/missed, а не последняя. Возвращает словарь или None.
    """
    top = re.search(r'top:\s*(-?\d+(?:\.\d+)?)px', style)
    left = re.search(r'left:\s*(-?\d+(?:\.\d+)?)px', style)
    if not (raw_tip and top and left):
        return None
    parts = [re.sub(r'<[^>]+>', '', p).strip() for p in re.split(r'<br\s*/?>', raw_tip, flags=re.IGNORECASE)]
    play_text = next((p for p in parts if re.search(r'\b(made|missed)\b', p)), '')
    m = re.search(r'^(.*?)\s+(made|missed)\s+(\d)-pointer', play_text)
    if not m:
        return None
    q = re.search(r'(\d+)(?:st|nd|rd|th)\s+(quarter|overtime)', raw_tip, re.IGNORECASE)
    if q:
        n = int(q.group(1))
        quarter = n if q.group(2).lower() == 'quarter' else 4 + n      # овертайм = 5, 6, ...
    else:
        quarter = 1
    dist = re.search(r'from\s+(\d+)\s+ft', play_text)
    return {
        "player_name": m.group(1).strip(), "quarter": quarter,
        "coord_x": float(left.group(1)), "coord_y": float(top.group(1)),
        "is_made": m.group(2) == 'made', "shot_value": int(m.group(3)),
        "distance_ft": float(dist.group(1)) if dist else 0.0,
    }


# ---------------------------------------------------------------- одна игра
def parse_game(link: str, game_date: date, with_shots: bool) -> dict:
    """Скачивает и разбирает один матч. Ничего не пишет в БД."""
    game_id = link.split('/')[-1].replace('.html', '')
    soup = BeautifulSoup(uncomment(get(BASE + link).text), 'html.parser')
    tables = soup.find_all('table', id=re.compile(r'^box-[A-Z]{3}-game-basic$'))
    if len(tables) < 2:
        raise ValueError('таблицы box score не найдены')

    away_id = tables[0]['id'].split('-')[1].strip()
    home_id = tables[1]['id'].split('-')[1].strip()
    teams = {}
    for t_id in (away_id, home_id):
        info = NBA_TEAMS.get(t_id, {'city': t_id, 'name': t_id})
        teams[t_id] = {"team_id": t_id, "abbreviation": t_id, "city": info['city'], "name": info['name']}

    players, stats, name_to_ids, pts = {}, [], {}, {}
    for table, team_id in ((tables[0], away_id), (tables[1], home_id)):
        df = pd.read_html(io.StringIO(str(table)))[0]
        df.columns = df.columns.droplevel(0)
        totals = df[df['Starters'] == 'Team Totals']
        pts[team_id] = int(to_num(totals['PTS'].values[0])) if not totals.empty else 0

        df = df[~df['Starters'].isin(['Reserves', 'Team Totals', 'Starters'])].dropna(subset=['Starters'])
        df = df[~df['MP'].astype(str).apply(lambda s: any(m in s for m in DNP_MARKERS))]
        for _, row in df.iterrows():
            name = str(row['Starters']).strip()
            pid = extract_player_id(name)
            first, _, last = name.partition(' ')
            players[pid] = {"player_id": pid, "first_name": first, "last_name": last, "position": "N/A", "team_id": team_id}
            name_to_ids[name] = (pid, team_id)
            n = lambda col: int(to_num(row.get(col)))
            stats.append({
                "game_id": game_id, "player_id": pid, "team_id": team_id, "min": clean_minutes(row['MP']),
                "pts": n('PTS'), "fga": n('FGA'), "fgm": n('FG'), "fg3a": n('3PA'), "fg3m": n('3P'),
                "fta": n('FTA'), "ftm": n('FT'), "ast": n('AST'), "tov": n('TOV'),
            })

    game = {"game_id": game_id, "game_date": game_date.isoformat(), "season": season_of(game_date),
            "home_team_id": home_id, "visitor_team_id": away_id,
            "home_pts": pts.get(home_id, 0), "visitor_pts": pts.get(away_id, 0)}

    shots, unmatched, divs = [], 0, 0
    if with_shots:
        try:
            shot_soup = BeautifulSoup(get(f'{BASE}/boxscores/shot-chart/{game_id}.html').text, 'html.parser')
            elems = shot_soup.find_all('div', style=re.compile(r'top:.*?left:'))
            divs = len(elems)
            for div in elems:
                shot = parse_shot(div.get('tip') or div.get('data-tip') or '', div.get('style', ''))
                if not shot:
                    continue
                ids = name_to_ids.get(shot.pop('player_name'))
                if not ids:
                    unmatched += 1
                    continue
                shot['game_id'], shot['player_id'], shot['team_id'] = game_id, ids[0], ids[1]
                shots.append(shot)
        except Exception as e:
            print(f'  нет карты бросков: {e}')

    return {"game": game, "teams": list(teams.values()), "players": list(players.values()),
            "stats": pd.DataFrame(stats).drop_duplicates(subset=['game_id', 'player_id']).to_dict('records'),
            "shots": shots, "shot_elems": divs, "shots_unmatched": unmatched}


def load_game(data: dict):
    """Записывает один матч. Порядок важен из-за внешних ключей: teams -> players -> games -> stats -> shots."""
    sb = get_client()
    sb.table('teams').upsert(data['teams']).execute()
    for part in chunks(data['players'], 500):
        sb.table('players').upsert(part).execute()
    sb.table('games').upsert(data['game']).execute()
    for part in chunks(data['stats'], 500):
        sb.table('player_game_stats').upsert(part).execute()
    gid = data['game']['game_id']
    sb.table('shots').delete().eq('game_id', gid).execute()      # insert не идемпотентен: чистим броски матча перед записью
    for part in chunks(data['shots'], 1000):
        sb.table('shots').insert(part).execute()


def existing_game_ids(start: date, end: date) -> set:
    """ID игр диапазона, которые уже есть в БД (постранично, у Supabase лимит 1000 строк на запрос)."""
    sb, ids, offset = get_client(), set(), 0
    while True:
        res = (sb.table('games').select('game_id').gte('game_date', start.isoformat())
               .lte('game_date', end.isoformat()).range(offset, offset + 999).execute())
        ids.update(r['game_id'] for r in res.data)
        if len(res.data) < 1000:
            return ids
        offset += 1000


# ---------------------------------------------------------------- 1. игры за диапазон дат
def backfill_games(start: date, end: date, with_shots: bool = True, force: bool = False):
    print(f'--- Игры с {start} по {end} (броски: {"да" if with_shots else "нет"}, перезапись: {"да" if force else "нет"}) ---')
    done = set() if force else existing_game_ids(start, end)
    ok, skipped, failed, total_shots = 0, 0, [], 0

    for d in daterange(start, end):
        try:
            soup = BeautifulSoup(get(f'{BASE}/boxscores/?month={d.month}&day={d.day}&year={d.year}').text, 'html.parser')
        except Exception as e:
            print(f'{d}: не удалось получить список матчей: {e}')
            failed.append(str(d))
            continue
        links = sorted({a['href'] for a in soup.find_all('a', href=True)
                        if re.match(rf'^/boxscores/{d:%Y%m%d}0[A-Z]{{3}}\.html$', a['href'])})
        if not links:
            continue
        print(f'{d}: матчей {len(links)}')

        for link in links:
            gid = link.split('/')[-1].replace('.html', '')
            if gid in done:
                skipped += 1
                continue
            try:
                data = parse_game(link, d, with_shots)
                load_game(data)
                ok += 1
                total_shots += len(data['shots'])
                print(f'  {gid}: игроков {len(data["stats"])}, бросков {len(data["shots"])} из {data["shot_elems"]}'
                      + (f', без игрока в box score: {data["shots_unmatched"]}' if data['shots_unmatched'] else ''))
            except Exception as e:
                print(f'  {gid}: ОШИБКА {e}')
                failed.append(gid)

    print(f'\nИтог: загружено игр {ok}, пропущено (уже в БД) {skipped}, бросков {total_shots}, ошибок {len(failed)}')
    if failed:
        print('Не загружено (повторите запуск, будут обработаны только они):', ', '.join(failed))
    return not failed


# ---------------------------------------------------------------- 2. связки за сезон
def fetch_seasonal_lineups(season: int, teams: list):
    print(f'--- Связки за сезон {season}: {", ".join(teams)} ---')
    all_lineups = []
    for team in teams:
        print(f'Связки для {team}...')
        try:
            soup = BeautifulSoup(uncomment(get(f'{BASE}/teams/{team}/{season}/lineups/').text), 'html.parser')
            for size in (2, 3, 5):
                table = soup.find('table', id=re.compile(rf'lineups_{size}-man.*'))
                if not table:
                    continue
                df = pd.read_html(io.StringIO(str(table)))[0]
                df.columns = df.columns.droplevel(0)
                df = df[df['MP'] != 'MP'].copy()
                df['MP_clean'] = df['MP'].apply(clean_minutes)
                df = df[df['MP_clean'] >= 50.0]
                for _, row in df.iterrows():
                    players = [extract_player_id(p) for p in str(first_value(row, 'Lineup')).split(' | ')]
                    pm_col = '+/-' if '+/-' in df.columns else 'PTS'
                    all_lineups.append({
                        "team_id": team, "season": season, "lineup_type": size, "players_array": players,
                        "minutes_played": float(row['MP_clean']),
                        "plus_minus": int(to_num(first_value(row, pm_col))),
                        "pts_per_100_poss": per_100(row, df),
                    })
        except Exception as e:
            print(f'  ошибка при разборе связок {team}: {type(e).__name__}: {e}')

    all_lineups = [l for l in all_lineups if l['team_id'] in NBA_TEAMS]      # страховка от внешнего ключа
    if not all_lineups:
        print('Связок не найдено: страница пуста для этого сезона или изменилась разметка. Загружать нечего.')
        return

    # Идемпотентная запись без уникального ограничения: сначала удаляем связки команды за сезон, затем вставляем заново
    by_team = {}
    for l in all_lineups:
        by_team.setdefault(l['team_id'], []).append(l)
    sb = get_client()
    for team in teams:
        rows = by_team.get(team, [])
        if not rows:
            print(f'  {team}: связок нет (пропуск, старые данные не тронуты)')
            continue
        try:
            sb.table('team_lineups').delete().eq('team_id', team).eq('season', season).execute()
            written = 0
            for part in chunks(rows, 500):
                written += len(sb.table('team_lineups').insert(part).execute().data)
            print(f'  {team}: записано связок {written}')
        except Exception as e:
            print(f'  {team}: ОШИБКА записи в team_lineups: {e}')


# ---------------------------------------------------------------- 3. новости (RSS)
NEWS_FEEDS = [
    ('ESPN', 'https://www.espn.com/espn/rss/nba/news'),
    ('CBS Sports', 'https://www.cbssports.com/rss/headlines/nba/'),
]


def parse_rss(xml_text: str, source: str) -> list:
    """Разбирает RSS 2.0: заголовок, ссылка, время публикации. Сохраняем только заголовок и ссылку, текст статей не копируем."""
    out = []
    root = ET.fromstring(xml_text)
    for item in root.iter('item'):
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        pub = item.findtext('pubDate')
        if not (title and link.startswith('http') and pub):
            continue
        try:
            dt = parsedate_to_datetime(pub)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        out.append({"url": link, "title": title, "source": source, "published_at": dt.astimezone(timezone.utc).isoformat()})
    return out


def fetch_news():
    print('--- Новости NBA (RSS) ---')
    rows = []
    for source, url in NEWS_FEEDS:
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            r.raise_for_status()
            part = parse_rss(r.text, source)
            print(f'  {source}: {len(part)} новостей')
            rows += part
        except Exception as e:                    # одна упавшая лента не должна останавливать остальные
            print(f'  {source}: ОШИБКА {type(e).__name__}: {e}')
    if not rows:
        print('Новостей не получено')
        return
    unique = {r['url']: {**r, "topic": "nba"} for r in rows}.values()
    for part in chunks(list(unique), 200):
        get_client().table('news').upsert(part, on_conflict='url').execute()
    print(f'Записано новостей: {len(unique)}')


# ---------------------------------------------------------------- запуск
def main(argv=None):
    ap = argparse.ArgumentParser(description='NBA ETL (backfill)')
    sub = ap.add_subparsers(dest='cmd', required=True)

    sub.add_parser('seed', help='записать справочник команд')

    g = sub.add_parser('games', help='игры, статистика игроков и броски')
    g.add_argument('--date', help='один день, YYYY-MM-DD')
    g.add_argument('--from', dest='start', help='начало диапазона, YYYY-MM-DD')
    g.add_argument('--to', dest='end', help='конец диапазона, YYYY-MM-DD')
    g.add_argument('--no-shots', action='store_true', help='не собирать броски (в 2 раза быстрее)')
    g.add_argument('--force', action='store_true', help='перезагрузить игры, которые уже есть в БД')

    sub.add_parser('news', help='новости NBA из RSS за последние сутки')

    l = sub.add_parser('lineups', help='связки игроков за сезон')
    l.add_argument('--season', type=int, required=True, help='год окончания сезона, например 2026 для 2025-26')
    l.add_argument('--teams', default='all', help='коды через запятую или all')

    args = ap.parse_args(argv)
    if args.cmd == 'seed':
        seed_teams()
    elif args.cmd == 'games':
        if args.date:
            start = end = datetime.strptime(args.date, '%Y-%m-%d').date()
        elif args.start and args.end:
            start, end = (datetime.strptime(x, '%Y-%m-%d').date() for x in (args.start, args.end))
        else:
            ap.error('укажите --date или пару --from и --to')
        if end < start:
            ap.error('--to раньше --from')
        seed_teams()
        sys.exit(0 if backfill_games(start, end, not args.no_shots, args.force) else 1)
    elif args.cmd == 'news':
        fetch_news()
    elif args.cmd == 'lineups':
        seed_teams()
        teams = list(NBA_TEAMS) if args.teams.lower() == 'all' else [t.strip().upper() for t in args.teams.split(',') if t.strip()]
        fetch_seasonal_lineups(args.season, teams)


if __name__ == '__main__':
    main()
