"""Strict local reports; these checks extend the permissive native wire schema."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from . import RUBRIC_VERSION, __version__
from .application_scope import javascript_application_supported, javascript_selection
from .catalog import criteria_by_id, load_catalog
from .condition_evidence import condition_errors
from .repository import RepositoryError, _root_alias_relative, command_cwd, _git, canonicalize_origin, ensure_external_output, inspect_repository, validate_evidence
from .runner_contract import java_test_execution, javascript_collection, javascript_list_output, python_collection_file, python_collection_matches_file, other_runner_error
from .scoring import score_report, status
from .validation import Problems, ValidationError


class ReportError(ValidationError):
    pass


def read_json(path: str | Path) -> dict:
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ReportError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ReportError(f"Non-finite JSON number: {value}")

    with Path(path).open(encoding="utf-8") as stream:
        data = json.load(stream, object_pairs_hook=unique_pairs, parse_constant=invalid_constant)
    if not isinstance(data, dict):
        raise ReportError("Expected a JSON object")
    return data


_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _reject_surrogates(value: object) -> None:
    if isinstance(value, str):
        if _SURROGATE.search(value):
            raise ReportError("Invalid Unicode surrogate in report")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            _reject_surrogates(key)
            _reject_surrogates(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _reject_surrogates(item)


def json_text(value: object) -> str:
    _reject_surrogates(value)
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def new_evaluation(repository: dict) -> dict:
    return {
        "schemaVersion": 1,
        "rubricVersion": RUBRIC_VERSION,
        "repository": repository,
        "apps": {".": {"description": "TODO: discover independently deployable applications"}},
        "report": {
            key: {"numerator": "UNASSESSED", "denominator": None if criterion["scope"] == "application" else 1, "rationale": ""}
            for key, criterion in criteria_by_id().items()
        },
        "evidence": {key: [] for key in criteria_by_id()},
        "actionItems": [],
    }


_FORBIDDEN_COMMANDS = {"head", "tail", "tee", "timeout"}
_SHELLS = {"sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "powershell", "pwsh"}
_WRAPPERS = {"uv", "poetry", "pdm", "pipenv", "hatch"}
# Flags of `go build`/`go test` that take a separate value (`go help build`,
# `go help testflag`). Boolean flags (-race, -v, -short, -cover, -json,
# -failfast, -buildvcs ...) take none; `-C dir` is a retarget rejected earlier.
_GO_VALUE_FLAGS = {
    "-asmflags", "-bench", "-benchtime", "-blockprofile", "-blockprofilerate", "-buildmode", "-compiler",
    "-count", "-covermode", "-coverpkg", "-coverprofile", "-cpu", "-cpuprofile", "-exec", "-fuzz",
    "-fuzzcachedir", "-fuzzminimizetime", "-fuzztime", "-fuzzworker", "-gccgoflags", "-gcflags",
    "-installsuffix", "-ldflags", "-list", "-memprofile", "-memprofilerate", "-mod", "-modfile",
    "-mutexprofile", "-mutexprofilefraction", "-o", "-outputdir", "-overlay", "-p", "-parallel", "-pgo",
    "-pkgdir", "-run", "-shuffle", "-skip", "-tags", "-timeout", "-toolexec", "-trace", "-vet",
}


def _command_position_is_forbidden(words: list[str]) -> bool:
    """Reject head/tail/tee/timeout only when they are the command, not an argument."""
    segments: list[list[str]] = []
    current: list[str] = []
    for word in words:
        if word == "&&":
            segments.append(current)
            current = []
        else:
            current.append(word)
    segments.append(current)
    for segment in segments:
        index = 0
        if segment and Path(segment[0]).name in {"env", "cross-env"}:
            index = 1
            while index < len(segment) and segment[index].startswith("-"):
                index += 1
        while index < len(segment) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", segment[index]):
            index += 1
        if index < len(segment) and Path(segment[index]).name in _FORBIDDEN_COMMANDS:
            return True
    return False


def _parse_runner_context(command: str, cwd: str, root: Path | None, *, check_paths: bool) -> tuple[list[str], Path]:
    """Resolve captured cwd + one literal cd without executing either."""
    if not isinstance(command, str) or not command.strip() or "\x00" in command:
        raise ReportError("command is empty; record the actual runner command")
    for symbol in ("2>&1", "|", ";", "`", "$(", "<", ">", "\n", "\r"):
        if symbol in command:
            name = "pipe" if symbol == "|" else "shell operator"
            raise ReportError(f"{name} `{symbol!s}` not allowed in unit_tests_runnable evidence; record one direct runner command")
    if re.search(r"\$(?:[A-Za-z_0-9{(@*#?$!\-])", command):
        raise ReportError("shell expansion is not verifiable; use literal arguments")
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd or "\\" in cwd:
        raise ReportError("cwd must record the shell's target-relative or absolute directory")
    initial_path = Path(cwd)
    if not initial_path.is_absolute() and any(part in {"..", ".git"} for part in initial_path.parts):
        raise ReportError("cwd must not traverse parents or Git metadata; use an absolute shell directory")
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars="&")
        lexer.whitespace_split = True
        lexer.commenters = ""
        words = list(lexer)
    except ValueError as exc:
        raise ReportError(f"command quoting is invalid: {exc}; record valid literal shell syntax") from exc
    if _command_position_is_forbidden(words):
        raise ReportError("head/tail/tee/timeout cannot be the command; record the direct test runner and timeoutSeconds")
    initial = initial_path if initial_path.is_absolute() else (root / initial_path if root is not None else initial_path)
    resolved = initial
    if words and words[0] == "cd":
        if root is None or not root.is_absolute():
            raise ReportError("leading cd needs an absolute snapshot root; prepare the target first")
        prefix = 2 if len(words) > 1 and words[1] == "--" else 1
        if len(words) <= prefix + 2 or words[prefix + 1] != "&&":
            raise ReportError("leading cd must be `cd <literal directory> && <runner>`")
        destination = words[prefix]
        if not destination or destination.startswith("-") or any(symbol in destination for symbol in ("$", "~", "*", "?", "[", "]", "{", "}", "\\")):
            raise ReportError("cd directory must be a literal path; record the actual absolute or relative directory")
        path = Path(destination)
        resolved = path if path.is_absolute() else initial / path
        words = words[prefix + 2:]
    if not words or any("&" in word for word in words) or words[0] in {
        "!", "(", "{", "if", "for", "while", "until", "case", "function", "eval", "exec", "source", ".",
    }:
        raise ReportError("only one direct runner after an optional cd is allowed; remove extra shell commands")

    def relative(path):
        if root is None:
            return None if path.is_absolute() else path
        try:
            return path.relative_to(root)
        except ValueError:
            return _root_alias_relative(path, root) if path.is_absolute() else None

    # Check traversed in-target components before normalizing '..', so a
    # symlink cannot disappear from the recorded path through parent traversal.
    normalized = Path(os.path.normpath(str(resolved)))
    for path in (initial, resolved, normalized):
        in_target = relative(path)
        if in_target is None:
            continue
        current = root
        for part in in_target.parts:
            if part == ".git":
                raise ReportError("runner directory traverses Git metadata; choose an application directory")
            if current is not None:
                current = current / part
                if check_paths and (current.is_symlink() or not current.is_dir()):
                    raise ReportError(f"runner directory {current} is missing or traverses a symlink; use a real in-target directory")
    runner_relative = relative(normalized)
    if runner_relative is None or ".." in runner_relative.parts:
        raise ReportError(f"runner directory {resolved} is outside the target; cd to the target or an application before running tests")
    if check_paths and root is not None and (root.is_symlink() or not root.is_dir()):
        raise ReportError("snapshot root is missing or a symlink; prepare its real directory")
    return words, runner_relative


def _runner_context(command: str, cwd: str, root: Path | None, *, check_paths: bool) -> tuple[list[str], Path | None]:
    try:
        return _parse_runner_context(command, cwd, root, check_paths=check_paths)
    except ReportError:
        return [], None


def _runner_words(command: str, cwd: str, root: Path | None) -> list[str]:
    return _runner_context(command, cwd, root, check_paths=True)[0]


def _runner_retargets(words: list[str], root: Path | None, runner_cwd: Path, *,
                      allow_app_selectors: bool = False) -> bool:
    """Reject unverified scope changes at every recorded cwd.

    This is deliberately bounded syntax support, not a proof of a test script's
    behavior. Arbitrary wrappers and dynamic test configuration still require
    the evaluator to substantiate their actual application coverage.
    """
    executable = Path(words[0]).name
    executable_path = Path(words[0])
    if ".." in executable_path.parts or (root is not None and executable_path.is_absolute() and executable_path.is_relative_to(root)
                                        and not executable_path.is_relative_to(root / runner_cwd)):
        return True
    selectors = {"--cwd", "--prefix", "-C", "--directory"}
    if executable in {"npm", "npx", "pnpm", "yarn", "bun"}:
        selectors |= {"--workspace", "--workspaces", "-w", "-ws", "workspace", "workspaces", "--dir", "--filter", "-F"}
    elif executable in {"gradle", "gradlew"}:
        selectors |= {"-p", "--project-dir", "--include-build", "-b", "--build-file", "-c", "--settings-file"}
    elif executable in {"mvn", "mvnw"}:
        selectors |= {"-f", "--file", "-pl", "--projects"}
    elif executable.startswith("python") or executable == "pytest":
        selectors |= {"--rootdir", "--pyargs", "-c", "--config-file"}
    allowed = set()
    if allow_app_selectors:
        if executable in {"npm", "npx", "pnpm", "yarn", "bun"}:
            allowed = {"--cwd", "--prefix", "-C", "--directory", "--dir", "--workspace",
                       "--workspaces", "-w", "-ws", "workspace", "workspaces", "--filter", "-F"}
        elif executable in {"mvn", "mvnw"}:
            allowed = {"-f", "--file", "-pl", "--projects"}
        elif executable in {"gradle", "gradlew"}:
            allowed = {"-p", "--project-dir"}
        elif executable.startswith("python") or executable == "pytest":
            allowed = {"-c", "--config-file", "--rootdir", "--confcutdir"}
    selectors -= allowed
    for word in words[1:]:
        if executable in _WRAPPERS and word == "run":
            break
        option, _, value = word.partition("=")
        compact = {"-C"}
        if executable in {"npm", "npx", "pnpm", "yarn", "bun"}:
            compact |= {"-w", "-F"}
        elif executable in {"mvn", "mvnw"}:
            compact |= {"-f", "-pl"}
        elif executable in {"gradle", "gradlew"}:
            compact |= {"-p", "-b", "-c"}
        elif executable.startswith("python") or executable == "pytest":
            compact |= {"-c"}
        elif executable in _WRAPPERS:
            compact |= {"-p"}
        known_maven_control = executable in {"mvn", "mvnw"} and word in {"-ff", "-fae", "-fn"}
        if option in selectors or (not known_maven_control and any(word.startswith(flag) and word != flag for flag in compact - allowed)):
            return True
        path = Path(value if "=" in word else word)
        if ".." in path.parts or (path.is_absolute() and (root is None or not path.is_relative_to(root / runner_cwd))):
            return True
    return False


def _path_escapes(path: Path, root: Path | None, runner_cwd: Path, *, check_paths: bool = False) -> bool:
    if ".." in path.parts:
        return True
    if root is not None and check_paths:
        base = root.resolve() / runner_cwd
        candidate = path if path.is_absolute() else base / path
        if not candidate.resolve().is_relative_to(base):
            return True
        try:
            relative = candidate.relative_to(base)
        except ValueError:
            return True
        current = base
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                return True
    if not path.is_absolute():
        return False
    if root is None:
        return True
    try:
        return not path.is_relative_to(root / runner_cwd)
    except (TypeError, ValueError):
        return True


def _runner_escapes(words: list[str], root: Path | None, runner_cwd: Path, *, check_paths: bool = True) -> bool:
    """Reject directory escapes when the command did not cd first.

    In-repository selectors such as ``-f apps/web/pom.xml`` and ``--prefix``
    stay available; those are how a root command names one application.
    """
    executable_path = Path(words[0])
    if ".." in executable_path.parts:
        return True
    if root is not None and executable_path.is_absolute() and executable_path.is_relative_to(root) and not executable_path.is_relative_to(root / runner_cwd):
        return True
    compact_prefixes = ("-C", "-w", "-F", "-pl", "-f", "-p", "-b", "-c")
    for word in words[1:]:
        if word in {"-ff", "-fae", "-fn"}:
            continue
        option, separator, value = word.partition("=")
        attached = value if separator else None
        if attached is None:
            for flag in compact_prefixes:
                if word.startswith(flag) and word != flag:
                    attached = word[len(flag):]
                    break
        if attached is not None and _path_escapes(Path(attached), root, runner_cwd, check_paths=check_paths):
            return True
        target = Path(value if separator else word)
        if _path_escapes(target, root, runner_cwd, check_paths=check_paths):
            return True
    return False


def _wrapper_retargets(words: list[str]) -> bool:
    flags = _WRAPPER_RETARGET_OPTIONS | ({'-p'} if Path(words[0]).name != 'uv' else set())
    for word in words[1:]:
        if word == "run":
            return False
        option = word.partition("=")[0]
        if option in flags or ('-p' in flags and word.startswith('-p')) or (word.startswith("-C") and word != "-C"):
            return True
    return False


# Options of `<wrapper> run` that consume a separate value; every other
# option is a boolean flag (or written --option=value). Directory selectors
# are not skipped: they retarget the run and make the command unverifiable.
_WRAPPER_VALUE_OPTIONS = {
    "uv": {
        "--with", "--with-editable", "--with-requirements", "--python", "-p", "--env-file", "--extra",
        "--group", "--no-group", "--only-group", "--package", "--index", "--default-index", "--index-url",
        "-i", "--extra-index-url", "--find-links", "-f", "--index-strategy", "--keyring-provider",
        "--resolution", "--prerelease", "--exclude-newer", "--link-mode", "--cache-dir", "--config-file",
        "--constraints", "-c", "--overrides", "--build-constraints", "--refresh-package", "--reinstall-package",
        "--upgrade-package", "-P", "--no-binary-package", "--no-build-package", "--config-setting", "--color",
        "--allow-insecure-host",
    },
    "hatch": {"--env", "-e", "--include", "-i", "--exclude", "-x"},
}
_WRAPPER_RETARGET_OPTIONS = {"--project", "--directory", "--cwd", "--prefix", "-C"}


def _unwrap_wrapper(words: list[str], allowed_root: Path | None = None) -> list[str] | None:
    """Return the command a ``<wrapper> run`` invocation executes, else None.

    Wrapper options after ``run`` (``uv run --frozen --with pytest-xdist
    pytest ...``) are skipped, including the value of options that take one.
    Only directory/project selectors retarget discovery. Interpreter, index,
    dependency and cache option values do not define the test directory.
    """
    wrapper = Path(words[0]).name
    if wrapper not in _WRAPPERS:
        return words
    args = words[1:]
    value_options = _WRAPPER_VALUE_OPTIONS.get(wrapper, set())
    short_value_options = tuple(option for option in value_options if len(option) == 2)
    retargets = _WRAPPER_RETARGET_OPTIONS | ({'-p'} if wrapper != 'uv' else set())
    module, running = False, False
    # Parse options on both sides of `run` with their actual value arity.
    while args and not running:
        if args[0] == 'run':
            args, running = args[1:], True
            break
        option, separator, _ = args[0].partition('=')
        if option in retargets or any(args[0].startswith(flag) and args[0] != flag for flag in ('-C', *({'-p'} if wrapper != 'uv' else set()))):
            return None
        if not args[0].startswith('-'):
            return None
        consume = 2 if option in value_options and not separator else 1
        if len(args) < consume:
            return None
        args = args[consume:]
    if not running:
        return None
    while args and args[0].startswith("-") and args[0] != "-":
        word = args[0]
        if word == "--":
            args = args[1:]
            break
        option, separator, value = word.partition("=")
        compact = not word.startswith("--") and len(word) > 2
        if option in retargets or (compact and any(word.startswith(flag) for flag in ('-C', *({'-p'} if wrapper != 'uv' else set())))):
            return None
        if wrapper == "uv" and option in {"-m", "--module"} and not separator:
            module, value, args = True, None, args[1:]
        elif separator:
            args = args[1:]
        elif option in value_options:
            if len(args) < 2:
                return None
            value, args = args[1], args[2:]
        elif compact and word.startswith(short_value_options):
            value, args = word[2:], args[1:]
        else:
            value, args = None, args[1:]
    if wrapper == "hatch" and args and re.fullmatch(r"[A-Za-z0-9_.-]+:[^:\s]+", args[0]):
        args = [args[0].partition(":")[2], *args[1:]]  # `hatch run test:pytest` selects an environment
    if module:
        args = ["python", "-m", *args]
    return args or None


def _inside_app(candidate: Path, app: Path) -> bool:
    if candidate.suffix == ".xml":
        candidate = candidate.parent
    if candidate in {Path("."), Path("")}:
        return False
    return candidate == app or app in candidate.parents


def _go_packages(words: list[str]) -> list[Path] | None:
    try:
        index = words.index("test") + 1
    except ValueError:
        return None
    packages = []
    while index < len(words):
        token = words[index]
        if token == "--":
            index += 1
            continue
        if token == "-args":
            break  # everything after -args belongs to the test binary
        if token.startswith("-"):
            name, separator, _value = token.partition("=")
            # The flag package takes -flag and --flag; go test also takes -test.flag.
            name = "-" + name.lstrip("-").removeprefix("test.")
            if separator == "" and name in _GO_VALUE_FLAGS:
                index += 2
                continue
            index += 1
            continue
        value = token[2:] if token.startswith("./") else token
        if value.endswith("/..."):
            value = value[:-4]
        elif value == "...":
            value = "."
        elif value.endswith("..."):
            value = value[:-3]
        value = value.strip("/")
        path = Path(value or ".")
        if path.is_absolute() or ".." in path.parts:
            return None
        packages.append(path)
        index += 1
    return packages


def _go_owns(words: list[str], app: Path, root: Path | None = None, apps: dict | None = None) -> bool:
    packages = _go_packages(words)
    if not packages:
        return False
    modules = []
    if root is not None:
        directories = {Path('.')}
        for directory in apps or {str(app): {}}:
            path = Path(directory)
            directories.update((path, *path.parents))
        for directory in directories:
            manifest = root / directory / 'go.mod'
            try:
                if manifest.is_symlink() or not manifest.resolve().is_relative_to(root.resolve()):
                    continue
                content = manifest.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                continue
            match = re.search(r'(?m)^\s*module\s+(?:"([^"\n]+)"|([^\s/][^\s]*))', content)
            if match:
                modules.append((Path(match[1] or match[2]), directory))
    mapped = []
    for package in packages:
        matches = [(module, directory) for module, directory in modules if package == module or module in package.parents]
        if matches:
            module, directory = max(matches, key=lambda item: len(item[0].parts))
            package = directory / package.relative_to(module)
        mapped.append(package)
    return all(_inside_app(package, app) or package == app for package in mapped)


def _go_executed_tests(output: str) -> bool:
    empty, observed, tested = False, False, False
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            event = None
        if isinstance(event, dict):
            if event.get('Action') == 'pass' and event.get('Test'):
                tested = True
            continue
        if re.search(r'testing: warning: no tests to run|\[no tests? (?:to run|files)\]', line, re.I):
            empty = True
        if re.match(r'^(?:=== RUN\s+|--- PASS:\s+|(?:Test|Example|Fuzz)\w*\s*$)', line):
            observed = True
        if re.match(r'^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))', line):
            tested = tested or (not empty or observed)
            empty, observed = False, False
        elif re.match(r'^\?\s+\S+', line):
            empty, observed = False, False
    return tested


def _flag_values(words: list[str], names: set[str], compact: set[str]) -> list[str]:
    values = []
    index = 0
    while index < len(words):
        word = words[index]
        option, separator, value = word.partition("=")
        if option in names:
            if separator:
                values.append(value)
            elif index + 1 < len(words):
                values.append(words[index + 1])
                index += 1
        elif any(word.startswith(flag) and word != flag for flag in compact) and word not in {"-ff", "-fae", "-fn"}:
            for flag in sorted(compact, key=len, reverse=True):
                if word.startswith(flag) and word != flag:
                    values.append(word[len(flag):])
                    break
        index += 1
    return values


def _maven_owns(words: list[str], app: Path) -> bool:
    values = _flag_values(words, {"-f", "--file", "-pl", "--projects"}, {"-f", "-pl"})
    targets = []
    for value in values:
        for part in value.split(","):
            part = part.strip()
            if part:
                targets.append(Path(part))
    return bool(targets) and all(_inside_app(target, app) for target in targets)


def _gradle_owns(words: list[str], app: Path) -> bool:
    project_dirs = [Path(value) for value in _flag_values(words, {"-p", "--project-dir"}, {"-p"})]
    if project_dirs:
        return all(_inside_app(path, app) for path in project_dirs)
    tasks = []
    for word in words:
        if word.startswith("-"):
            continue
        if word == "test" or word.endswith(":test"):
            body = word[:-len(":test")] if word.endswith(":test") else ""
            body = body.lstrip(":").replace(":", "/")
            tasks.append(Path(body) if body else Path("."))
    named = [path for path in tasks if path != Path(".")]
    return bool(named) and all(_inside_app(path, app) for path in named)


def _cargo_owns(words: list[str], app: str, runner_cwd: Path, root: Path | None, apps: dict, *, check_paths: bool) -> bool:
    args = words[2:words.index('--')] if '--' in words else words[2:]
    packages = _flag_values(args, {'-p', '--package'}, {'-p'})
    manifests = _flag_values(args, {'--manifest-path'}, set())
    bins = _flag_values(args, {'--bin'}, set())
    for value in manifests:
        path = Path(value)
        if path.is_absolute():
            if root is None:
                continue  # Historical readback cannot resolve a deleted checkout.
            try: path = path.relative_to(root)
            except ValueError: return False
        else:
            path = runner_cwd / path
        if path.parent != Path(app) and Path(app) not in path.parent.parents:
            return False
    if not check_paths or root is None:
        return True
    names, binary_names, known_owners = {}, {}, set()
    candidates = {root / key / 'Cargo.toml' for key in apps}
    listed = _git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', optional=True)
    if listed:
        candidates.update(root / os.fsdecode(value) for value in listed.split(b'\x00')
                          if value and Path(os.fsdecode(value)).name == 'Cargo.toml')
    for manifest in candidates:
        relative = manifest.parent.relative_to(root)
        owners = [key for key in apps if relative == Path(key) or Path(key) in relative.parents]
        if not owners:
            continue
        owner = max(owners, key=lambda key: len(Path(key).parts))
        try:
            if manifest.is_symlink() or not manifest.resolve().is_relative_to(root.resolve()):
                continue
            content = manifest.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        section, package_name, binaries = '', None, []
        for line in content.splitlines():
            if line.strip().startswith('['):
                section = line.strip().split('#', 1)[0].strip()
            match = re.match(r"\s*name\s*=\s*[\"']([^\"']+)[\"']", line)
            if match and section == '[package]':
                package_name = match[1]
            elif match and section == '[[bin]]':
                binaries.append(match[1])
        if package_name:
            known_owners.add(owner)
            names.setdefault(package_name, set()).add(owner)
            for binary in set(binaries) | {package_name}:
                binary_names.setdefault(binary, set()).add(owner)
    # A root application includes its local library crates. The most specific
    # declared application owns a nested crate when both root and child exist.
    for values, identities in ((packages, names), (bins, binary_names)):
        for value in values:
            if identities is names:
                source, fragment_separator, fragment = value.rpartition('#')
                name = (fragment if fragment_separator else value).split('@', 1)[0]
                if fragment_separator and re.match(r"^\d", name):
                    name = Path(source.rstrip('/')).name
            else:
                name = value
            owners = identities.get(name)
            if (owners is not None and owners != {app}) or (owners is None and app in known_owners):
                return False
    return True


def _root_command_owns_app(executable: str, words: list[str], app: str, root: Path | None = None, apps: dict | None = None) -> bool:
    if app == ".":
        return True
    app_path = Path(app)
    if executable == "go":
        return _go_owns(words, app_path, root, apps)
    if executable in {"mvn", "mvnw"}:
        return _maven_owns(words, app_path)
    if executable in {"gradle", "gradlew"}:
        return _gradle_owns(words, app_path)
    return True


def _test_record(item: dict, apps: dict, root: Path | None, *, check_paths: bool) -> str:
    if item.get("exitCode") != 0 or type(item.get("exitCode")) is not int:
        raise ReportError("exitCode must be 0; cite a successful runner command")
    timeout = item.get("timeoutSeconds")
    try:
        valid_timeout = type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0
    except OverflowError:
        valid_timeout = False
    if not valid_timeout:
        raise ReportError("timeoutSeconds must be finite and positive; record the actual bounded timeout")
    words, runner_cwd = _parse_runner_context(item.get("command"), item.get("cwd"), root, check_paths=check_paths)
    initial_cwd = item["cwd"]
    if root is not None:
        initial_cwd = command_cwd(root, initial_cwd, check_paths=False)
    # A shell starting outside and cd-ing to the root has the same selectors
    # as a direct root invocation. The initial host directory is not app scope.
    changed_directory = runner_cwd != Path(".") and runner_cwd != Path(initial_cwd)
    if Path(words[0]).name in {"env", "cross-env"}:
        words = words[1:]
        if words and words[0].startswith("-"):
            raise ReportError("env/cross-env accept assignments only; remove options that change dispatch or cwd")
    assignments = {}
    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        name, value = words.pop(0).split("=", 1)
        assignments[name] = value
    for entry in assignments.get("PYTHONPATH", "").split(os.pathsep):
        path = Path(entry)
        outside = path.is_absolute() and (root is None or not path.resolve().is_relative_to(root.resolve()))
        if ".." in path.parts or outside:
            raise ReportError("PYTHONPATH retargets discovery outside the target; use in-target entries such as src")
    try:
        goflags = shlex.split(assignments.get("GOFLAGS", ""))
    except ValueError as exc:
        raise ReportError("GOFLAGS quoting is invalid; record valid flags") from exc
    if any(word.partition("=")[0] == "-modfile" or word.startswith("-C") for word in goflags):
        raise ReportError("GOFLAGS contains -modfile/-C scope retargeting; put verifiable selectors in the runner command")
    if not words:
        raise ReportError("assignments need a direct test runner command")
    if Path(words[0]).name in _WRAPPERS:
        if _wrapper_retargets(words):
            raise ReportError("wrapper options retarget discovery; run from the target without --project/--directory selectors")
        unwrapped = _unwrap_wrapper(words, None if root is None else root / runner_cwd)
        if not unwrapped:
            raise ReportError("wrapper must select a direct runner with valid literal run options; remove directory retargeting")
        words = unwrapped
    executable = Path(words[0]).name
    if executable in _SHELLS or executable in _FORBIDDEN_COMMANDS:
        raise ReportError("shell/utility wrappers are not direct test runners; record the runner itself")
    if _runner_retargets(words, root, runner_cwd, allow_app_selectors=True):
        raise ReportError("runner arguments retarget discovery outside its scope; select tests within the runner directory")
    if _runner_escapes(words, root, runner_cwd, check_paths=check_paths):
        raise ReportError("runner arguments escape its directory or traverse a symlink; use real in-target paths")
    output = item.get("output")
    if not isinstance(output, str) or not output.strip():
        raise ReportError("output must contain actual runner listing/collection/result lines; an empty capture cannot prove tests")
    output = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output)
    if re.search(r"\b(?:collected\s+0\s+items|0\s+tests?\s+(?:collected|listed)|no tests (?:found|collected)|tests run:\s*0)\b", output, re.I):
        raise ReportError("runner reports zero tests; cite at least one collected/listed/executed test")
    if executable in {"echo", "printf", "true", "false", "cat", "ls", "find", "rg", "grep"}:
        raise ReportError("non-test command cannot prove runnable tests; cite a native runner")
    if any(word in words for word in ("--help", "--version")):
        raise ReportError("help/version does not prove runnable tests; use collection/listing or bounded execution")
    if executable.startswith("python") or executable == "pytest":
        addopts = assignments.get("PYTEST_ADDOPTS", "")
        try:
            scope_words = [words[0], *shlex.split(addopts), *words[1:]]
        except ValueError as exc:
            raise ReportError("PYTEST_ADDOPTS quoting is invalid; record valid literal options") from exc
        if _runner_retargets([words[0], *shlex.split(addopts)], root, runner_cwd, allow_app_selectors=True) or _runner_escapes(scope_words, root, runner_cwd, check_paths=check_paths):
            raise ReportError("PYTEST_ADDOPTS retargets discovery; keep options within the selected application")
        selected_file = python_collection_file(words, addopts=addopts)
        if selected_file is None:
            raise ReportError("Python requires collection only of one existing test file; use pytest --collect-only tests/test_example.py")
        if not python_collection_matches_file(selected_file, output):
            raise ReportError("Python output lists a different test file; capture collection of the selected file only")
        collected = re.search(r"\b(?:collected\s+[1-9]\d*\s+items?|[1-9]\d*\s+tests?\s+collected)\b", output, re.I)
        quiet_count = re.search(r"(?m)^\s*[^\s<>]+\.py:\s*[1-9]\d*\s*$", output)
        if not collected and not quiet_count:
            raise ReportError("Python output must report at least one collected test; capture pytest's collection lines")
        if re.search(r"\b\d+\s+(?:passed|failed|xfailed|xpassed)\b|\bRan\s+\d+\s+tests?\b", output):
            raise ReportError("Python evidence executed tests; use collection-only mode")
    elif executable in {"gradle", "gradlew", "mvn", "mvnw"}:
        if not java_test_execution(words, output):
            raise ReportError("Java requires actual execution of one selected test class; use --tests plus --rerun-tasks or -Dtest=<class> and capture test results")
    elif executable in {"npm", "npx", "pnpm", "yarn", "bun", "jest", "vitest"}:
        kind, selected = javascript_selection(words, runner_cwd, apps, root, check_paths=check_paths)
        if kind and selected == set():
            raise ReportError("TS/JS workspace/directory selector is ambiguous, a glob, unknown or outside the target; name exactly one apps directory or package.json name")
        # Result counts are judged at line start (optionally after a Jest/Vitest
        # summary label), so listed titles such as "sums 2 passed checks" stay list items.
        if re.search(r"(?m)^\s*(?:PASS|FAIL)(?:\s|$)|^\s*(?:(?:Test Files|Test Suites|Tests)\s*:?\s+)?\d+\s+(?:tests?\s+)?(?:passed|failed)\b|^\s*\((?:pass|fail)\)(?:\s|$)|^\s*\d+\s+(?:pass|fail)\s*$|^\s*Ran\s+\d+\s+tests?\b", output):
            raise ReportError("TS/JS output reports executed tests; capture runner list/collection output only")
        if not javascript_collection(words, root, runner_cwd, apps, check_paths=check_paths):
            raise ReportError("TS/JS requires runner-native collection/list mode; use jest --listTests or vitest list, including in the selected package script")
        if not javascript_list_output(output):
            raise ReportError("TS/JS output must enumerate at least one runner-produced list/collection item; package-manager banners alone do not count")
    elif executable == "go":
        own_flags = words[2:words.index("-args")] if "-args" in words else words[2:]
        flags = {"-" + word.partition("=")[0].lstrip("-").removeprefix("test.") for word in own_flags if word.startswith("-")}
        if words[1:2] != ["test"] or flags & {"-c", "-h", "-n"}:
            raise ReportError("Go compile-only/help/dry-run is not test evidence; use go test -list <regex> <pkg> or bounded execution")
        if "-list" in flags:
            listed = any(re.match(r"^(?:Test|Example|Fuzz)\w*\s*$", line) for line in output.splitlines())
            for line in output.splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and re.match(r"^(?:Test|Example|Fuzz)\w*\s*$", str(event.get("Output", ""))):
                    listed = True
            if not listed:
                raise ReportError("Go list output must enumerate at least one test; summary/build lines alone are insufficient")
        else:
            if not _go_executed_tests(output):
                raise ReportError("Go output must report at least one passing test package/test event; testless or unmatched selections do not count")
    else:
        reason = other_runner_error(words, output)
        if reason:
            raise ReportError(reason)
    app = item.get("application")
    candidates = [path for path in apps if runner_cwd == Path(path) or Path(path) in runner_cwd.parents]
    inferred_app = max(candidates, key=lambda path: len(Path(path).parts)) if candidates else None
    if app is not None:
        if (not isinstance(app, str) or app not in apps or (changed_directory and app != inferred_app)
                or (inferred_app not in {None, "."} and app != inferred_app)):
            raise ReportError(f"application {app!r} does not own runner directory {runner_cwd}; use its actual apps key")
    else:
        if inferred_app is None:
            raise ReportError(f"runner directory {runner_cwd} has no application owner; identify the app with an explicit verifiable selector")
        app = inferred_app
    if executable.startswith("python") or executable == "pytest":
        selected_path = Path(selected_file)
        if selected_path.is_absolute():
            if root is not None:
                try:
                    selected_path = selected_path.relative_to(root)
                except ValueError as exc:
                    raise ReportError("selected Python test file is outside the target; cite an in-target file") from exc
        else:
            selected_path = runner_cwd / selected_path
        owners = [path for path in apps if selected_path == Path(path) or Path(path) in selected_path.parents]
        if owners and app != max(owners, key=lambda path: len(Path(path).parts)):
            raise ReportError(f"application {app!r} does not own Python test file {selected_path}; use the file's actual app")
        config_targets = _flag_values(scope_words, {"-c", "--config-file", "--rootdir", "--confcutdir"}, {"-c"})
        for target in config_targets:
            config_path = Path(target)
            if config_path.is_absolute() and root is not None:
                try:
                    config_path = config_path.relative_to(root)
                except ValueError as exc:
                    raise ReportError("Python configuration is outside the target; use in-target configuration") from exc
            else:
                config_path = runner_cwd / config_path
            config_owners = [path for path in apps if config_path == Path(path) or Path(path) in config_path.parents]
            if config_owners and app != max(config_owners, key=lambda path: len(Path(path).parts)):
                raise ReportError("Python configuration belongs to another application; cite the selected app's configuration")
        if check_paths and root is not None and not (root / selected_path).is_file():
            raise ReportError(f"selected Python test file {selected_path} does not exist; cite an existing test file")
    if len(apps) > 1 and runner_cwd == Path(".") and app != "." and not _root_command_owns_app(executable, words, app, root if check_paths else None, apps):
        raise ReportError(f"root command does not select application {app}; use that app's package/module selector")
    if executable == 'cargo' and not _cargo_owns(words, app, runner_cwd, root, apps, check_paths=check_paths):
        raise ReportError(f"cargo package/manifest/bin selectors do not select application {app}; cite that app's Cargo.toml package and binary")
    if executable in {"npm", "npx", "pnpm", "yarn", "bun", "jest", "vitest"}:
        if not javascript_application_supported(app, words, runner_cwd, apps, root, output, check_paths=check_paths):
            raise ReportError(f"TS/JS selectors/output do not substantiate application {app}; cite its runner and listed test paths")
    return app


def _test_evidence(items: list, numerator: int, apps: dict, root: Path | None = None, *, check_paths: bool = True) -> None:
    passing_apps = set()
    captures = {}
    problems = Problems()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or item.get("kind") != "command":
            continue
        try:
            app = _test_record(item, apps, root, check_paths=check_paths)
            _, directory = _parse_runner_context(item['command'], item['cwd'], root, check_paths=check_paths)
            capture = (item['command'], directory, item['output'])
            if capture in captures and captures[capture] != app:
                raise ReportError(f"same command, effective runner directory and output already count for application {captures[capture]}; capture distinct evidence for {app}")
            captures[capture] = app
            passing_apps.add(app)
        except (ReportError, RepositoryError) as exc:
            problems.extend(exc, f"unit_tests_runnable evidence[{index}]: ")
        except (ValueError, OSError, RuntimeError) as exc:
            problems.add(f"unit_tests_runnable evidence[{index}]: cannot verify runner path/options: {exc}; use real literal paths and valid runner options")
    if len(passing_apps) < numerator:
        problems.add(f"unit_tests_runnable: needs a valid bounded runner command for each passing application; numerator={numerator}, verified applications={len(passing_apps)}; add native collection/listing/execution evidence for each passing app")
        problems.raise_if_any(ReportError)


def validate_evaluation(data: dict, target: str | Path) -> dict:
    """Validate all independent input problems against the current snapshot."""
    current = inspect_repository(target)
    problems = Problems()
    if not isinstance(data, dict):
        raise ReportError("evaluation: expected a JSON object; prepare and complete evaluation.json")
    previous = data.get("repository")
    if not isinstance(previous, dict):
        problems.add("repository: missing repository snapshot; use prepare first")
    else:
        for key in ("root", "identity", "head", "fingerprint"):
            if not _repository_field_matches(key, previous, current):
                problems.add(f"repository.{key}: changed since prepare; re-prepare and re-evaluate changed evidence")
    _validate_structure(data, Path(current["root"]), check_paths=True, problems=problems)
    for gap in condition_errors(data, Path(current["root"])):
        location = gap["criterionId"] + " " + gap["condition"]
        if "evidenceIndex" in gap:
            location += f" evidence[{gap['evidenceIndex']}]"
        if gap.get("field"):
            location += "." + gap["field"]
        problems.add(f"{location}: Required-condition evidence failed: {gap['error']}")
    problems.raise_if_any(ReportError)
    return current


def _historical_evidence(items: list, root: Path | None = None) -> None:
    """Validate stored shapes without requiring today's evidence files/cwds."""
    problems = Problems()
    for index, item in enumerate(items):
        label = f"evidence[{index}]"
        if not isinstance(item, dict) or item.get("kind") not in {"file", "command"}:
            problems.add(f"{label}.kind: invalid historical evidence kind; preserve a file or command record")
            continue
        if item["kind"] == "file":
            path = item.get("path")
            if not isinstance(path, str) or not path or Path(path).is_absolute() or any(part in {"..", ".git"} for part in Path(path).parts) or "\\" in path or "\x00" in path:
                problems.add(f"{label}.path: invalid historical evidence path; use a repository-relative file")
            if not isinstance(item.get("note"), str) or not item["note"].strip():
                problems.add(f"{label}.note: historical file evidence requires a note")
            if "line" in item and (type(item["line"]) is not int or item["line"] <= 0):
                problems.add(f"{label}.line: invalid historical file line; use a positive integer")
        else:
            try:
                command_cwd(root or Path("/"), item.get("cwd"), check_paths=False)
            except RepositoryError as exc:
                problems.extend(exc, f"{label}.cwd: ")
            if type(item.get("exitCode")) is not int:
                problems.add(f"{label}.exitCode: invalid historical command exit code; use an integer")
            if not isinstance(item.get("command"), str) or not item["command"].strip():
                problems.add(f"{label}.command: historical command evidence requires command and output")
            if not isinstance(item.get("output"), str):
                problems.add(f"{label}.output: historical command evidence requires recorded output as a string")
    problems.raise_if_any(ReportError)


