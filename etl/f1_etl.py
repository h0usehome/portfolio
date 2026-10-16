"""
F1 ETL: Jolpica-F1 (преемник Ergast) -> Supabase (PostgreSQL).

Команды:
  python3 f1_etl.py last                          # последняя состоявшаяся гонка (для ежедневного обновления)
  python3 f1_etl.py race --season 2025 --round 22 # конкретная гонка
  python3 f1_etl.py season --season 2025          # все прошедшие гонки сезона (backfill)
  python3 f1_etl.py news                          # новости F1 из RSS (таблица news, topic = f1)

Лимиты Jolpica: ~4 запроса в секунду и порядка 500 в час. 
Скрипт автоматически держит паузу и уходит в сон при HTTP 429.
Загрузка идемпотентна (upsert): повторный запуск ничего не дублирует.
"""
import argparse
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, timezone
from email.utils import parsedate_to_datetime

from curl_cffi import requests as curl_requests
from supabase import Client, create_client

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# --- Конфигурация Supabase ---
SUPABASE_URL = 'https://xqqeiigpamtegingzjda.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M'

JOLPICA = 'https://api.jolpi.ca/ergast/f1'
PAUSE = 0.45  # Jolpica держит около 4 req/sec, 0.45 - безопасный интервал
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

NEWS_FEEDS = [
    ('Formula1.com', 'https://www.formula1.com/content/fom-website/en/latest/all.xml'),
    ('Autosport', 'https://www.autosport.com/rss/f1/news/'),
    ('ESPN', 'https://www.espn.com/espn/rss/f1/news'),
]

_client = None
_last_request = 0.0

def get_client() -> Client:
    """Инициализация Supabase клиента (Singleton)."""
    global _client
    if _client is None:
        url = os.environ.get('SUPABASE_URL') or SUPABASE_URL
        key = os.environ.get('SUPABASE_SERVICE_KEY') or SUPABASE_KEY
        _client = create_client(url, key)
    return _client

def chunks(lst: list, n: int):
    """Разбивает список на батчи фиксированного размера."""
    for i in range(0, len(lst), n):
        yield lst[i:i + n]

# ---------------------------------------------------------------- Сетевые запросы
def jget(path: str, params: dict = None, retries: int = 4) -> dict:
    """GET к Jolpica с паузой, повтором при 429 и подделкой отпечатка."""
    global _last_request
    for attempt in range(retries):
        wait = PAUSE - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
            
        r = curl_requests.get(JOLPICA + path, params=params, headers=HEADERS, impersonate="chrome110", timeout=30)
        _last_request = time.time()
        
        if r.status_code == 429:
            delay = 30 * (attempt + 1)
            print(f'  429 Too Many Requests, жду {delay} с...')
            time.sleep(delay)
            continue
            
        r.raise_for_status()
        return r.json()['MRData']
    raise RuntimeError(f'Не удалось получить {path}')

def to_ms(t):
    """Конвертация '1:32.456' -> 92456, '23.456' -> 23456. Пустое значение -> None."""
    if not t:
        return None
    try:
        parts = str(t).split(':')
        secs = float(parts[-1])
        mins = int(parts[-2]) if len(parts) > 1 else 0
        hrs = int(parts[-3]) if len(parts) > 2 else 0
        return int(round(((hrs * 60 + mins) * 60 + secs) * 1000))
    except (ValueError, IndexError):
        return None

# ---------------------------------------------------------------- Парсинг гонки
def parse_results(race: dict):
    season, rnd = int(race['season']), int(race['round'])
    circuit = race.get('Circuit', {})
    loc = circuit.get('Location', {})
    
    race_row = {
        "season": season, "round": rnd, "race_name": race['raceName'], "race_date": race['date'],
        "circuit_id": circuit.get('circuitId'), "circuit_name": circuit.get('circuitName'),
        "locality": loc.get('locality'), "country": loc.get('country')
    }
    
    drivers, constructors, results = {}, {}, []
    
    for r in race.get('Results', []):
        d, c = r['Driver'], r['Constructor']
        drivers[d['driverId']] = {
            "driver_id": d['driverId'], "code": d.get('code'), "given_name": d.get('givenName'),
            "family_name": d.get('familyName'), "nationality": d.get('nationality')
        }
        constructors[c['constructorId']] = {"constructor_id": c['constructorId'], "name": c.get('name')}
        
        fl = r.get('FastestLap') or {}
        pos_text = r.get('positionText', '')
        
        # Безопасное извлечение миллисекунд (защита от DNF)
        time_ms = None
        if r.get('Time') and isinstance(r['Time'], dict) and r['Time'].get('millis') and str(r['Time']['millis']).isdigit():
            time_ms = int(r['Time']['millis'])
            
        results.append({
            "season": season, "round": rnd, "driver_id": d['driverId'], "constructor_id": c['constructorId'],
            "car_number": int(r['number']) if str(r.get('number', '')).isdigit() else None,
            "grid": int(r.get('grid') or 0), "position": int(pos_text) if pos_text.isdigit() else None,
            "position_text": pos_text, "points": float(r.get('points') or 0), "laps": int(r.get('laps') or 0),
            "status": r.get('status'), "race_time_ms": time_ms,
            "fastest_rank": int(fl['rank']) if str(fl.get('rank', '')).isdigit() else None,
            "fastest_lap": int(fl['lap']) if str(fl.get('lap', '')).isdigit() else None,
            "fastest_time": fl.get('Time', {}).get('time'),
            "avg_speed": float(fl['AverageSpeed']['speed']) if fl.get('AverageSpeed', {}).get('speed') else None,
        })
        
    return race_row, list(drivers.values()), list(constructors.values()), results

