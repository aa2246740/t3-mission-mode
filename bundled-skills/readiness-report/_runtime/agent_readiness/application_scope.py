"""Candidate bounded JS collection-to-application attribution; no commands run.

This validates declared coverage, not the truth of recorded output. Historical
readback uses recorded paths and never requires the old checkout to exist.
"""
from pathlib import Path
import json
import re


def _app_for(relative, apps):
    matches = [app for app in apps if relative == Path(app) or Path(app) in relative.parents]
    return max(matches, key=lambda app: len(Path(app).parts)) if matches else None


def _collected_apps(output, root, cwd, apps, *, explicit_paths=False):
    covered = set()
    for raw in output.splitlines():
        line = re.sub(r'\x1b\[[0-9;]*m', '', raw).strip()
        # Jest emits paths; Vitest list emits "path > suite > case".
        line = line.split(' > ', 1)[0].strip('"')
        if not line or line.startswith(('>', '#', '[', '✓', '×')):
            continue
        path = Path(line)
        if path.suffix.lower() not in {'.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'}:
            continue
        if any(part in {'..', '.git'} for part in path.parts):
            continue
        if path.is_absolute():
            if root is None:
                continue
            try: candidates = [path.relative_to(root)]
            except ValueError: continue
        else:
            # Explicit root-relative app paths take precedence over cwd-relative
            # test paths; do not manufacture two owners for one output line.
            qualified = _app_for(path, {a: v for a, v in apps.items() if a != '.'})
            if explicit_paths and not qualified:
                # Multiple workspaces can each print the same relative test
                # path. It does not establish a root or child app's ownership.
                continue
            candidates = [path] if qualified else [cwd / path]
        for relative in candidates:
            app = _app_for(relative, apps)
            if app is not None and relative != Path(app):
                covered.add(app)
    return covered


def _manifest_name(root, app):
    manifest = root / app / 'package.json'
    try:
        if not manifest.resolve(strict=True).is_relative_to(root):
            return None
        value = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError, RuntimeError):
        return None
    return value.get('name') if isinstance(value, dict) else None


_DIRECTORY_OPTIONS = {'--prefix', '--cwd', '--dir', '--directory', '-C'}