def _validate_structure(data: dict, root: Path, *, check_paths: bool, problems: Problems | None = None) -> None:
    own_problems = problems is None
    if problems is None:
        problems = Problems()
    try:
        _reject_surrogates(data)
    except ReportError as exc:
        problems.extend(exc, "evaluation: ")
    if type(data.get("schemaVersion")) is not int or data.get("schemaVersion") != 1 or data.get("rubricVersion") != RUBRIC_VERSION:
        problems.add(f"schemaVersion/rubricVersion: expected schemaVersion=1 and rubricVersion={RUBRIC_VERSION}; preserve prepared identifiers")
    metadata = data.get("repository")
    if not isinstance(metadata, dict):
        metadata = {}
    if not isinstance(metadata.get("root"), str) or not Path(metadata["root"]).is_absolute():
        problems.add("repository.root: invalid repository snapshot root; use prepare first")
    if not isinstance(metadata.get("identity"), str) or not metadata["identity"]:
        problems.add("repository.identity: invalid repository identity; preserve prepared metadata")
    fingerprint = metadata.get("fingerprint")
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        problems.add("repository.fingerprint: invalid repository fingerprint; preserve prepared metadata")
    apps = data.get("apps")
    if not isinstance(apps, dict) or not apps:
        problems.add("apps: must contain at least one application; use '.' for a single application")
        apps = {}
    app_roots, valid_apps = set(), {}
    for path, app in apps.items():
        if not isinstance(path, str) or not path or Path(path).is_absolute() or ".." in Path(path).parts or ".git" in Path(path).parts or "\\" in path or "\x00" in path:
            problems.add(f"apps[{path!r}]: application paths must be relative directories inside the repository; supply a real app directory")
            continue
        try:
            resolved = (root / path).resolve() if check_paths else root / path
            if not resolved.is_relative_to(root) or (check_paths and not resolved.is_dir()):
                raise ValueError("directory is missing or outside target")
        except (ValueError, OSError, RuntimeError):
            problems.add(f"apps[{path!r}]: invalid application directory; choose an existing in-target directory")
            continue
        if resolved in app_roots:
            problems.add(f"apps[{path!r}]: duplicate application directory; keep one canonical apps key")
        app_roots.add(resolved)
        description = app.get("description") if isinstance(app, dict) else None
        if not isinstance(description, str) or not description.strip() or description.startswith("TODO:"):
            problems.add(f"apps[{path!r}].description: needs a real description; describe the deployable application")
        valid_apps[path] = app
    catalog = criteria_by_id()
    maps = {}
    for name in ("report", "evidence"):
        value = data.get(name)
        if not isinstance(value, dict):
            problems.add(f"{name}: must be an object covering exactly {len(catalog)} criteria; fill all prepared IDs")
            value = {}
        if set(value) != set(catalog):
            problems.add(f"{name}: must cover exactly {len(catalog)} criteria; fill missing criterion entries and remove unknown IDs")
        for key in sorted(catalog.keys() - value.keys()):
            problems.add(f"{key}: missing {name} entry; fill the prepared criterion")
        for key in sorted(value.keys() - catalog.keys()):
            problems.add(f"{key}: unknown {name} criterion; remove the extra key and use the exact catalog ID")
        maps[name] = value
    report, evidence = maps["report"], maps["evidence"]
    all_items, labels = [], []
    for key, criterion in catalog.items():
        value = report.get(key)
        numerator = None
        if key in report:
            if not isinstance(value, dict):
                problems.add(f"{key}.report: expected numerator, optional denominator, rationale; supply an evaluation object")
            else:
                if not {"numerator", "rationale"} <= value.keys() or value.keys() - {"numerator", "denominator", "rationale"}:
                    problems.add(f"{key}.report: expected numerator, optional denominator, rationale; fill required fields and remove extras")
                numerator = value.get("numerator")
                expected = len(apps) if criterion["scope"] == "application" else 1
                if value.get("denominator") is None:
                    value["denominator"] = expected
                if type(value.get("denominator")) is not int or value["denominator"] != expected:
                    problems.add(f"{key}.denominator: {criterion['scope']} denominator must equal {expected}; omit it or set null for automatic filling")
                if numerator is None:
                    if not criterion.get("isSkippable", False):
                        problems.add(f"{key}.numerator: this criterion cannot be skipped; assess it as an integer from 0 to {expected}")
                    if check_paths and key == "monorepo_tooling" and len(apps) > 1:
                        problems.add("monorepo_tooling.numerator: monorepo_tooling cannot be skipped when multiple applications exist; assess the monorepo tooling")
                elif type(numerator) is not int or not 0 <= numerator <= expected:
                    problems.add(f"{key}.numerator: must be an integer between 0 and {expected}; count passing applications/repository once")
                elif check_paths and numerator > 0:
                    prerequisite = {"interactive_qa_runnable": "interactive_qa_exists", "agents_md_validation": "agents_md"}.get(key)
                    if prerequisite:
                        previous = report.get(prerequisite)
                        previous = previous.get("numerator") if isinstance(previous, dict) else None
                        needed = numerator if key == "interactive_qa_runnable" else 1
                        if type(previous) is not int or previous < needed:
                            problems.add(f"{key}.numerator: {key} requires {prerequisite} to cover at least {needed}; substantiate the prerequisite or correct this numerator")
                rationale = value.get("rationale")
                if not isinstance(rationale, str) or not rationale.strip() or _SURROGATE.search(rationale) or len(rationale.encode("utf-16-le", errors="surrogatepass")) // 2 > 500:
                    problems.add(f"{key}.rationale: must be nonempty and at most 500 UTF-16 code units without invalid surrogates; write a concise evidence-based rationale")
        if key not in evidence:
            continue
        items = evidence[key]
        if not isinstance(items, list) or not items:
            problems.add(f"{key}.evidence: at least one evidence record is required, including failures and skips; cite actual files or commands")
            continue
        if check_paths:
            all_items.extend(items)
            labels.extend(f"{key} evidence[{index}]" for index in range(len(items)))
        else:
            try:
                _historical_evidence(items, root)
            except ReportError as exc:
                problems.extend(exc, f"{key} ")
        if check_paths and key == "unit_tests_runnable" and type(numerator) is int and numerator > 0 and valid_apps:
            try:
                _test_evidence(items, numerator, valid_apps, root, check_paths=check_paths)
            except ReportError as exc:
                problems.extend(exc)
    if check_paths:
        try:
            validate_evidence(root, all_items, labels=labels)
        except RepositoryError as exc:
            problems.extend(exc)
    actions = data.get("actionItems", [])
    if not isinstance(actions, list):
        problems.add("actionItems: must be a list of at most three concrete recommendations; supply a list")
        actions = []
    if len(actions) > 3:
        problems.add("actionItems: must contain at most three concrete recommendations; select the highest-impact failures")
    selected = set()
    for index, action in enumerate(actions):
        label = f"actionItems[{index}]"
        if not isinstance(action, dict) or set(action) != {"criterionId", "action", "reason"}:
            problems.add(f"{label}: needs criterionId, action and reason; fill exactly these fields")
            continue
        key = action["criterionId"]
        value = report.get(key) if isinstance(key, str) else None
        failed = isinstance(value, dict) and type(value.get("numerator")) is int and type(value.get("denominator")) is int and status(value) == "failed"
        if not isinstance(key, str) or key not in catalog or key in selected or not failed:
            problems.add(f"{label}.criterionId: must select distinct, evaluated failing criteria; choose a failed catalog ID")
        else:
            selected.add(key)
        for field in ("action", "reason"):
            if not isinstance(action[field], str) or not action[field].strip():
                problems.add(f"{label}.{field}: must be nonempty; describe the concrete repair/reason")
    if own_problems:
        problems.raise_if_any(ReportError)


