"""Bounded command syntax checks for captured test-discovery records.

These checks never execute commands and do not authenticate captured output or
prove arbitrary package scripts behave as described by their evaluator.
"""

import json
from pathlib import Path
import re
import shlex

from .application_scope import javascript_selection


def python_collection_file(words: list[str], *, addopts: str = "") -> str | None:
    """Return the sole literal pytest file, or reject unsupported scope."""
    args = words[1:]
    if Path(words[0]).name != "pytest":
        while args and args[0] in {"-B", "-I", "-E", "-s"}:
            args = args[1:]
        if args[:2] != ["-m", "pytest"]:
            return None
        args = args[2:]
    try:
        args = shlex.split(addopts) + args
    except ValueError:
        return None
    value_options = {
        "-k", "-m", "-p", "-c", "--config-file", "-o", "--override-ini", "--rootdir",
        "--confcutdir", "--import-mode", "--tb", "--capture", "--color",
        "--code-highlight", "--maxfail", "--durations", "--durations-min",
        "--ignore", "--ignore-glob", "--deselect", "--log-level",
    }
    switches = {"--collect-only", "--co", "--quiet", "--verbose", "-s", "-x",
                "--disable-warnings", "--no-header", "--no-summary", "--noconftest",
                "--strict-config", "--strict-markers", "--continue-on-collection-errors"}
    files, collect, index, positional = [], False, 0, False
    while index < len(args):
        token = args[index]
        index += 1
        if token == "--" and not positional:
            positional = True
            continue
        if not positional and token.startswith("-"):
            key, equal, value = token.partition("=")
            if key in {"--collect-only", "--co"}:
                if equal and value.lower() != "true":
                    return None
                collect = True
            elif key in value_options:
                if not equal:
                    if index == len(args) or args[index].startswith("-"):
                        return None
                    value = args[index]
                    index += 1
                if key in {"-o", "--override-ini"} and value.split("=", 1)[0].strip() == "addopts":
                    return None
            elif any(token.startswith(flag) and token != flag for flag in ("-k", "-m", "-p", "-c", "-o")):
                if token.startswith("-o") and token[2:].split("=", 1)[0].strip() == "addopts":
                    return None
            elif token not in switches and not re.fullmatch(r"-[qv]+", token):
                return None
            continue
        path = token.split("::", 1)[0]
        if (not path.endswith(".py") or any(c in path for c in "*?[]{}")
                or any(part in {"..", ".git"} for part in Path(path).parts)):
            return None
        files.append(path)
    return files[0] if collect and len(files) == 1 else None


def python_collection_matches_file(selected: str, output: str) -> bool:
    """Reject explicit collection paths contradicting the selected file.

    Pytest settings can add paths beyond argv. Module/nodeid output gives a
    bounded cross-check; count-only output cannot prove hidden plugin behavior.
    """
    clean = re.sub(r"\x1b\[[0-9;]*m", "", output)
    paths = re.findall(r"<Module\s+([^>]+\.py)>", clean)
    paths += re.findall(r"(?m)^\s*([^\s<>]+\.py)(?:::|:\s*\d+\s*$)", clean)
    expected = Path(selected).parts
    for path in paths:
        actual = Path(path).parts
        # Pytest may print paths relative to its rootdir instead of the command
        # cwd. Keep compatible suffixes, but do not collapse two different
        # visible parent paths merely because their filenames match.
        if not (expected[-len(actual):] == actual or actual[-len(expected):] == expected):
            return False
    return True


def _javascript_words(words: list[str]) -> list[str]:
    """Strip literal environment prefixes shared by scripts and direct commands."""
    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        words = words[1:]
    # cross-env takes the same `NAME=value... command` form as env.
    if words and Path(words[0]).name in {"env", "cross-env"}:
        words = words[1:]
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words = words[1:]
    return words


