"""
Jobs ETL: рынок вакансий аналитиков данных. Источники -> нормализация -> PostgreSQL (Supabase).

Источники (открытые, без ключа):
  hh_ru       https://api.hh.ru/vacancies (Россия, area=113)
  rabota_by   https://api.hh.ru/vacancies (Беларусь, area=16)

Запуск:
  python3 etl/jobs_etl.py run                      # все источники
  python3 etl/jobs_etl.py run --source hh_ru       # один источник
  python3 etl/jobs_etl.py run --dry-run            # скачать и разобрать, ничего не писать в БД

Подключение к базе и ключи берутся из nba_etl.py (положите файлы в одну папку).
"""
import argparse
import html
import re
import sys
import time
from datetime import datetime, timedelta, timezone

from curl_cffi import requests as curl_requests

HEADERS = {'User-Agent': 'portfolio-jobs-etl/1.0 (pinashin.official@gmail.com)'}
HH_API_URL = 'https://api.hh.ru/vacancies'
PAUSE = 1.0
RAW_RETENTION_DAYS = 30
ACTIVE_WINDOW_DAYS = 2          # вакансия активна, если её видели не позже чем 2 дня назад

# Приблизительные курсы к EUR для сравнения зарплат.
FX_TO_EUR = {'EUR': 1.0, 'USD': 0.92, 'GBP': 1.17, 'CHF': 1.05, 'CAD': 0.68, 'AUD': 0.60, 'PLN': 0.23, 'RUB': 0.010, 'BYN': 0.28}
CURRENCY = {'us$': 'USD', '$': 'USD', 'usd': 'USD', '€': 'EUR', 'eur': 'EUR', '£': 'GBP', 'gbp': 'GBP',
            'chf': 'CHF', 'cad': 'CAD', 'aud': 'AUD', 'pln': 'PLN', 
            'rur': 'RUB', 'rub': 'RUB', 'byr': 'BYN', 'byn': 'BYN'}

# ================================================================ нормализация
def strip_html(text: str) -> str:
    return html.unescape(re.sub(r'<[^>]+>', ' ', text or ''))

ROLE_RULES = [   
    ('Analytics Engineer', r'analytics engineer|dbt|аналитик-инженер'),
    ('Data Engineer', r'data engineer|etl|dwh|data platform|big data|инженер данных|дата-инженер|дата инженер'),
    ('Data Scientist / ML', r'data scien|machine learning|\bml\b|\bai\b engineer|дата-сайентист|дата сайентист|машинн\w+ обучени'),
    ('BI / Reporting', r'\bbi\b|business intelligence|reporting|tableau|power bi|looker|аналитик bi|bi-аналитик|bi аналитик'),
    ('Data Analyst', r'data analy|analytics|analyst|product analy|marketing analy|financial analy|аналитик данных|продуктовый аналитик|дата-аналитик|аналитик sql'),
]

def classify_role(title: str, category: str = None) -> str:
    t = (title or '').lower()
    for role, pattern in ROLE_RULES:
        if re.search(pattern, t):
            return role
    return 'Other data' if (category or '').lower() in ('data', 'data analysis') else 'Other'


def classify_seniority(title: str) -> str:
    t = (title or '').lower()
    if re.search(r'intern|junior|\bjr\b|graduate|entry|trainee|младший|стажер|стажёр', t):
        return 'Junior'
    if re.search(r'senior|\bsr\b|lead|principal|staff|head of|director|manager|старший|ведущий|главный|руководитель|начальник', t):
        return 'Senior'
    return 'Middle'


def parse_salary(text):
    if not text or not str(text).strip():
        return None
    t = str(text).lower().replace(',', '').replace('–', '-').replace('—', '-')
    cur = re.search(r'(us\$|\$|€|£|usd|eur|gbp|chf|cad|aud|pln|rur|rub|byr|byn)', t)
    nums = [float(n) * (1000 if k else 1) for n, k in re.findall(r'(\d+(?:\.\d+)?)(\s*k\b)?', t)]
    nums = [n for n in nums if n > 0][:2]
    if not nums:
        return None
    lo, hi = min(nums), max(nums)
    if re.search(r'/\s*h\b|per hour|hourly|\bhour\b|/hr', t):
        period, mult = 'hour', 2080
    elif re.search(r'per month|monthly|/\s*mo\b|\bmonth\b', t):
        period, mult = 'month', 12
    elif re.search(r'per year|yearly|annual|/\s*yr\b|\byear\b|/year', t):
        period, mult = 'year', 1
    elif hi < 500:                         
        period, mult = 'hour', 2080
    elif hi < 20000:
        period, mult = 'month', 12
    else:
        period, mult = 'year', 1
    year_lo, year_hi = lo * mult, hi * mult
    if not (8000 <= year_hi <= 1_000_000):  
        return None
    return {'min': round(year_lo), 'max': round(year_hi), 'currency': CURRENCY.get(cur.group(1)) if cur else None, 'period': period}