def default_state_dir() -> Path:
    configured = os.environ.get("AGENT_READINESS_STATE_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "agent-readiness"


def _repo_state(repository: dict, state_dir: str | Path | None) -> Path:
    base = ensure_external_output(repository["root"], state_dir or default_state_dir())
    identity = repository["identity"]
    # A relative origin such as ../shared.git is not a network identity. Fold
    # the resolved root into the key so two local checkouts cannot share state.
    material = identity if "://" in identity else identity + "\0" + str(Path(repository["root"]).resolve())
    key = hashlib.sha256(material.encode()).hexdigest()[:24]
    return ensure_external_output(repository["root"], base / key)


def latest_report(repository: dict, state_dir: str | Path | None) -> dict | None:
    directory = _repo_state(repository, state_dir)
    pointer = directory / "latest.json"
    legacy = False
    if not pointer.exists():
        # Before root-scoped local identities, state was keyed by origin alone.
        # Recover only the current checkout's old pointer, with a root check
        # below before exposing any report. Never migrate or overwrite it here.
        identities = [repository["identity"], repository.get("origin")]
        root = Path(repository["root"])
        if root.is_dir():
            remote = _git(root, "config", "--get", "remote.origin.url", optional=True)
            if not remote:
                remotes = _git(root, "remote").decode("utf-8", "surrogateescape").splitlines()
                if remotes:
                    remote = _git(root, "config", "--get", f"remote.{sorted(remotes)[0]}.url", optional=True)
            if remote:
                identities.append(canonicalize_origin(os.fsdecode(remote).strip()))
        base = ensure_external_output(repository["root"], state_dir or default_state_dir())
        for identity in dict.fromkeys(identities):
            if not identity:
                continue
            candidate = base / hashlib.sha256(identity.encode()).hexdigest()[:24]
            if (candidate / "latest.json").exists():
                directory, pointer, legacy = candidate, candidate / "latest.json", True
                break
        else:
            return None
    index = read_json(pointer)
    name = index.get("report")
    if not isinstance(name, str) or not re.fullmatch(r"[0-9TZ-]+-[0-9a-f]{12}\.json", name):
        raise ReportError("Invalid latest report pointer")
    report_path = directory / name
    if not report_path.resolve().is_relative_to(directory.resolve()):
        raise ReportError("Report path escapes state directory")
    expected_hash = index.get("sha256")
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise ReportError("Missing or invalid stored report integrity hash")
    if hashlib.sha256(report_path.read_bytes()).hexdigest() != expected_hash:
        raise ReportError("Stored report integrity check failed; preserve the original and create a new assessment")
    data = read_json(report_path)
    metadata = data.get("repository")
    if not isinstance(metadata, dict) or data.get("rubricVersion") != RUBRIC_VERSION:
        raise ReportError("Stored report belongs to a different repository or rubric")
    if not legacy and metadata.get("identity") != repository["identity"]:
        raise ReportError("Stored report belongs to a different repository or rubric")
    if legacy or "://" not in repository["identity"] or repository["identity"].startswith("file:"):
        recorded_root = metadata.get("root", "")
        try:
            same_root = Path(recorded_root).resolve() == Path(repository["root"]).resolve()
        except (OSError, RuntimeError, ValueError):
            same_root = False
        if not isinstance(recorded_root, str) or not same_root:
            if legacy:
                return None
            raise ReportError("Stored report belongs to a different repository or rubric")
        if legacy and metadata.get("identity") != identity:
            raise ReportError("Stored report belongs to a different repository or rubric")
    _validate_structure(data, Path(data["repository"]["root"]), check_paths=False)
    # Scores are derived, never trusted from editable report JSON.
    data["summary"] = score_report(data["report"])
    return data


def _escape(text: object) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", " ")
        .replace("|", "\\|")
    )