def _javascript_collection(words: list[str]) -> bool:
    """Distinguish package dependency listing from a test runner's list mode."""
    words = _javascript_words(words)
    if not words:
        return False
    executable = Path(words[0]).name
    args = words[1:]
    # Package-manager routing options precede the actual command. The scope
    # validator independently checks where these selectors point.
    value_options = {"--prefix", "--cwd", "--dir", "--directory", "-C",
                     "--workspace", "-w", "--filter", "-F", "--cache", "--registry"}
    while args and args[0].startswith("-"):
        option, equal, _ = args[0].partition("=")
        if option == "--":
            args = args[1:]
            break
        consume = 2 if option in value_options and not equal else 1
        args = args[consume:]
    if executable == "yarn" and args[:1] == ["workspace"]:
        args = args[2:]
    if executable == "bun" and args[:1] == ["test"]:
        return False  # Bun test has no native listing mode for these generic flags.
    if executable in {"jest", "vitest"}:
        runner = executable
        runner_args = words[1:]
    else:
        if not args:
            return False
        operation, *runner_args = args
        explicit_script = operation in {"run", "run-script"}
        if operation in {"exec", "x", "run", "run-script"}:
            while runner_args and (runner_args[0] == "--" or runner_args[0].startswith("-")):
                runner_args = runner_args[1:]
            if not runner_args:
                return False
            operation, *runner_args = runner_args
        # Package metadata commands can accept an unknown list flag and exit
        # zero (for example `npm root --listTests`). Only test entry points or
        # explicit package scripts qualify; script behavior still needs evidence.
        if not explicit_script and operation not in {"test", "t", "tst", "jest", "vitest", "playwright"}:
            return False
        runner = operation
        if explicit_script:
            # Lifecycle and build scripts can accept a stray list flag and still
            # exit zero. A script name that is itself a test runner stays eligible.
            folded = runner.lower()
            non_test_scripts = {
                "build", "lint", "format", "typecheck", "start", "dev", "serve",
                "clean", "deploy", "release", "prepare", "prepublish",
            }
            if folded in non_test_scripts and not any(token in folded for token in ("test", "spec", "jest", "vitest")):
                return False
    if runner == "vitest":
        # Global options may precede the subcommand. Do not mistake an option's
        # value (e.g. --config list) for a subcommand.
        options_with_values = {"--config", "-c", "--root", "-r", "--dir", "--mode",
                               "--project", "--reporter", "--pool", "--name",
                               "--environment", "-t", "--testNamePattern", "--shard",
                               "--outputFile", "--workspace", "--exclude"}
        args = runner_args
        while args and args[0].startswith("-") and args[0] != "--":
            key, equal, _ = args[0].partition("=")
            args = args[2 if key in options_with_values and not equal else 1:]
        if args[:1] == ["list"]:
            return True
    if runner == "playwright":
        return runner_args[:1] == ["test"] and "--list" in runner_args
    # A literal `list` alone is never evidence for npm/pnpm/yarn dependency
    # commands, or for an unknown package script.
    return any(arg in {"--listTests", "--list-tests", "--list", "--collect-only"}
               for arg in runner_args)


