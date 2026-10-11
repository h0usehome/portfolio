"""Тесты ETL вакансий: python3 -m pytest -q (из папки с jobs_etl.py)."""
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import jobs_etl as j   # noqa: E402


# ---------------------------------------------------------------- зарплаты
@pytest.mark.parametrize('text, lo, hi, cur, period', [
    ('$80,000 - $100,000', 80000, 100000, 'USD', 'year'),
    ('€50k-€70k', 50000, 70000, 'EUR', 'year'),
    ('70k - 90k USD', 70000, 90000, 'USD', 'year'),
    ('£45000 per year', 45000, 45000, 'GBP', 'year'),
    ('$40/hour', 83200, 83200, 'USD', 'hour'),
    ('4000-5000 EUR per month', 48000, 60000, 'EUR', 'month'),
    ('€3500 monthly', 42000, 42000, 'EUR', 'month'),
])
def test_parse_salary_ok(text, lo, hi, cur, period):
    s = j.parse_salary(text)
    assert (s['min'], s['max'], s['currency'], s['period']) == (lo, hi, cur, period)


@pytest.mark.parametrize('text', [None, '', '   ', 'competitive', '$1', '$99999999', 'negotiable salary'])
def test_parse_salary_rejects_noise(text):
    assert j.parse_salary(text) is None


def test_salary_year_eur_uses_midpoint_and_fx():
    s = j.parse_salary('$80,000 - $100,000')
    assert j.salary_year_eur(s) == round(90000 * j.FX_TO_EUR['USD'])
    assert j.salary_year_eur(j.parse_salary('80000-100000')) is None      # валюта неизвестна: честно не пересчитываем


# ---------------------------------------------------------------- роли и уровни
@pytest.mark.parametrize('title, role', [
    ('Senior Data Analyst', 'Data Analyst'), ('Analytics Engineer (dbt)', 'Analytics Engineer'),
    ('Data Engineer, Platform', 'Data Engineer'), ('Machine Learning Engineer', 'Data Scientist / ML'),
    ('BI Developer', 'BI / Reporting'), ('Power BI Specialist', 'BI / Reporting'), ('Sales Manager', 'Other'),
])
def test_classify_role(title, role):
    assert j.classify_role(title) == role


def test_classify_role_category_fallback():
    assert j.classify_role('Quantitative Wizard', 'Data') == 'Other data'
    assert j.classify_role('Quantitative Wizard', 'Marketing') == 'Other'


@pytest.mark.parametrize('title, level', [
    ('Junior Data Analyst', 'Junior'), ('Data Analyst Intern', 'Junior'), ('Senior BI Analyst', 'Senior'),
    ('Head of Data', 'Senior'), ('Lead Data Engineer', 'Senior'), ('Data Analyst', 'Middle'),
])
def test_classify_seniority(title, level):
    assert j.classify_seniority(title) == level


# ---------------------------------------------------------------- навыки
def test_extract_skills_basic():
    text = 'We use SQL, Python (pandas), Power BI and dbt on Snowflake. Experience with AWS is a plus.'
    assert j.extract_skills(text) == ['AWS', 'Pandas', 'Power BI', 'Python', 'SQL', 'Snowflake', 'dbt']


def test_extract_skills_no_false_positives():
    s = j.extract_skills('NoSQL databases, MySQL, R&D department, Rust and Go services, plan R3')
    assert 'SQL' not in s and 'R' not in s       # NoSQL, R&D и «R3» не должны давать навыки SQL и R
    assert 'MySQL' in s


def test_extract_skill_r_in_context():
    assert 'R' in j.extract_skills('Proficient in Python, R, and SQL')
    assert 'R' in j.extract_skills('experience with R programming')


def test_strip_html():
    assert 'SQL' in j.extract_skills(j.strip_html('<p>Strong <b>SQL</b>&nbsp;skills</p>'))


# ---------------------------------------------------------------- нормализация источников
TODAY = date(2026, 10, 9)


def test_normalize_remotive_posting():
    raw = {'id': 123, 'url': 'https://remotive.com/x', 'title': 'Senior Data Analyst', 'company_name': 'Acme', 'category': 'Data',
           'tags': ['sql', 'tableau'], 'job_type': 'full_time', 'publication_date': '2026-10-08T10:15:00',
           'candidate_required_location': 'Europe', 'salary': '$80,000 - $100,000', 'description': '<p>Python and SQL</p>'}
    p, skills = j.normalize_remotive(raw, TODAY)
    assert p['job_key'] == 'remotive:123' and p['role_group'] == 'Data Analyst' and p['seniority'] == 'Senior'
    assert p['is_remote'] is True and p['published_at'].startswith('2026-10-08T10:15:00')
    assert p['salary_year_eur'] == round(90000 * j.FX_TO_EUR['USD'])
    assert 'description' not in p                      # описание в модель не попадает
    assert {'Python', 'SQL', 'Tableau'} <= set(skills)