def fetch_laps(season: int, rnd: int) -> list:
    """Постраничная загрузка кругов."""
    merged, offset = {}, 0
    while True:
        m = jget(f'/{season}/{rnd}/laps.json', {'limit': 100, 'offset': offset})
        races, total = m['RaceTable']['Races'], int(m['total'])
        for race in races:
            for lap in race.get('Laps', []):
                n = int(lap['number'])
                for t in lap['Timings']:
                    merged[(n, t['driverId'])] = (int(t['position']), to_ms(t.get('time')))
        offset += 100
        if offset >= total or not races:
            break
    return [{"season": season, "round": rnd, "driver_id": drv, "lap": n, "position": pos, "lap_time_ms": ms}
            for (n, drv), (pos, ms) in sorted(merged.items())]

def fetch_pitstops(season: int, rnd: int) -> list:
    """Постраничная загрузка пит-стопов (исправлено)."""
    merged, offset = [], 0
    while True:
        m = jget(f'/{season}/{rnd}/pitstops.json', {'limit': 100, 'offset': offset})
        total = int(m['total'])
        races = m['RaceTable']['Races']
        if races and races[0].get('PitStops'):
            for p in races[0]['PitStops']:
                merged.append({
                    "season": season, "round": rnd, "driver_id": p['driverId'], 
                    "stop": int(p['stop']), "lap": int(p['lap']), "duration_ms": to_ms(p.get('duration'))
                })
        offset += 100
        if offset >= total or not races:
            break
    return merged

def fetch_standings(season: int, rnd: int):
    d_rows, c_rows = [], []
    m = jget(f'/{season}/{rnd}/driverstandings.json')
    lists = m['StandingsTable']['StandingsLists']
    for s in (lists[0]['DriverStandings'] if lists else []):
        cons = s.get('Constructors') or [{}]
        d_rows.append({"season": season, "round": rnd, "driver_id": s['Driver']['driverId'], "position": int(s['position']),
                       "points": float(s['points']), "wins": int(s['wins']), "constructor_id": cons[-1].get('constructorId')})
                       
    m = jget(f'/{season}/{rnd}/constructorstandings.json')
    lists = m['StandingsTable']['StandingsLists']
    for s in (lists[0]['ConstructorStandings'] if lists else []):
        c_rows.append({"season": season, "round": rnd, "constructor_id": s['Constructor']['constructorId'],
                       "position": int(s['position']), "points": float(s['points']), "wins": int(s['wins'])})
    return d_rows, c_rows

# ---------------------------------------------------------------- Загрузка в БД
def load_race(season: int, rnd: int):
    print(f'--- Гонка {season}, этап {rnd} ---')
    races = jget(f'/{season}/{rnd}/results.json')['RaceTable']['Races']
    if not races or not races[0].get('Results'):
        raise ValueError('результатов нет: гонка не найдена или ещё не состоялась')
        
    race_row, drivers, constructors, results = parse_results(races[0])
    laps = fetch_laps(season, rnd)
    pits = fetch_pitstops(season, rnd)
    d_stand, c_stand = fetch_standings(season, rnd)
    
    print(f'  {race_row["race_name"]}: пилотов {len(results)}, кругов {len(laps)}, пит-стопов {len(pits)}')

    sb = get_client()
    sb.table('f1_races').upsert(race_row).execute()
    sb.table('f1_drivers').upsert(drivers).execute()
    sb.table('f1_constructors').upsert(constructors).execute()
    sb.table('f1_results').upsert(results).execute()
    
    for part in chunks(laps, 500):
        sb.table('f1_laps').upsert(part).execute()
    if pits:
        sb.table('f1_pitstops').upsert(pits).execute()
        
    # Дозагрузка недостающих пилотов батчем (исправлено N+1)
    known_drivers = {d['driver_id'] for d in drivers}
    missing_drivers = []
    for s in d_stand:
        if s['driver_id'] not in known_drivers:
            missing_drivers.append({"driver_id": s['driver_id']})
            known_drivers.add(s['driver_id'])
            
    if missing_drivers:
        for part in chunks(missing_drivers, 500):
            sb.table('f1_drivers').upsert(part).execute()
            
    if d_stand:
        sb.table('f1_driver_standings').upsert(d_stand).execute()
    if c_stand:
        sb.table('f1_constructor_standings').upsert(c_stand).execute()
    print('  записано')