def _code_span(value: object) -> str:
    text = str(value).replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    fence = "`" * (1 + max((len(run) for run in re.findall(r"`+", text)), default=0))
    if text.startswith("`") or text.endswith("`") or (text.startswith(" ") and text.endswith(" ") and text.strip()):
        text = " " + text + " "
    return fence + text + fence


def _format_score_percent(percent: float, level: int) -> str:
    """Keep a value just below a level boundary from rounding up to that boundary."""
    thresholds = {1: 20.0, 2: 40.0, 3: 60.0, 4: 80.0}
    boundary = thresholds.get(level)
    text = f"{percent:.1f}"
    if boundary is None or not (percent < boundary and text == f"{boundary:.1f}"):
        return text
    finer = f"{percent:.2f}"
    if float(finer) < boundary:
        return finer
    return f"{boundary - 0.1:.1f}"


def _comparison(data: dict, previous: dict) -> dict:
    """Freeze the computed delta so viewing a saved report preserves its history."""
    criteria = []
    for key, value in data["report"].items():
        old = previous.get("report", {}).get(key)
        if old is None or (old["numerator"], old["denominator"]) != (value["numerator"], value["denominator"]):
            criteria.append({"criterionId": key, "before": old, "after": value})
    applications = []
    old_apps = previous.get("apps", {})
    for path in sorted(set(data["apps"]) | set(old_apps)):
        old, new = old_apps.get(path), data["apps"].get(path)
        if old != new:
            applications.append({"path": path, "before": old, "after": new})
    return {
        "previousReportId": previous.get("id"),
        "previousCreatedAt": previous.get("createdAt"),
        "previousCommit": previous.get("repository", {}).get("head"),
        "criteria": criteria,
        "applications": applications,
    }