def test_normalize_arbeitnow_epoch_and_remote():
    raw = {'slug': 'bi-dev-berlin-1', 'title': 'BI Developer', 'company_name': 'Firma', 'description': '<b>Power BI</b>', 'remote': False,
           'url': 'https://www.arbeitnow.com/jobs/bi-dev', 'tags': [], 'job_types': ['full time'], 'location': 'Berlin', 'created_at': 1790000000}
    p, skills = j.normalize_arbeitnow(raw, TODAY)
    assert p['source'] == 'arbeitnow' and p['is_remote'] is False and p['location_raw'] == 'Berlin'
    assert p['published_at'].startswith('2026-')
    assert skills == ['Power BI'] and p['salary_year_eur'] is None


def test_iso_utc_variants():
    assert j.iso_utc(None) is None and j.iso_utc('garbage') is None
    assert j.iso_utc('2026-10-08T10:15:00Z').endswith('+00:00')


# ---------------------------------------------------------------- проверки качества
def _p(**kw):
    base = {'source': 'remotive', 'salary_year_eur': 50000, 'published_at': '2020-01-01T00:00:00+00:00', 'url': 'https://x'}
    return {**base, **kw}


def test_quality_checks_flags_problems():
    assert j.quality_checks([_p(), _p()], 2) == []
    assert any('не осталось' in w for w in j.quality_checks([], 10))
    assert any('в будущем' in w for w in j.quality_checks([_p(published_at='2999-01-01T00:00:00+00:00')], 1))
    assert any('без ссылки' in w for w in j.quality_checks([_p(url=None)], 1))
    many = [_p(salary_year_eur=None) for _ in range(30)]
    assert any('зарплата распознана' in w for w in j.quality_checks(many, 30))


# ---------------------------------------------------------------- сквозной прогон на подставных данных
class FakeTable:
    def __init__(self, db, name): self.db, self.name, self.op, self.p = db, name, None, None
    def select(self, *a): self.op = 'select'; return self
    def eq(self, *a): return self
    def lt(self, *a): return self
    def in_(self, *a): self.op = 'delete'; return self
    def range(self, *a): return self
    def upsert(self, p, **k): self.op, self.p = 'upsert', p; return self
    def insert(self, p): self.op, self.p = 'insert', p; return self
    def delete(self): self.op = 'delete'; return self
    def execute(self):
        class R: data = []
        if self.op in ('upsert', 'insert'):
            self.db.setdefault(self.name, []).extend(self.p if isinstance(self.p, list) else [self.p])
        return R()


class FakeClient:
    def __init__(self): self.db = {}
    def table(self, n): return FakeTable(self.db, n)


def test_run_source_end_to_end(monkeypatch):
    remotive = [{'id': 1, 'url': 'https://r/1', 'title': 'Data Analyst', 'company_name': 'A', 'category': 'Data', 'tags': [], 'job_type': 'full_time',
                 'publication_date': '2026-10-08T00:00:00', 'candidate_required_location': 'Worldwide', 'salary': '$60k-$80k', 'description': 'SQL Python'},
                {'id': 2, 'url': 'https://r/2', 'title': 'Marketing Manager', 'company_name': 'B', 'category': 'Marketing', 'tags': [], 'description': 'x'},
                {'title': 'broken record without id'}]
    monkeypatch.setitem(j.SOURCES, 'remotive', (lambda: remotive, j.normalize_remotive))
    fc = FakeClient()
    stats = j.run_source('remotive', fc)
    assert stats['status'] == 'ok' and stats['fetched'] == 3 and stats['kept'] == 1
    assert [p['job_key'] for p in fc.db['job_postings']] == ['remotive:1']
    assert {r['skill'] for r in fc.db['job_posting_skills']} == {'SQL', 'Python'}
    assert 'description' not in fc.db['jobs_raw'][0]['payload']
    assert fc.db['jobs_etl_log'][0]['status'] == 'ok'


def test_failing_source_is_logged_not_raised(monkeypatch):
    def boom(): raise RuntimeError('api down')
    monkeypatch.setitem(j.SOURCES, 'remotive', (boom, j.normalize_remotive))
    fc = FakeClient()
    stats = j.run_source('remotive', fc)
    assert stats['status'] == 'error' and 'api down' in stats['notes']
    assert fc.db['jobs_etl_log'][0]['status'] == 'error'


def test_cross_source_dedupe(monkeypatch):
    one = {'id': 1, 'url': 'https://r/1', 'title': 'Data Analyst', 'company_name': 'Same Co', 'category': 'Data', 'tags': [], 'description': 'SQL'}
    two = {'slug': 's1', 'title': 'Data Analyst', 'company_name': 'Same Co', 'description': 'SQL', 'remote': True, 'url': 'https://a/1', 'tags': [], 'job_types': [], 'location': 'X', 'created_at': 1790000000}
    monkeypatch.setitem(j.SOURCES, 'remotive', (lambda: [one], j.normalize_remotive))
    monkeypatch.setitem(j.SOURCES, 'arbeitnow', (lambda: [two], j.normalize_arbeitnow))
    fc, seen = FakeClient(), set()
    j.run_source('remotive', fc, seen_pairs=seen)
    stats = j.run_source('arbeitnow', fc, seen_pairs=seen)
    assert stats['kept'] == 0 and 'дублей' in (stats['notes'] or '')
