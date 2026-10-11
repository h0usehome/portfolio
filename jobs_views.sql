-- ============================================================================
-- Рынок вакансий аналитиков: таблицы и view для страницы jobs.html.
-- Выполните целиком в Supabase SQL Editor.
-- Вакансия считается активной, если её видели не позже 2 дней назад (ACTIVE_WINDOW_DAYS в jobs_etl.py).
-- ============================================================================

-- 1. Таблицы
create table if not exists job_postings (
  job_key         text primary key,                     -- источник:id, например remotive:123
  source          text not null,
  source_id       text not null,
  title           text not null,
  company         text,
  role_group      text not null,
  seniority       text not null check (seniority in ('Junior', 'Middle', 'Senior')),
  location_raw    text,
  is_remote       boolean not null default false,
  job_type        text,
  url             text not null,
  published_at    timestamptz,
  first_seen_date date not null,
  last_seen_date  date not null,
  salary_min      numeric, salary_max numeric, salary_currency text, salary_period text,
  salary_year_eur numeric,                              -- середина вилки в EUR/год по приблизительным курсам
  unique (source, source_id)
);
create table if not exists job_posting_skills (
  job_key text not null references job_postings (job_key) on delete cascade,
  skill   text not null,
  primary key (job_key, skill)
);
create table if not exists jobs_raw (                   -- сырые снимки без текстов описаний, хранятся 30 дней
  source text not null, source_id text not null, fetched_date date not null, payload jsonb not null,
  primary key (source, source_id, fetched_date)
);
create table if not exists jobs_etl_log (
  id bigserial primary key,
  source text not null, started_at timestamptz, finished_at timestamptz,
  status text not null check (status in ('ok', 'error')),
  fetched int, kept int, new_jobs int, notes text
);
create index if not exists idx_jobs_last_seen on job_postings (last_seen_date);
create index if not exists idx_jobs_first_seen on job_postings (first_seen_date);
create index if not exists idx_jobs_role on job_postings (role_group, seniority);
create index if not exists idx_job_skills_skill on job_posting_skills (skill);
create index if not exists idx_jobs_log_started on jobs_etl_log (started_at desc);

-- 2. View для сайта (страница читает только их)

-- Активные вакансии с массивом навыков: на этом строятся фильтры, heatmap и KPI в браузере
create or replace view v_jobs_active as
select p.job_key, p.source, p.company, p.role_group, p.seniority, p.is_remote,
       p.salary_year_eur, p.first_seen_date, p.published_at,
       coalesce(array_agg(s.skill order by s.skill) filter (where s.skill is not null), '{}') as skills
from job_postings p
left join job_posting_skills s using (job_key)
where p.last_seen_date >= current_date - 2
group by p.job_key;

-- Свежие вакансии со ссылкой на источник (показываем только метаданные и ссылку, без текста объявлений)
create or replace view v_jobs_latest as
select job_key, title, company, role_group, seniority, location_raw, is_remote, source, url, published_at
from job_postings
where last_seen_date >= current_date - 2
order by published_at desc nulls last
limit 12;

-- Динамика: сколько вакансий было активно в каждый из последних 90 дней и сколько появилось
-- (в первые дни после запуска история ещё копится: это нормально, график растёт вместе с данными)
create or replace view v_jobs_trend as
select d::date as day, p.role_group,
       count(*)                                          as active_jobs,
       count(*) filter (where p.first_seen_date = d::date) as new_jobs
from generate_series(current_date - 89, current_date, interval '1 day') d
join job_postings p on p.first_seen_date <= d::date and p.last_seen_date >= d::date
group by 1, 2
order by 1, 2;

-- Здоровье пайплайна: последние 20 запусков
create or replace view v_jobs_etl_health as
select id, source, started_at, finished_at, status, fetched, kept, new_jobs, notes
from jobs_etl_log
order by started_at desc nulls last
limit 20;

-- 3. Доступ для сайта (ключ anon): только чтение view
grant usage on schema public to anon;
grant select on v_jobs_active, v_jobs_latest, v_jobs_trend, v_jobs_etl_health to anon;

-- ============================================================================
-- Примеры аналитических запросов (для портфолио и проверки)
-- ============================================================================

-- Зарплатные процентили по роли и уровню (только вакансии с зарплатой; n показывает надёжность)
-- select role_group, seniority, count(*) as n,
--        round(percentile_cont(0.25) within group (order by salary_year_eur)) as p25,
--        round(percentile_cont(0.50) within group (order by salary_year_eur)) as median,
--        round(percentile_cont(0.75) within group (order by salary_year_eur)) as p75
-- from job_postings where salary_year_eur is not null and last_seen_date >= current_date - 2
-- group by 1, 2 having count(*) >= 5 order by 1, 2;

-- Навыки: частота и разница медианной зарплаты с общей (премия навыка)
-- with base as (select percentile_cont(0.5) within group (order by salary_year_eur) as m from job_postings where salary_year_eur is not null)
-- select s.skill, count(*) as jobs,
--        round(percentile_cont(0.5) within group (order by p.salary_year_eur)) as median_salary,
--        round(percentile_cont(0.5) within group (order by p.salary_year_eur) - (select m from base)) as premium
-- from job_posting_skills s join job_postings p using (job_key)
-- where p.salary_year_eur is not null group by 1 having count(*) >= 5 order by premium desc;

-- Время жизни вакансии (прокси срока закрытия): сколько дней вакансия присутствовала на досках
-- select role_group, round(avg(last_seen_date - first_seen_date), 1) as avg_days_listed, count(*) as jobs
-- from job_postings where last_seen_date < current_date - 2 group by 1 order by 2 desc;
