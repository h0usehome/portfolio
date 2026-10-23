"""
Генерирует pipeline-examples.js для страницы pipeline.html: примеры «до и после» получены запуском НАСТОЯЩЕГО кода jobs_etl.py,
поэтому страница не расходится с пайплайном. Запустите после любых изменений правил (роли, зарплаты, навыки):

  python3 build_pipeline_examples.py            # из корня репозитория или из etl/: python3 etl/build_pipeline_examples.py
"""
import json
import sys
from datetime import date
from pathlib import Path

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here))
if (here / 'etl' / 'jobs_etl.py').exists():
    sys.path.insert(0, str(here / 'etl'))
import jobs_etl as j   # noqa: E402

RAW = {'id': 48210, 'url': 'https://remotive.com/remote-jobs/data/senior-data-analyst-48210', 'title': 'Senior Data Analyst (Remote)',
       'company_name': 'Acme Analytics', 'category': 'Data', 'tags': ['sql', 'tableau'], 'job_type': 'full_time',
       'publication_date': '2026-10-09T08:15:00', 'candidate_required_location': 'Europe', 'salary': '$80k - $100k',
       'description': '<p>We use <b>SQL</b>, Python (pandas) and Power BI on Snowflake. A/B testing is a plus.</p>'}

posting, skills = j.normalize_remotive(RAW, date(2026, 10, 10))
shown = ['title', 'role_group', 'seniority', 'is_remote', 'published_at', 'salary_min', 'salary_max', 'salary_currency', 'salary_period', 'salary_year_eur']

salaries = []
for text in ['$80,000 - $100,000', '€50k-€70k', '$40/hour', '4000-5000 EUR per month', '£45000 per year', 'competitive', '$1']:
    s = j.parse_salary(text)
    salaries.append({'raw': text, 'parsed': None if s is None else {**s, 'year_eur': j.salary_year_eur(s)}})

roles = [{'raw': t, 'role': j.classify_role(t), 'level': j.classify_seniority(t)} for t in
         ['Senior Data Analyst', 'Analytics Engineer (dbt)', 'Junior BI Developer', 'Head of Data Engineering', 'ML Engineer', 'Sales Manager']]

skill_text = 'Strong SQL and Python (pandas). Experience with Power BI, dbt, Airflow and AWS. NoSQL knowledge, R&D mindset.'
out = {
    'raw': {k: RAW[k] for k in ['id', 'title', 'company_name', 'category', 'tags', 'publication_date', 'salary', 'description']},
    'normalized': {**{k: posting[k] for k in shown}, 'skills': skills},
    'salaries': salaries, 'roles': roles,
    'skills': {'text': skill_text, 'found': j.extract_skills(skill_text)},
    'rules': {'fx': j.FX_TO_EUR, 'active_window_days': j.ACTIVE_WINDOW_DAYS, 'skills_in_dictionary': len(j.SKILLS)},
}
root = here.parent if here.name == 'etl' else here          # корень репозитория
target = root / 'assets' / 'js' if (root / 'assets' / 'js').exists() else root
(target / 'pipeline-examples.js').write_text('window.PIPE_EXAMPLES = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';\n', encoding='utf-8')
print('записано:', target / 'pipeline-examples.js')
