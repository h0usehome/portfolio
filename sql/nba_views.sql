-- ============================================================================
-- Слой для сайта: страница sport.html читает ТОЛЬКО эти view и ничего больше.
-- Выполните целиком в Supabase SQL Editor.
-- "Прошлая ночь" = последний игровой день в таблице games.
-- ============================================================================

-- 0. Новости (заполняет скрипт: python3 nba_etl.py news)
create table if not exists news (
  id           bigserial primary key,
  url          text not null unique,
  title        text not null,
  source       text,
  summary      text,
  published_at timestamptz not null,
  fetched_at   timestamptz not null default now()
);
create index if not exists idx_news_published on news (published_at desc);
alter table news add column if not exists topic text not null default 'nba';   -- общая таблица для NBA и F1

-- 1. Игры последнего игрового дня
create or replace view v_nba_last_games as
select g.game_id, g.game_date,
       g.home_team_id,    ht.abbreviation as home_abbr,    ht.city || ' ' || ht.name as home_name,    g.home_pts,
       g.visitor_team_id, vt.abbreviation as visitor_abbr, vt.city || ' ' || vt.name as visitor_name, g.visitor_pts
from games g
join teams ht on ht.team_id = g.home_team_id
join teams vt on vt.team_id = g.visitor_team_id
where g.game_date = (select max(game_date) from games)
order by g.game_id;

-- 2. Броски этих игр (для heatmap и статистики)
create or replace view v_nba_last_shots as
select s.shot_id, s.game_id, s.team_id, t.abbreviation as team_abbr,
       s.player_id, coalesce(p.first_name || ' ' || p.last_name, s.player_id) as player_name,
       s.quarter, s.coord_x, s.coord_y, s.is_made, s.shot_value, s.distance_ft
from shots s
join games g on g.game_id = s.game_id
join teams t on t.team_id = s.team_id
left join players p on p.player_id = s.player_id
where g.game_date = (select max(game_date) from games);

-- 3. Топ-5 игроков ночи. Формула: очки + передачи - потери (потери вычитаются).
--    Чтобы считать "очки + передачи + потери", замените (s.pts + s.ast - s.tov) на (s.pts + s.ast + s.tov)
create or replace view v_nba_top_players as
select s.player_id,
       p.first_name || ' ' || p.last_name as player_name,
       t.abbreviation as team_abbr,
       s.game_id, s.min, s.pts, s.ast, s.tov,
       (s.pts + s.ast - s.tov) as score
from player_game_stats s
join games g   on g.game_id = s.game_id
join players p on p.player_id = s.player_id
join teams t   on t.team_id = s.team_id
where g.game_date = (select max(game_date) from games)
order by score desc, s.pts desc
limit 5;

-- 4. Лучшие связки (сезонные данные) команд, игравших в последнюю ночь: топ-5 для пар и для троек
create or replace view v_nba_best_lineups as
with night_teams as (
  select home_team_id as team_id from games where game_date = (select max(game_date) from games)
  union
  select visitor_team_id from games where game_date = (select max(game_date) from games)
),
ranked as (
  select l.team_id, l.season, l.lineup_type, l.minutes_played, l.pts_per_100_poss, l.plus_minus,
         l.players_array as player_ids,
         (select string_agg(coalesce(p.last_name, u.pid), ' / ' order by u.ord)
            from unnest(l.players_array) with ordinality as u(pid, ord)
            left join players p on p.player_id = u.pid) as lineup,
         row_number() over (partition by l.lineup_type order by l.pts_per_100_poss desc) as rn
  from team_lineups l
  join night_teams n using (team_id)
  where l.season = (select max(season) from team_lineups)
    and l.minutes_played >= case when l.lineup_type = 5 then 50 else 100 end   -- пятёрки играют вместе реже
)
select r.team_id, t.abbreviation as team_abbr, r.season, r.lineup_type, r.lineup,
       r.minutes_played, r.pts_per_100_poss, r.plus_minus, r.rn as rank,
       r.player_ids                                   -- id игроков связки: по ним сайт подставляет фото
from ranked r
join teams t using (team_id)
where r.rn <= 5
order by r.lineup_type, r.rn;

-- 5. Новости: последние 40 (сайт сам отделяет последние сутки)
create or replace view v_nba_news as
select id, title, url, source, published_at
from news
where topic = 'nba'
order by published_at desc
limit 40;

-- 6. Доступ для сайта (ключ anon): только чтение этих view
grant usage on schema public to anon;
grant select on v_nba_last_games, v_nba_last_shots, v_nba_top_players, v_nba_best_lineups, v_nba_news to anon;

-- 7. Индексы для скорости
create index if not exists idx_games_date      on games (game_date);
create index if not exists idx_shots_game      on shots (game_id);
create index if not exists idx_pgs_game        on player_game_stats (game_id);
create index if not exists idx_lineups_season  on team_lineups (season, lineup_type, pts_per_100_poss desc);

-- ============================================================================
-- ПРОВЕРКИ после выполнения
-- ============================================================================
-- select * from v_nba_last_games;
-- select count(*) from v_nba_last_shots;
-- select * from v_nba_top_players;
-- select * from v_nba_best_lineups;

-- Калибровка координат: насколько расстояние, посчитанное по coord_x/coord_y, совпадает с distance_ft.
-- Если средняя разница заметно больше 1-2 футов, поправьте COURT.bx, COURT.by и COURT.bin в sport.js.
-- select round(avg(abs(sqrt(power(coord_x - 250, 2) + power(coord_y - 52, 2)) / 10 - distance_ft)), 2) as avg_diff_ft from shots;