def _selected_apps(words, cwd, apps, root, check_paths):
    """Return (has_selector, selected-or-None).

    None preserves historical named-workspace interpretation via captured paths;
    an empty set denotes a recognized but unsupported or inconsistent selector.
    Literal directory and workspace names are supported, as are npm's all or
    repeated workspaces. Pnpm filters must be exact names/directories; dynamic
    filters and Yarn foreach never silently cover every application.
    """
    executable = Path(words[0]).name
    if executable not in {'npm', 'npx', 'pnpm', 'yarn', 'bun'}:
        return False, None
    args = words[1:]
    if '--' in args:
        args = args[:args.index('--')]
    paths, names, all_workspaces, include_root = [], [], False, False
    i = 0
    while i < len(args):
        token = args[i]
        key, equal, value = token.partition('=')
        if key in _DIRECTORY_OPTIONS:
            if not equal:
                i += 1
                if i == len(args): return True, set()
                value = args[i]
            paths.append(value)
        elif token.startswith('-C') and token != '-C':
            paths.append(token[2:])
        elif key in {'--workspace', '-w', '--filter', '-F'} or (executable == 'yarn' and token == 'workspace'):
            if not equal:
                i += 1
                if i == len(args): return True, set()
                value = args[i]
            names.append(value)
        elif token.startswith('-F') and token != '-F':
            names.append(token[2:])
        elif token.startswith('-w') and token not in {'-ws', '-w'}:
            names.append(token[2:])
        elif key in {'--workspaces', '-ws'}:
            if equal and value not in {'true', 'false'}: return True, set()
            all_workspaces = value != 'false'
        elif key == '--include-workspace-root':
            if equal and value not in {'true', 'false'}: return True, set()
            include_root = value != 'false'
        elif token in {'workspaces', '--include', '--exclude'} or key in {'--include', '--exclude'}:
            return True, set()
        i += 1
    if not (paths or names or all_workspaces):
        return False, None
    if any(any(char in value for char in '*?[]{}!') or '...' in value for value in paths + names):
        return True, set()
    if paths and (names or all_workspaces):
        return True, set()  # mixed configuration roots need an explicit capture
    if paths:
        if len(set(paths)) != 1: return True, set()
        selected = Path(paths[0])
        if '..' in selected.parts: return True, set()
        if root is None and selected.is_absolute(): return 'directory', set()
        base = root if root is not None else Path('.')
        selected = selected if selected.is_absolute() else base / cwd / selected
        if check_paths:
            selected = selected.resolve()
            base = base.resolve()
        try: relative = selected.relative_to(base)
        except ValueError: return True, set()
        app = _app_for(relative, apps)
        return 'directory', {app} if app else set()
    kind = 'workspace-single' if len(names) == 1 and not all_workspaces else 'workspace-many'
    if not check_paths or root is None:
        if all_workspaces:
            # The root opt-in is explicit command semantics and survives loss
            # of the checkout; child membership still needs captured paths.
            return kind, {app for app in apps if app != '.' or include_root}
        return kind, None  # historical paths carry the remaining attribution
    known = {app: _manifest_name(root, app) for app in apps}
    # npm excludes the root project from --workspaces unless explicitly opted
    # in. Merely having a root package name does not change that selection.
    selected = {app for app, name in known.items() if name and (app != '.' or include_root)} if all_workspaces else set()
    for name in names:
        directory = Path(name)
        if directory.is_absolute():
            try: directory = directory.relative_to(root)
            except ValueError: return True, set()
        else:
            directory = cwd / directory
        matches = {app for app, actual in known.items() if name == actual or directory == Path(app)}
        if len(matches) != 1: return True, set()
        selected.update(matches)
    return kind, selected


def javascript_selection(words, cwd, apps, root, *, check_paths=True):
    """Expose the same workspace resolution to script lookup and diagnostics."""
    return _selected_apps(words, cwd, apps, root, check_paths)


def javascript_application_supported(app, words, runner_cwd, apps, root, output, *, check_paths=True):
    # One explicit root application contains the whole repository. A lone
    # non-root app must still not claim another directory's collection.
    # An explicit --prefix/--cwd/--dir/-C is resolved before that shortcut:
    # `npm --prefix ../other` must not inherit the single-app allowance.
    root = Path(root) if root is not None else None
    kind, selected = _selected_apps(words, runner_cwd, apps, root, check_paths)
    if set(apps) == {'.'} and not kind:
        return app == '.'
    if set(apps) == {'.'}:
        return app == '.' and bool(selected) and app in selected
    if kind and selected is not None and app not in selected:
        return False
    cwd_app = _app_for(runner_cwd, apps)
    if not kind and cwd_app not in {None, '.'} and app != cwd_app:
        return False
    collection_cwd = runner_cwd
    if selected and len(selected) == 1:
        collection_cwd = Path(next(iter(selected)))
    elif kind == 'workspace-single' and not check_paths:
        # Historical records already passed live manifest validation. Their
        # checkout may be gone; retain a recorded app's relative list output
        # without pretending to revalidate the deleted workspace-name mapping.
        collection_cwd = Path(app)
    covered = _collected_apps(output, root, collection_cwd, apps, explicit_paths=kind == 'workspace-many')
    if kind == 'directory' and selected == {app}:
        # A literal --prefix/--cwd establishes the runner directory even when
        # older captured output abbreviates paths. It cannot override explicit
        # collection paths pointing only to a different declared app.
        return not covered or app in covered
    if not kind and cwd_app not in {None, '.'}:
        return app == cwd_app and (not covered or app in covered)
    # Root aggregate commands need distinct app-qualified collection paths;
    # repeating one workspace's output never creates evidence for another.
    return app in covered
