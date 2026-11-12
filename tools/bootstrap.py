#!/usr/bin/env python3
"""Fetch the exact build dependencies pinned in third_party/sources.lock.json."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'third_party/sources.lock.json').read_text())

def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)

# Chiaki-NG core is a submodule pinned in .gitmodules.
run('git', '-C', ROOT, 'submodule', 'update', '--init', '--', 'third_party/chiaki')

for name, item in LOCK.items():
    dest = ROOT / ('toolchains' if name == 'emsdk' else 'third_party') / name
    if not dest.exists():
        dest.mkdir(parents=True)
        run('git', 'init', dest)
        run('git', '-C', dest, 'remote', 'add', 'origin', item['url'])
        run('git', '-C', dest, 'fetch', '--depth=1', 'origin', item['commit'])
        run('git', '-C', dest, 'checkout', '--detach', 'FETCH_HEAD')
    actual = subprocess.check_output(['git', '-C', str(dest), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != item['commit']:
        sys.exit(f'{dest}: revision {actual}, expected {item["commit"]}; checkout left untouched')
sdk = ROOT / 'toolchains/emsdk/emsdk.py'
run(sys.executable, sdk, 'install', LOCK['emsdk']['version'])
run(sys.executable, sdk, 'activate', LOCK['emsdk']['version'])
venv = ROOT / '.venv'
if not venv.exists():
    run(sys.executable, '-m', 'venv', venv)
run(venv / 'bin/python', '-m', 'pip', 'install', 'protobuf==5.29.3', 'grpcio-tools==1.70.0')
