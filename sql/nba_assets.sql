-- ============================================================================
-- Логотипы команд и фото игроков для страницы NBA.
-- Хранятся ССЫЛКИ на NBA CDN, сами изображения в базу не копируются (права на них у лиги и клубов).
-- Выполните ЦЕЛИКОМ в Supabase SQL Editor, затем выполните nba_views.sql.
-- ============================================================================

create table if not exists nba_team_assets (
  team_id     text primary key,                 -- код как в teams.team_id (Basketball-Reference: BRK, CHO, PHO)
  nba_team_id int  not null,
  logo_url    text not null
);

insert into nba_team_assets (team_id, nba_team_id, logo_url) values
  ('ATL', 1610612737, 'https://cdn.nba.com/logos/nba/1610612737/global/L/logo.svg'),
  ('BOS', 1610612738, 'https://cdn.nba.com/logos/nba/1610612738/global/L/logo.svg'),
  ('BRK', 1610612751, 'https://cdn.nba.com/logos/nba/1610612751/global/L/logo.svg'),
  ('CHI', 1610612741, 'https://cdn.nba.com/logos/nba/1610612741/global/L/logo.svg'),
  ('CHO', 1610612766, 'https://cdn.nba.com/logos/nba/1610612766/global/L/logo.svg'),
  ('CLE', 1610612739, 'https://cdn.nba.com/logos/nba/1610612739/global/L/logo.svg'),
  ('DAL', 1610612742, 'https://cdn.nba.com/logos/nba/1610612742/global/L/logo.svg'),
  ('DEN', 1610612743, 'https://cdn.nba.com/logos/nba/1610612743/global/L/logo.svg'),
  ('DET', 1610612765, 'https://cdn.nba.com/logos/nba/1610612765/global/L/logo.svg'),
  ('GSW', 1610612744, 'https://cdn.nba.com/logos/nba/1610612744/global/L/logo.svg'),
  ('HOU', 1610612745, 'https://cdn.nba.com/logos/nba/1610612745/global/L/logo.svg'),
  ('IND', 1610612754, 'https://cdn.nba.com/logos/nba/1610612754/global/L/logo.svg'),
  ('LAC', 1610612746, 'https://cdn.nba.com/logos/nba/1610612746/global/L/logo.svg'),
  ('LAL', 1610612747, 'https://cdn.nba.com/logos/nba/1610612747/global/L/logo.svg'),
  ('MEM', 1610612763, 'https://cdn.nba.com/logos/nba/1610612763/global/L/logo.svg'),
  ('MIA', 1610612748, 'https://cdn.nba.com/logos/nba/1610612748/global/L/logo.svg'),
  ('MIL', 1610612749, 'https://cdn.nba.com/logos/nba/1610612749/global/L/logo.svg'),
  ('MIN', 1610612750, 'https://cdn.nba.com/logos/nba/1610612750/global/L/logo.svg'),
  ('NOP', 1610612740, 'https://cdn.nba.com/logos/nba/1610612740/global/L/logo.svg'),
  ('NYK', 1610612752, 'https://cdn.nba.com/logos/nba/1610612752/global/L/logo.svg'),
  ('OKC', 1610612760, 'https://cdn.nba.com/logos/nba/1610612760/global/L/logo.svg'),
  ('ORL', 1610612753, 'https://cdn.nba.com/logos/nba/1610612753/global/L/logo.svg'),
  ('PHI', 1610612755, 'https://cdn.nba.com/logos/nba/1610612755/global/L/logo.svg'),
  ('PHO', 1610612756, 'https://cdn.nba.com/logos/nba/1610612756/global/L/logo.svg'),
  ('POR', 1610612757, 'https://cdn.nba.com/logos/nba/1610612757/global/L/logo.svg'),
  ('SAC', 1610612758, 'https://cdn.nba.com/logos/nba/1610612758/global/L/logo.svg'),
  ('SAS', 1610612759, 'https://cdn.nba.com/logos/nba/1610612759/global/L/logo.svg'),
  ('TOR', 1610612761, 'https://cdn.nba.com/logos/nba/1610612761/global/L/logo.svg'),
  ('UTA', 1610612762, 'https://cdn.nba.com/logos/nba/1610612762/global/L/logo.svg'),
  ('WAS', 1610612764, 'https://cdn.nba.com/logos/nba/1610612764/global/L/logo.svg')
on conflict (team_id) do update set nba_team_id = excluded.nba_team_id, logo_url = excluded.logo_url;

create table if not exists nba_player_assets (   -- заполняется командой: python3 etl/nba_etl.py assets
  player_id     text primary key,                -- как в players.player_id
  nba_person_id int  not null,
  photo_url     text not null,
  updated_at    timestamptz not null default now()
);

-- Представления для сайта (читаются ключом anon)
create or replace view v_nba_team_assets as
select team_id, logo_url from nba_team_assets;

create or replace view v_nba_player_assets as
select a.player_id,
       coalesce(nullif(trim(p.first_name || ' ' || p.last_name), ''), a.player_id) as player_name,
       a.photo_url
from nba_player_assets a
left join players p on p.player_id = a.player_id;

grant usage on schema public to anon;
grant select on v_nba_team_assets, v_nba_player_assets to anon;

-- Проверки:
-- select count(*) from nba_team_assets;                       -- 30
-- select count(*) from nba_player_assets;                     -- после python3 etl/nba_etl.py assets
-- select p.player_id from players p where not exists (select 1 from nba_player_assets a where a.player_id = p.player_id);   -- кому не нашлось фото