def javascript_collection(words: list[str], root: Path | None = None,
                          runner_cwd: Path = Path('.'), apps: dict | None = None,
                          *, check_paths: bool = True) -> bool:
    words = _javascript_words(words)
    if not words:
        return False
    if _javascript_collection(words):
        return True
    if root is None or not check_paths or Path(words[0]).name not in {'npm', 'pnpm', 'yarn', 'bun'}:
        return False
    kind, selected = javascript_selection(words, runner_cwd, apps or {'.': {}}, root)
    if kind and (not selected or len(selected) != 1):
        return False
    directory = root / (next(iter(selected)) if selected else runner_cwd)
    manifest = directory / 'package.json'
    try:
        if not manifest.resolve(strict=True).is_relative_to(root.resolve()):
            return False
        scripts = json.loads(manifest.read_text(encoding='utf-8')).get('scripts', {})
    except (OSError, ValueError, AttributeError, RuntimeError):
        return False
    if not isinstance(scripts, dict):
        return False
    # Options and workspace names may precede or follow the script. Match the
    # actual package-script operation, never an arbitrary argv value.
    args, index = words[1:], 0
    value_options = {'--prefix', '--cwd', '--dir', '--directory', '-C', '--workspace', '-w', '--filter', '-F', '--cache', '--registry'}
    while index < len(args) and args[index].startswith('-'):
        option, equal, _ = args[index].partition('=')
        index += 2 if option in value_options and not equal else 1
    args = args[index:]
    if Path(words[0]).name == 'yarn' and args[:1] == ['workspace']:
        args = args[2:]
    explicit_script = args[:1] in (['run'], ['run-script'])
    if explicit_script:
        args = args[1:]
    elif Path(words[0]).name == 'npm' and args[:1] not in (['test'], ['t'], ['tst']):
        return False
    if not args:
        return False
    if not explicit_script and Path(words[0]).name == 'bun' and args[:1] == ['test']:
        return False  # `bun test` always invokes Bun, even with scripts.test set.
    name = 'test' if args[0] in {'t', 'tst'} else args[0]
    body = scripts.get(name)
    if not isinstance(body, str) or any(symbol in body for symbol in ('&&', '|', ';', '`', '$(', '>', '<', '\n')):
        return False
    try:
        inner = shlex.split(body)
    except ValueError:
        return False
    # Arguments after the script name reach the script. npm consumes one
    # leading `--`; pnpm and yarn forward it literally (`vitest -- list` runs).
    extra = args[1:]
    if Path(words[0]).name == 'npm' and extra[:1] == ['--']:
        extra = extra[1:]
    return _javascript_collection(inner + extra)


def javascript_list_output(output: str) -> bool:
    """Require a runner's listed item, excluding package lifecycle banners."""
    clean = re.sub(r"\x1b\[[0-9;]*m", "", output)
    # npm/pnpm echo the script as `> ...`; yarn classic and bun as `$ ...`.
    lines = [line.strip() for line in clean.splitlines() if not line.lstrip().startswith((">", "$ "))]
    for line in lines:
        # Jest paths, Vitest file > test, and Playwright file:line:column items.
        if re.search(r"\.(?:[cm]?[jt]sx?|vue|svelte)(?::\d+(?::\d+)?)?(?:\s+[>›]\s+.+)?$", line):
            return True
    # Jest --listTests --json uses paths; Vitest list --json uses {file, name}
    # objects (or {file} with --filesOnly).
    try:
        paths = json.loads("\n".join(lines))
    except ValueError:
        return False
    if not isinstance(paths, list) or not paths:
        return False
    files = [item.get("file") if isinstance(item, dict) else item for item in paths]
    return all(isinstance(path, str) and re.search(r"\.[cm]?[jt]sx?$", path) for path in files)