def render_markdown(data: dict, previous: dict | None = None) -> str:
    summary = score_report(data["report"])
    percent = summary["scorePercent"]
    if isinstance(percent, bool) or not isinstance(percent, (int, float)):
        shown_percent = percent
    else:
        shown_percent = _format_score_percent(float(percent), int(summary["achievedLevel"]))
    lines = [
        "# Level", "", f"Level {summary['achievedLevel']} · {shown_percent}%", "",
        f"Repository: {_escape(data['repository']['identity'])}",
        f"Rubric: {RUBRIC_VERSION} · Commit: {data['repository'].get('head') or 'unborn'}", "",
        "# Applications", "",
    ]
    for path, app in data["apps"].items():
        lines.append(f"- {_code_span(path)} — {_escape(app['description'])}")
    lines.extend(["", "# Criteria", ""])
    catalog = load_catalog()
    for category in catalog["categories"]:
        lines.extend([f"## {category['name']}", ""])
        for criterion in catalog["criteria"]:
            if criterion["category"] != category["id"]:
                continue
            key = criterion["id"]
            value = data["report"][key]
            fraction = "N/A" if value["numerator"] is None else f"{value['numerator']}/{value['denominator']}"
            lines.append(f"- **{criterion['name']}** (`{key}`): {fraction} — {_escape(value['rationale'])}")
            for item in data["evidence"][key]:
                if item["kind"] == "file":
                    source = f"{_code_span(str(item['path']) + ':' + str(item.get('line', 1)))} — {_escape(item['note'])}"
                else:
                    source = f"{_code_span(item['command'])} [cwd={_code_span(item['cwd'])}, exit={item['exitCode']}] — {_escape(item['output'])}"
                lines.append(f"  Evidence: {source}")
        lines.append("")
    lines.extend(["# Action Items", ""])
    failures = [row for row in catalog["criteria"] if status(data["report"][row["id"]]) == "failed"]
    failures.sort(key=lambda row: (row["level"], row["scope"] != "repository", row["id"]))
    if data.get("actionItems"):
        for action in data["actionItems"]:
            lines.append(f"- `{action['criterionId']}` — {_escape(action['action'])} {_escape(action['reason'])}")
    else:
        for row in failures[:3]:
            lines.append(f"- `{row['id']}` — {row['description']} Re-verify its recorded evidence before changing code.")
    if not failures:
        lines.append("No failing evaluated signals. Review skipped criteria separately; a high score does not establish universal readiness.")
    comparison = _comparison(data, previous) if previous is not None else data.get("comparison")
    if comparison is not None:
        lines.extend(["", "# Changes Since Last Report", ""])
        lines.extend([
            f"Previous report: {_escape(comparison.get('previousReportId') or 'unknown')} · "
            f"Date: {_escape(comparison.get('previousCreatedAt') or 'unknown')} · "
            f"Commit: {_escape(comparison.get('previousCommit') or 'unborn')}", "",
        ])
        for change in comparison["criteria"]:
            key, old, value = change["criterionId"], change["before"], change["after"]
            lines.append(f"- `{key}`: {old['numerator'] if old else '?'} / {old['denominator'] if old else '?'} → {value['numerator']} / {value['denominator']} — {_escape(value['rationale'])}")
        for change in comparison["applications"]:
            old, new = change["before"], change["after"]
            action = "added" if old is None else "removed" if new is None else "updated"
            description = new["description"] if new is not None else old["description"]
            lines.append(f"- Application {action}: {_code_span(change['path'])} — {_escape(description)}")
        if not comparison["criteria"] and not comparison["applications"]:
            lines.append("No application or score changes.")
    lines.extend(["", "Local report; evidence and scoring are reproducible. Criterion judgments are supplied by the evaluating agent.", ""])
    return "\n".join(lines)