def salary_year_eur(sal):
    if not sal or sal['currency'] not in FX_TO_EUR:
        return None
    return round((sal['min'] + sal['max']) / 2 * FX_TO_EUR[sal['currency']])


SKILLS = {   
    'SQL': r'\bsql\b', 'Python': r'\bpython\b', 'R': None, 'Excel': r'\bexcel\b', 'Power BI': r'power\s?bi',
    'Tableau': r'\btableau\b', 'Looker': r'\blooker\b', 'dbt': r'\bdbt\b', 'Airflow': r'\bairflow\b',
    'Spark': r'\b(py)?spark\b', 'Snowflake': r'\bsnowflake\b', 'BigQuery': r'big\s?query', 'Redshift': r'\bredshift\b',
    'Databricks': r'\bdatabricks\b', 'Kafka': r'\bkafka\b', 'PostgreSQL': r'\bpostgres(ql)?\b', 'MySQL': r'\bmysql\b',
    'AWS': r'\baws\b|amazon web services', 'Azure': r'\bazure\b', 'GCP': r'\bgcp\b|google cloud', 'Docker': r'\bdocker\b',
    'Kubernetes': r'kubernetes|\bk8s\b', 'Terraform': r'\bterraform\b', 'Git': r'\bgit(hub|lab)?\b', 'Pandas': r'\bpandas\b',
    'NumPy': r'\bnumpy\b', 'scikit-learn': r'scikit|sklearn', 'TensorFlow': r'tensorflow', 'PyTorch': r'pytorch',
    'Statistics': r'statistic', 'A/B testing': r'a/b test|\bab test|experimentation|a/b-тестировани', 'Machine Learning': r'machine learning|\bml\b|машинн\w+ обучени',
    'ETL': r'\betl\b|\belt\b|data pipelines?', 'Data modeling': r'data model|моделировани', 'Scala': r'\bscala\b', 'SAS': r'\bsas\b',
}
_SKILL_RX = {k: re.compile(v, re.I) for k, v in SKILLS.items() if v}
_R_RX = re.compile(r'(?<![\w.])R(?=[\s,;/)]| programming| language)')     


def extract_skills(text: str) -> list:
    found = {name for name, rx in _SKILL_RX.items() if rx.search(text or '')}
    if _R_RX.search(text or ''):
        found.add('R')
    return sorted(found)


def iso_utc(value):
    if value in (None, ''):
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
    except (ValueError, OSError):
        return None


def build_posting(source, source_id, title, company, category, tags, description, location, is_remote, job_type, url, published, salary_text, today):
    title = (title or '').strip()
    role = classify_role(title, category)
    sal = parse_salary(salary_text)
    text = ' '.join([title, ' '.join(tags or []), strip_html(description)])
    posting = {
        'job_key': f'{source}:{source_id}', 'source': source, 'source_id': str(source_id), 'title': title, 'company': (company or '').strip() or None,
        'role_group': role, 'seniority': classify_seniority(title), 'location_raw': (location or '').strip() or None,
        'is_remote': bool(is_remote), 'job_type': job_type, 'url': url, 'published_at': iso_utc(published),
        'last_seen_date': today.isoformat(),
        'salary_min': sal['min'] if sal else None, 'salary_max': sal['max'] if sal else None,
        'salary_currency': sal['currency'] if sal else None, 'salary_period': sal['period'] if sal else None,
        'salary_year_eur': salary_year_eur(sal),
    }
    return posting, extract_skills(text)