def last_round():
    races = jget('/current/last/results.json')['RaceTable']['Races']
    if not races:
        raise ValueError('не удалось определить последнюю гонку')
    return int(races[0]['season']), int(races[0]['round'])

def load_season(season: int):
    races = jget(f'/{season}.json')['RaceTable']['Races']
    today = date.today().isoformat()
    ok, failed = 0, []
    
    for r in races:
        if r['date'] > today:
            continue
        try:
            load_race(season, int(r['round']))
            ok += 1
        except Exception as e:
            print(f'  этап {r["round"]}: ОШИБКА {e}')
            failed.append(r['round'])
            
    print(f'\nИтог: загружено гонок {ok}, с ошибками {len(failed)}' + (f' (этапы {", ".join(failed)})' if failed else ''))

# ---------------------------------------------------------------- Новости (RSS)
def parse_rss(xml_text: str, source: str) -> list:
    """Разбор RSS ленты."""
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

def fetch_f1_news():
    print('--- Новости F1 (RSS) ---')
    rows = []
    for source, url in NEWS_FEEDS:
        try:
            r = curl_requests.get(url, headers=HEADERS, impersonate="chrome110", timeout=30)
            r.raise_for_status()
            part = parse_rss(r.text, source)
            print(f'  {source}: {len(part)} новостей')
            rows += part
        except Exception as e:
            print(f'  {source}: ОШИБКА {type(e).__name__}: {e}')
            
    if not rows:
        return print('Новостей не получено')
        
    unique = list({r['url']: {**r, "topic": "f1"} for r in rows}.values())
    for part in chunks(unique, 200):
        get_client().table('news').upsert(part, on_conflict='url').execute()
    print(f'Записано новостей: {len(unique)}')

def sync_driver_assets():
    print('--- Фото пилотов и цвета команд (OpenF1 API) ---')
    sb = get_client()
    
    # 1. Получаем текущих пилотов из нашей базы, чтобы связать их по трехбуквенному коду (code)
    res = sb.table('f1_drivers').select('driver_id, code').execute()
    # Создаем словарь: {'VER': 'max_verstappen', 'LEC': 'leclerc', ...}
    code_to_id = {r['code']: r['driver_id'] for r in res.data if r.get('code')}
    
    if not code_to_id:
        print("В базе нет пилотов с кодами. Сначала загрузите гонки!")
        return

    # 2. Запрашиваем актуальные данные из OpenF1
    try:
        r = curl_requests.get('https://api.openf1.org/v1/drivers?session_key=latest', impersonate="chrome110", timeout=30)
        r.raise_for_status()
        openf1_drivers = r.json()
    except Exception as e:
        return print(f"Ошибка получения данных из OpenF1: {e}")
    
    rows = []
    for d in openf1_drivers:
        code = d.get('name_acronym')
        photo_url = d.get('headshot_url')
        
        # Если пилот есть в OpenF1 и в нашей базе
        if code and photo_url and code in code_to_id:
            # OpenF1 отдает фото в '1col', меняем на '2col' для лучшего качества (чтобы не мылило на retina)
            hq_photo = photo_url.replace('1col', '2col')
            rows.append({
                "driver_id": code_to_id[code],
                "photo_url": hq_photo,
                # Добавляем # к HEX-коду цвета (например, Red Bull -> #3671C6)
                "team_color": f"#{d.get('team_colour', '000000')}"
            })
            
    if rows:
        for part in chunks(rows, 200):
            sb.table('f1_driver_assets').upsert(part, on_conflict='driver_id').execute()
        print(f'Обновлено ассетов (фото + цвета): {len(rows)}')
    else:
        print('Новых фото не найдено.')

# ---------------------------------------------------------------- Точка входа
def main(argv=None):
    ap = argparse.ArgumentParser(description='F1 ETL (Jolpica-F1)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    
    sub.add_parser('last', help='последняя состоявшаяся гонка')
    sub.add_parser('assets', help='загрузить фото пилотов и цвета команд (OpenF1)')
    
    r = sub.add_parser('race', help='одна гонка')
    r.add_argument('--season', type=int, required=True)
    r.add_argument('--round', type=int, required=True)
    
    s = sub.add_parser('season', help='все прошедшие гонки сезона')
    s.add_argument('--season', type=int, required=True)
    
    sub.add_parser('news', help='новости F1 из RSS')
    
    args = ap.parse_args(argv)

    if args.cmd == 'last':
        load_race(*last_round())
    elif args.cmd == 'race':
        load_race(args.season, args.round)
    elif args.cmd == 'season':
        load_season(args.season)
    elif args.cmd == 'news':
        fetch_f1_news()
    elif args.cmd == 'assets':
        sync_driver_assets()

if __name__ == '__main__':
    main()