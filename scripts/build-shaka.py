#!/usr/bin/env python3
"""Build the checked-in player from a dedicated Shaka v4.16.45 checkout.

Usage: python3 scripts/build-shaka.py /path/to/shaka /path/to/build-tools
Run npm ci --ignore-scripts in vendor/shaka/build-tools first, then pass that
folder as build-tools. Java 21+ and Node must be on PATH. No global installs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'vendor/shaka'
UPSTREAM = '889d6b76de168e75bb306c5ad442d7a79ee09e68'
VERSION = 'v4.16.45-portage4'


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source, dependencies = [Path(p).resolve() for p in sys.argv[1:]]
    if run('git', '-C', str(source), 'rev-parse', 'HEAD') != UPSTREAM:
        raise SystemExit('Expected the pinned Shaka v4.16.45 commit; use a dedicated checkout.')
    patch = VENDOR / 'bounded-append.patch'
    dirty = run('git', '-C', str(source), 'diff', '--name-only')
    patched_files = ['lib/media/media_source_engine.js', 'lib/media/streaming_engine.js']
    if dirty and sorted(dirty.splitlines()) != patched_files:
        raise SystemExit('The source checkout contains unrelated edits.')
    if not dirty:
        subprocess.run(['git', '-C', str(source), 'apply', str(patch)], check=True)
    actual = run('git', '-C', str(source), 'diff', '--unified=5', '--', *patched_files)
    if actual != patch.read_text().strip():
        raise SystemExit('The source edits differ from the checked-in patch.')
    for name in ['package.json', 'package-lock.json']:
        if (dependencies / name).read_bytes() != (VENDOR / 'build-tools' / name).read_bytes():
            raise SystemExit('Build dependencies must use vendor/shaka/build-tools lockfile.')
    modules = source / 'node_modules'
    if not modules.exists():
        modules.symlink_to(dependencies / 'node_modules', target_is_directory=True)
    elif modules.resolve() != (dependencies / 'node_modules').resolve():
        raise SystemExit('Use a source checkout with the pinned build-tools node_modules.')
    os.chdir(source)
    sys.path.insert(0, str(source / 'build'))
    import build
    import shakaBuildHelpers
    # The complete upstream dev dependency tree is not needed to compile.
    # These are the compiler, Closure library and extern generator dependencies.
    shakaBuildHelpers.update_node_modules = lambda: True
    build.release_closure_defines = [
        'shaka.Player.version="' + VERSION + '"' if value.startswith('shaka.Player.version=') else value
        for value in build.release_closure_defines
    ]
    result = build.main(['--force', '--name', 'portage', '--skip-ts', '--mode', 'release',
                         '+@complete', '+' + str(VENDOR / 'append_budget.js')])
    if result:
        raise SystemExit(result)
    bundle = (source / 'dist/shaka-player.portage.js').read_text()
    bundle = re.sub(r'\n//# sourceMappingURL=.*\n?', '\n', bundle)
    bundle = '/* Modified by Portage: bounded MSE appends. See vendor/shaka/README.md. */\n' + bundle.rstrip() + '\n'
    (VENDOR / 'shaka-player.portage.js').write_text(bundle)
    names = ['append_budget.js', 'bounded-append.patch', 'build-tools/package-lock.json', 'shaka-player.portage.js']
    manifest = {'upstream': UPSTREAM, 'version': VERSION,
                'sha256': {name: hashlib.sha256((VENDOR / name).read_bytes()).hexdigest() for name in names}}
    (VENDOR / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Built', VERSION)


if __name__ == '__main__':
    main()
