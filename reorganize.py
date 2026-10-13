#!/usr/bin/env python3
"""
Раскладывает файлы репозитория по папкам и правит пути в коде.

Запуск из КОРНЯ репозитория (там, где лежит index.html):
  python3 reorganize.py            # только показать план, ничего не менять
  python3 reorganize.py --apply    # выполнить

Что делает:
  1. переносит файлы (через git mv, если это git-репозиторий, иначе обычным переносом)
  2. правит пути в index.html, sport.html, f1.html, jobs.html (css, js, картинки, favicon)
  3. правит workflow (пути и запуск), тест (путь к модулю) и создаёт pytest.ini и .gitignore
  4. проверяет все локальные ссылки в HTML и CSS и сообщает, что не найдено
"""
import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

WEB = {   # то, на что ссылаются HTML-страницы
    'style.css': 'assets/css/style.css', 'sport.css': 'assets/css/sport.css',
    'f1.css': 'assets/css/f1.css', 'jobs.css': 'assets/css/jobs.css', 'pipeline.css': 'assets/css/pipeline.css',
    'sport.js': 'assets/js/sport.js', 'f1.js': 'assets/js/f1.js', 'jobs.js': 'assets/js/jobs.js',
    'pipeline.js': 'assets/js/pipeline.js', 'pipeline-examples.js': 'assets/js/pipeline-examples.js',
    'photo.jpg': 'assets/img/photo.jpg', 'favicon.svg': 'assets/img/favicon.svg',
}
BACKEND = {
    'nba_etl.py': 'etl/nba_etl.py', 'f1_etl.py': 'etl/f1_etl.py', 'jobs_etl.py': 'etl/jobs_etl.py', 'build_pipeline_examples.py': 'etl/build_pipeline_examples.py',
    'nba_views.sql': 'sql/nba_views.sql', 'f1_views.sql': 'sql/f1_views.sql', 'jobs_views.sql': 'sql/jobs_views.sql',
    'test_jobs_etl.py': 'tests/test_jobs_etl.py', 'jobs-etl.yml': '.github/workflows/jobs-etl.yml',
}
ALL = {**WEB, **BACKEND}
REF = re.compile(r'''(?P<attr>\b(?:href|src))=(?P<q>["'])(?P<pre>\./|/)?(?P<name>[^"'/#?]+)(?P<rest>[?#][^"']*)?(?P=q)''')


def run_git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True)


def move(src: Path, dst: Path, use_git: bool):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if use_git and run_git('mv', str(src), str(dst)).returncode == 0:
        return
    shutil.move(str(src), str(dst))


def fix_html(text: str):
    changed = []
    def repl(m):
        name = m.group('name')
        if name in WEB:
            changed.append(name)
            return f'{m.group("attr")}={m.group("q")}{WEB[name]}{m.group("rest") or ""}{m.group("q")}'
        return m.group(0)
    return REF.sub(repl, text), changed


def check_links(root: Path):
    problems = []
    for html in sorted(root.glob('*.html')):
        for m in re.finditer(r'''(?:href|src)=["']([^"']+)["']''', html.read_text(encoding='utf-8')):
            ref = m.group(1).split('#')[0].split('?')[0]
            if not ref or re.match(r'^(https?:|mailto:|tel:|data:|javascript:|//)', ref):
                continue
            if not (html.parent / ref).exists():
                problems.append(f'{html.name}: не найден файл {ref}')
    for css in sorted(root.rglob('*.css')):
        if '.git' in css.parts:
            continue
        for m in re.finditer(r'url\(\s*["\']?([^)"\']+)["\']?\s*\)', css.read_text(encoding='utf-8')):
            ref = m.group(1)
            if re.match(r'^(https?:|data:|//|#)', ref):
                continue
            if not (css.parent / ref.split('?')[0].split('#')[0]).exists():
                problems.append(f'{css.relative_to(root)}: url() не найден {ref}')
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    root = Path.cwd()
    if not (root / 'index.html').exists():
        sys.exit('Запускайте из корня репозитория: рядом должен лежать index.html')
    use_git = (root / '.git').exists() and shutil.which('git') is not None
    print(f'Режим: {"ВЫПОЛНЕНИЕ" if args.apply else "только план (добавьте --apply)"}; перенос через {"git mv" if use_git else "обычный перенос"}\n')

    print('1. Перенос файлов')
    moved = []
    for old, new in ALL.items():
        src, dst = root / old, root / new
        if not src.exists():
            continue
        if dst.exists():
            print(f'   пропуск {old}: {new} уже существует')
            continue
        print(f'   {old}  ->  {new}')
        moved.append((src, dst))
        if args.apply:
            move(src, dst, use_git)
    if not moved:
        print('   переносить нечего')

    print('\n2. Пути в HTML')
    for html in sorted(root.glob('*.html')):
        text = html.read_text(encoding='utf-8')
        new, changed = fix_html(text)
        if changed:
            print(f'   {html.name}: {", ".join(sorted(set(changed)))}')
            if args.apply:
                html.write_text(new, encoding='utf-8')

    print('\n3. Workflow, тест, pytest.ini, .gitignore')
    wf = root / ('.github/workflows/jobs-etl.yml' if args.apply else 'jobs-etl.yml')
    if not wf.exists():
        wf = root / '.github/workflows/jobs-etl.yml'
    if wf.exists():
        t = wf.read_text(encoding='utf-8'); n = t
        n = n.replace("paths: ['jobs_etl.py', 'tests/**', 'requirements.txt']", "paths: ['etl/**', 'tests/**', 'requirements.txt']")
        n = re.sub(r'python3? jobs_etl\.py', 'python etl/jobs_etl.py', n)
        print(f'   workflow: {"правки есть" if n != t else "уже в порядке"}')
        if args.apply and n != t:
            wf.write_text(n, encoding='utf-8')
    tf = root / ('tests/test_jobs_etl.py' if (root / 'tests/test_jobs_etl.py').exists() else 'test_jobs_etl.py')
    if tf.exists():
        t = tf.read_text(encoding='utf-8')
        old = "sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))"
        new = "sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'etl'))"
        print(f'   тест: {"путь к etl/ будет исправлен" if old in t else "строка с путём не найдена или уже исправлена"}')
        if args.apply and old in t:
            tf.write_text(t.replace(old, new), encoding='utf-8')
    for name, content in (('pytest.ini', '[pytest]\npythonpath = etl\ntestpaths = tests\n'),):
        if not (root / name).exists():
            print(f'   создаётся {name}')
            if args.apply:
                (root / name).write_text(content, encoding='utf-8')
    gi = root / '.gitignore'
    need = ['.env', 'venv/', '__pycache__/', '.pytest_cache/', '.DS_Store']
    have = gi.read_text(encoding='utf-8').splitlines() if gi.exists() else []
    add = [x for x in need if x not in have]
    if add:
        print(f'   .gitignore: добавится {", ".join(add)}')
        if args.apply:
            gi.write_text('\n'.join(have + add) + '\n', encoding='utf-8')

    if args.apply:
        print('\n4. Проверка ссылок')
        problems = check_links(root)
        print('   все локальные ссылки в HTML и CSS найдены' if not problems else '\n'.join('   ВНИМАНИЕ: ' + p for p in problems))
        print('\nГотово. Проверьте сайт локально: python3 -m http.server 8000, затем откройте http://localhost:8000')
    else:
        print('\nЭто был только план. Если всё устраивает, запустите: python3 reorganize.py --apply')


if __name__ == '__main__':
    main()