# ================================================================ extract
def http_get_json(url, params=None, retries=3):
    for attempt in range(retries):
        # Используем curl_requests с маскировкой под Chrome
        r = curl_requests.get(url, params=params, headers=HEADERS, impersonate="chrome120", timeout=30)
        
        if r.status_code in (429, 403):
            wait = 60 * (attempt + 1)
            print(f'  {r.status_code} Blocked, жду {wait} с...')
            time.sleep(wait)
            continue
            
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f'Не удалось получить {url}')

def fetch_hh_base(area_id: int) -> list:
    jobs = []
    query = '("data analyst" OR "аналитик данных" OR "data engineer" OR "инженер данных" OR "data scientist" OR "bi analyst" OR "machine learning")'
    
    for page in range(20):
        params = {
            'text': query,
            'area': area_id,
            'per_page': 100,
            'page': page,
            'search_field': 'name'
        }
        data = http_get_json(HH_API_URL, params)
        items = data.get('items', [])
        if not items:
            break
            
        jobs.extend(items)
        if page >= data.get('pages', 1) - 1:
            break
        time.sleep(PAUSE)
        
    return jobs


def fetch_hh_ru():
    return fetch_hh_base(113)  


def fetch_rabota_by():
    return fetch_hh_base(16)   


def normalize_hh(j, today, source_name='hh_ru'):
    sal_text = None
    if j.get('salary'):
        s = j['salary']
        sal_val = s.get('from') or s.get('to')
        sal_text = f"{sal_val} - {s.get('to') or sal_val} {s.get('currency')} per month"

    snippet = j.get('snippet') or {}
    desc = f"{snippet.get('requirement', '')} {snippet.get('responsibility', '')}"

    employer = j.get('employer', {}).get('name')
    location = j.get('area', {}).get('name')
    schedule = j.get('schedule', {}).get('id')
    employment = j.get('employment', {}).get('name')

    posting, skills = build_posting(
        source=source_name,
        source_id=j.get('id'),
        title=j.get('name'),
        company=employer,
        category=None,
        tags=[],
        description=desc,
        location=location,
        is_remote=(schedule == 'remote'),
        job_type=employment,
        url=j.get('alternate_url'),
        published=j.get('published_at'),
        salary_text=sal_text,
        today=today
    )
    return posting, skills


def normalize_hh_ru(j, today):
    return normalize_hh(j, today, source_name='hh_ru')


def normalize_rabota_by(j, today):
    return normalize_hh(j, today, source_name='rabota_by')


SOURCES = {
    'hh_ru': (fetch_hh_ru, normalize_hh_ru),
    'rabota_by': (fetch_rabota_by, normalize_rabota_by),
}

# ================================================================ quality
def quality_checks(postings: list, fetched: int) -> list:
    warn = []
    now = datetime.now(timezone.utc).isoformat()
    if fetched and not postings:
        warn.append('после фильтра по ролям не осталось ни одной вакансии: проверьте правила ROLE_RULES')
    with_salary = sum(1 for p in postings if p['salary_year_eur'])
    if postings and with_salary / len(postings) < 0.05 and any(p['source'] == 'remotive' for p in postings):
        warn.append(f'зарплата распознана у {with_salary} из {len(postings)}: возможно, поменялся формат поля salary')
    if any((p['published_at'] or '') > now for p in postings):
        warn.append('есть вакансии с датой публикации в будущем')
    if any(not p['url'] for p in postings):
        warn.append('есть вакансии без ссылки')
    return warn

# ================================================================ load
def existing_first_seen(sb, source):
    out, offset = {}, 0
    while True:
        res = sb.table('job_postings').select('job_key,first_seen_date').eq('source', source).range(offset, offset + 999).execute()
        out.update({r['job_key']: r['first_seen_date'] for r in res.data})
        if len(res.data) < 1000:
            return out
        offset += 1000

def load(sb, source, postings, skills_by_key, raw_rows, today):
    known = existing_first_seen(sb, source)
    for p in postings:
        p['first_seen_date'] = known.get(p['job_key'], today.isoformat())
    new_jobs = sum(1 for p in postings if p['job_key'] not in known)

    for part in chunks(raw_rows, 200):
        sb.table('jobs_raw').upsert(part, on_conflict='source,source_id,fetched_date').execute()
    for part in chunks(postings, 200):
        sb.table('job_postings').upsert(part, on_conflict='job_key').execute()
    keys = [p['job_key'] for p in postings]
    for part in chunks(keys, 100):                               
        sb.table('job_posting_skills').delete().in_('job_key', part).execute()
    skill_rows = [{'job_key': k, 'skill': s} for k, ss in skills_by_key.items() for s in ss]
    for part in chunks(skill_rows, 500):
        sb.table('job_posting_skills').insert(part).execute()
    cutoff = (today - timedelta(days=RAW_RETENTION_DAYS)).isoformat()
    sb.table('jobs_raw').delete().lt('fetched_date', cutoff).execute()
    return new_jobs

