"""Тесты сопоставления игроков с каталогом NBA: python3 -m pytest -q"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'etl'))
if 'supabase' not in sys.modules:                      # клиент базы в тестах не нужен
    stub = types.ModuleType('supabase'); stub.Client = object; stub.create_client = lambda *a, **k: None; sys.modules['supabase'] = stub
import nba_etl as e   # noqa: E402

CATALOG = [
    {'id': 203999, 'full_name': 'Nikola Jokić', 'is_active': True},
    {'id': 1629029, 'full_name': 'Luka Dončić', 'is_active': True},
    {'id': 1631170, 'full_name': 'Jaime Jaquez Jr.', 'is_active': True},
    {'id': 111, 'full_name': 'Chris Smith', 'is_active': False},      # тёзки: нужен действующий
    {'id': 222, 'full_name': 'Chris Smith', 'is_active': True},
]


def test_matches_by_normalized_name_and_prefers_active():
    known = {'nikolajokic', 'lukadoncic', 'jaimejaquezjr', 'chrissmith', 'unknownrookie'}
    rows, missing = e.build_player_assets(known, CATALOG)
    by = {r['player_id']: r for r in rows}
    assert by['nikolajokic']['nba_person_id'] == 203999
    assert by['lukadoncic']['photo_url'] == 'https://cdn.nba.com/headshots/nba/latest/260x190/1629029.png'
    assert by['chrissmith']['nba_person_id'] == 222                    # действующий игрок побеждает
    assert missing == ['unknownrookie']


def test_only_known_players_are_returned():
    rows, missing = e.build_player_assets({'nikolajokic'}, CATALOG)
    assert [r['player_id'] for r in rows] == ['nikolajokic'] and missing == []


def test_manual_override(monkeypatch):
    monkeypatch.setitem(e.PHOTO_OVERRIDES, 'unknownrookie', 999)
    rows, missing = e.build_player_assets({'unknownrookie'}, CATALOG)
    assert rows[0]['nba_person_id'] == 999 and missing == []