def java_test_execution(words: list[str], output: str) -> bool:
    """Recognize the native single-class audit contract in captured records."""
    executable = Path(words[0]).name
    if any(word in words for word in ("--dry-run", "-m", "--tasks", "tasks", "help", "compile", "test-compile")):
        return False
    # Maven accepts attached and separate property forms. Count every test
    # selector, including aliases, so a later unbounded value cannot override it.
    properties = []
    for index, word in enumerate(words):
        if word in {"-D", "--define"}:
            properties.append(words[index + 1] if index + 1 < len(words) else "")
        elif word.startswith("-D"):
            properties.append(word[2:])
        elif word.startswith("--define="):
            properties.append(word.split("=", 1)[1])
    # Explicit false is not a skip; unrelated property names are not skip flags.
    for prop in properties:
        key, separator, value = prop.partition("=")
        if key in {"skipTests", "maven.test.skip"} and (not separator or value.lower() != "false"):
            return False
    selectors = []
    if executable.startswith("gradle"):
        if "--rerun-tasks" not in words:
            return False
        test_tasks = [word for word in words if word == "test" or word.endswith(":test")]
        if len(test_tasks) != 1:
            return False
        for index, word in enumerate(words):
            if word == "--tests":
                selectors.append(words[index + 1] if index + 1 < len(words) else "")
            elif word.startswith("--tests="):
                selectors.append(word.split("=", 1)[1])
    else:
        if "test" not in words or "--rerun-tasks" in words:
            return False
        selectors = [prop.partition("=")[2] for prop in properties if prop.partition("=")[0] == "test"]
    # A wildcard, comma-separated list, regex or repeated filter can select the
    # full suite. Native auditing asks for one concrete existing test class.
    if len(selectors) != 1 or not re.fullmatch(r"[^\W\d]\w*(?:\.[^\W\d]\w*)*", selectors[0]):
        return False
    if executable.startswith("gradle"):
        task = ":" + test_tasks[0].lstrip(":")
        task_lines = re.findall(r"(?m)^\s*>?\s*Task\s+" + re.escape(task) + r"(?=\s|$)([^\n]*)", output)
        observed_tasks = re.findall(r"(?m)^\s*>?\s*Task\s+(:\S+)", output)
        if any(name != task and name.lower().endswith("test") for name in observed_tasks):
            return False
        return bool(task_lines) and not any(re.search(r"UP-TO-DATE|FROM-CACHE|SKIPPED|NO-SOURCE|FAILED", line) for line in task_lines)
    running = re.findall(r"(?m)^\s*(?:\[INFO\]\s*)?Running\s+([\w.$]+)\s*$", output)
    selected = selectors[0]
    for name in running:
        outer = name.split("$", 1)[0]
        if not (outer == selected or outer.endswith("." + selected) or selected.endswith("." + outer)):
            return False
    counts = re.findall(r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)", output)
    if not counts or any(int(failed) or int(errors) for _, failed, errors, _ in counts):
        return False
    if re.search(r"(?m)^\s*(?:\[(?:INFO|ERROR)\]\s*)?BUILD FAILURE\b", output):
        return False
    return any(int(run) > int(skipped) for run, _, _, skipped in counts)