def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]

# ================================================================ запуск источника
def run_source(name, sb, dry_run=False, seen_pairs=None):
    fetch, normalize = SOURCES[name]
    today = datetime.now(timezone.utc).date()
    started = datetime.now(timezone.utc).isoformat()
    stats = {'source': name, 'started_at': started, 'status': 'ok', 'fetched': 0, 'kept': 0, 'new_jobs': 0, 'notes': None}
    seen_pairs = seen_pairs if seen_pairs is not None else set()
    try:
        raw_jobs = fetch()
        stats['fetched'] = len(raw_jobs)
        postings, skills_by_key, raw_rows, dupes = [], {}, [], 0
        for j in raw_jobs:
            try:
                posting, skills = normalize(j, today)
            except (KeyError, TypeError) as e:
                print(f'  пропущена запись без обязательного поля: {e}')
                continue
            if posting['role_group'] == 'Other':
                continue
            pair = ((posting['company'] or '').lower(), posting['title'].lower())      
            if pair in seen_pairs:
                dupes += 1
                continue
            seen_pairs.add(pair)
            postings.append(posting)
            skills_by_key[posting['job_key']] = skills
            raw_rows.append({'source': name, 'source_id': posting['source_id'], 'fetched_date': today.isoformat(),
                             'payload': {k: v for k, v in j.items() if k != 'description'}})     
        stats['kept'] = len(postings)
        eligible = len(postings) + dupes                          
        warnings = quality_checks(postings, len(raw_jobs)) if eligible else quality_checks([], len(raw_jobs))
        if postings == [] and dupes:
            warnings = [w for w in warnings if 'не осталось' not in w]
        if dupes:
            warnings.append(f'дублей между источниками отброшено: {dupes}')
        stats['notes'] = '; '.join(warnings) or None
        with_sal = sum(1 for p in postings if p['salary_year_eur'])
        print(f'  {name}: получено {len(raw_jobs)}, оставлено {len(postings)}, с зарплатой {with_sal}' + (f', предупреждения: {stats["notes"]}' if stats['notes'] else ''))
        if not dry_run:
            if eligible == 0:
                raise RuntimeError('нечего загружать (0 вакансий после фильтра по ролям)')
            if postings:
                stats['new_jobs'] = load(sb, name, postings, skills_by_key, raw_rows, today)
                print(f'  {name}: новых вакансий {stats["new_jobs"]}')
    except Exception as e:                                       
        stats['status'] = 'error'
        stats['notes'] = f'{type(e).__name__}: {e}'[:500]
        print(f'  {name}: ОШИБКА {stats["notes"]}')
    finally:
        stats['finished_at'] = datetime.now(timezone.utc).isoformat()
        if not dry_run and sb is not None:
            try:
                sb.table('jobs_etl_log').insert(stats).execute()
            except Exception as e:
                print(f'  не удалось записать журнал запуска: {e}')
    return stats

def main(argv=None):
    ap = argparse.ArgumentParser(description='Jobs ETL')
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run', help='скачать, нормализовать и загрузить вакансии')
    r.add_argument('--source', choices=['all', *SOURCES], default='all')
    r.add_argument('--dry-run', action='store_true', help='ничего не писать в БД')
    args = ap.parse_args(argv)

    sb = None
    if not args.dry_run:
        # Убедись, что nba_etl.py лежит в той же папке для импорта get_client
        from nba_etl import get_client
        sb = get_client()
    names = list(SOURCES) if args.source == 'all' else [args.source]
    print(f'--- Вакансии: {", ".join(names)}{" (dry-run)" if args.dry_run else ""} ---')
    seen, failed = set(), 0
    for name in names:
        failed += run_source(name, sb, args.dry_run, seen)['status'] == 'error'
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()