def _repository_field_matches(key: str, previous: dict, current: dict) -> bool:
    if previous.get(key) == current.get(key):
        return True
    # /tmp and /private/tmp are the same checkout. A stored alias is not a new root.
    if key != "root" or not isinstance(previous.get(key), str) or not isinstance(current.get(key), str):
        return False
    try:
        return Path(previous[key]).resolve() == Path(current[key]).resolve()
    except (OSError, RuntimeError, ValueError):
        return False


def _same_directory_root(target: str | Path, repository: dict) -> dict:
    """Keep the caller's absolute path when it is only a symlink alias of the snapshot root.

    macOS ``/tmp`` and ``/private/tmp`` are the same directory. Reports should
    retain the path the operator passed so a later read matches that string.
    """
    requested = Path(target).expanduser()
    recorded = repository.get("root")
    if not requested.is_absolute() or not isinstance(recorded, str):
        return repository
    try:
        same = requested.resolve() == Path(recorded).resolve()
    except (OSError, RuntimeError, ValueError):
        return repository
    if not same or str(requested) == recorded:
        return repository
    return dict(repository, root=str(requested))


def store_report(data: dict, target: str | Path, state_dir: str | Path | None = None) -> dict:
    repository = _same_directory_root(target, validate_evaluation(data, target))
    directory = _repo_state(repository, state_dir)
    previous = latest_report(repository, state_dir)
    stored = dict(data, repository=repository, summary=score_report(data["report"]))
    # Never trust a comparison supplied in an agent's input document.
    stored.pop("comparison", None)
    if previous is not None:
        stored["comparison"] = _comparison(stored, previous)
    stored["createdAt"] = datetime.now(timezone.utc).isoformat()
    stored["id"] = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:12]
    stored["validatorVersion"] = __version__
    markdown = render_markdown(stored, previous)
    # Check once more immediately before committing local state.
    if inspect_repository(target)["fingerprint"] != repository["fingerprint"]:
        raise ReportError("Repository changed during report validation")
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    json_path = directory / f"{stored['id']}.json"
    md_path = directory / f"{stored['id']}.md"
    _atomic_write(json_path, json_text(stored))
    _atomic_write(md_path, markdown)
    _atomic_write(directory / "latest.json", json_text({"report": json_path.name, "sha256": hashlib.sha256(json_path.read_bytes()).hexdigest()}))
    return {"report": str(json_path), "markdown": str(md_path), "summary": stored["summary"]}


def _atomic_write(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise
    os.chmod(path, 0o600)