def other_runner_error(words: list[str], output: str) -> str | None:
    """Require native listing/result lines, never a build or success banner alone."""
    executable = Path(words[0]).name
    args = words[1:]
    if executable == "bundle" and args[:1] == ["exec"]:
        return other_runner_error(args[1:], output) if len(args) > 1 else "bundle exec needs a test runner"
    if executable in {"cargo", "dotnet", "mix", "zig", "swift", "flutter", "dart", "deno"}:
        if args[:1] != ["test"]:
            return f"{executable} command does not run tests; use its test subcommand"
        args = args[1:]
    elif executable == 'php' and args[:2] == ['artisan', 'test']:
        executable, args = 'pest', args[2:]
    elif executable not in {"ctest", "ruby", "rspec", "phpunit", "pest", "rake", "mocha", "ava", "tap"}:
        return f"unrecognized test runner {executable}; cite its native test-list command with at least one listed test, or a bounded test file/filter with the runner's passing result lines"
    options = {word.partition("=")[0] for word in args}
    if options & {"--no-run", "--dry-run", "--help", "--version", "-h", "--list-targets", "--help-command"}:
        return "compile-only, dry-run, help or version mode does not list or execute tests; use a native test list or bounded execution"
    if executable == "cargo":
        listing = "--" in args and "--list" in args[args.index("--") + 1:]
        if listing:
            return None if re.search(r"(?m)^\s*\S[^\n]*:\s*test\s*$", output) else "cargo -- --list output must enumerate at least one test"
        cargo_args = args[:args.index("--")] if "--" in args else args
        value_flags = {"-p", "--package", "--manifest-path", "--test", "--bin", "--example", "--features", "--target", "--target-dir", "--profile", "--jobs", "-j", "--color", "--config"}
        positional, index = [], 0
        while index < len(cargo_args):
            word = cargo_args[index]
            if word in value_flags:
                index += 2
                continue
            if not word.startswith("-"):
                positional.append(word)
            index += 1
        scoped = bool(positional) or bool(options & {"-p", "--package", "--manifest-path", "--test", "--lib", "--bin"})
        if not scoped:
            return "cargo test without -- --list, a test filter or a crate/library selector runs the full suite; select a bounded target"
        return None if re.search(r"test result:\s*ok\.\s*[1-9]\d* passed", output, re.I) else "cargo output must report at least one passing test"
    if executable == "ctest":
        if options & {"-N", "--show-only"}:
            listed = re.search(r"(?m)^\s*Test\s+#\d+:\s*\S", output)
            try:
                document = json.loads(output)
            except ValueError:
                document = None
            if isinstance(document, dict) and isinstance(document.get("tests"), list):
                listed = any(isinstance(test, dict) and isinstance(test.get("name"), str) and test["name"].strip() for test in document["tests"])
            return None if listed else "ctest list output must enumerate at least one test"
        if not options & {"-R", "--tests-regex", "-I", "--tests-information"}:
            return "ctest execution needs a test selector; use -R <test> or -N to list"
        return None if re.search(r"[1-9]\d* tests? passed|100% tests passed, 0 tests failed out of [1-9]\d*", output, re.I) else "ctest output must report at least one passing test"
    if executable == "dotnet":
        if "--list-tests" in options or "-t" in options:
            listed = re.search(r"(?im)^The following Tests are available:\s*\n(?:[ \t]*\n)*[ \t]+\S", output)
            return None if listed else "dotnet --list-tests output must enumerate at least one test"
        if "--filter" not in options and not any(word.endswith((".csproj", ".fsproj", ".vbproj")) for word in args):
            return "dotnet test needs a project or test filter; use --filter or --list-tests"
        return None if re.search(r"Passed:\s*[1-9]\d*|Passed!.*Total:\s*[1-9]\d*", output, re.I) else "dotnet output must report at least one passing test"
    if executable in {"phpunit", "pest"} and options & {"--list-tests", "--list-tests-xml"}:
        return None if re.search(r"(?m)^\s*-\s+\S|<testCase\b", output) else f"{executable} listing must enumerate at least one test"
    if executable in {"swift", "dart", "flutter", "deno", "mocha", "ava", "tap"} and options & {"--list-tests", "--list"}:
        return None if re.search(r"(?m)^\s*\S+(?:::|/| > )\S+", output) else f"{executable} listing must enumerate at least one test"
    if executable == "rake" and (options & {"-T", "--tasks", "-D", "--describe", "-P", "--prereqs", "-n"} or not any(word == "test" or word.startswith("test:") for word in args)):
        return "rake must execute a bounded test task; task listing/dry runs are not test evidence"
    selected = any(not word.startswith("-") and ("/" in word or word.endswith((".rb", ".php", ".exs", ".dart", ".ts", ".js", ".zig")) or word.startswith("TEST=")) for word in args)
    selected = selected or bool(options & {"--filter", "--name", "--grep", "-e", "--example", "--test-filter"})
    if not selected:
        return f"{executable} execution needs a test file or filter; select a bounded target"
    if executable == 'pest':
        if re.search(r'(?im)^\s*FAIL\b|\b[1-9]\d*\s+failed\b', output):
            return 'pest output reports failed tests; capture successful test results'
        result = re.search(r'(?im)^\s*Tests:\s*(?:.*?\s)?[1-9]\d*\s+passed\b|\bOK\s*\([1-9]\d*\s+tests?\b', output)
        return None if result else "pest output must report Tests: N passed or OK (N tests) for at least one test"
    result = re.search(r"\b[1-9]\d*\s+(?:tests?|examples?|passing|passed|runs)|\bOK\s*\([1-9]\d*\s+tests?\)|\bAll [1-9]\d* tests? passed|\+[1-9]\d*:.*All tests passed", output, re.I)
    return None if result else f"{executable} output must contain the runner's result lines for at least one test"
