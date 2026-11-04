"""Local transport for an agent-led readiness assessment and repair loop."""

from __future__ import annotations

import argparse
import codecs
import json
import math
import os
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import __version__
from .catalog import criteria_by_id, load_catalog
from .prompts import assessment_prompt, fix_prompt, fix_without_report_prompt
from .report import ReportError, json_text, latest_report, new_evaluation, read_json, render_markdown, store_report
from .repository import RepositoryError, _root, command_cwd, ensure_external_output, inspect_repository
from .scoring import score_report, status
from .validation import ValidationError

# Output kept by `capture`: the first and last characters, with a marker for the gap.
CAPTURE_HEAD = 6000
CAPTURE_TAIL = 3000
CAPTURE_TIMEOUT_EXIT = 124


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Agent-led readiness workflows, pinned to the 0.240.0 rubric. No model API is called by this CLI.")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)
    catalog = commands.add_parser("catalog", help="Print the exact versioned rule catalog")
    catalog.add_argument("--id", help="Print one criterion")
    prepare = commands.add_parser("prepare", help="Create a read-only assessment task and UNASSESSED template outside the target")
    prepare.add_argument("target")
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--state-dir", type=Path)
    prepare.add_argument("--instructions", default="")
    report = commands.add_parser("report", help="Validate a completed evaluation and save a scored JSON/Markdown report")
    report.add_argument("target")
    report.add_argument("--input", type=Path, required=True)
    report.add_argument("--state-dir", type=Path)
    report.add_argument("--json", action="store_true", help="Print the {report, markdown, summary} receipt; read receipt.report for the full evaluation with evidence")
    capture = commands.add_parser(
        "capture", usage="%(prog)s --target TARGET [--cwd DIR] --timeout SECONDS [--append-to EVALUATION --criterion ID [--application APP]] -- COMMAND...",
        help="Optional helper: run one command inside the target and print (or append) its command evidence record")
    capture.add_argument("--target", required=True)
    capture.add_argument("--cwd", help="Directory inside the target to run in; relative paths are relative to the target root (default: the root)")
    capture.add_argument("--timeout", type=float, required=True, help="Seconds before the command's process group is killed (exit code 124)")
    capture.add_argument("--append-to", type=Path, help="evaluation.json outside the target to update atomically")
    capture.add_argument("--criterion", help="Criterion ID whose evidence list receives the record (with --append-to)")
    capture.add_argument("--application", help="Application directory to put on the record (monorepo commands)")
    show =commands.add_parser("show", help="Read the latest local report")
    show.add_argument("target")
    show.add_argument("--state-dir", type=Path)
    show.add_argument("--json", action="store_true")
    fix = commands.add_parser("fix", help="Render a repair task from the latest report; the host agent performs actual edits")
    fix.add_argument("target")
    fix.add_argument("--state-dir", type=Path)
    selection = fix.add_mutually_exclusive_group()
    selection.add_argument("--signals", help="Comma-separated exact criterion IDs")
    selection.add_argument("--all", action="store_true", dest="all_signals")
    selection.add_argument("--target-level", type=int, choices=range(1, 6))
    fix.add_argument("--instructions", default="")
    score = commands.add_parser("score", help="Native-compatible arithmetic on supplied values; does NOT validate repository readiness")
    score.add_argument("--input", type=Path, required=True)
    return root


class _OutputWindow:
    """Keeps the first CAPTURE_HEAD and last CAPTURE_TAIL characters of a stream."""

    def __init__(self) -> None:
        self.head = self.tail = ""
        self.total = 0

    def feed(self, text: str) -> None:
        self.total += len(text)
        room = CAPTURE_HEAD - len(self.head)
        if room > 0:
            self.head += text[:room]
            text = text[room:]
        self.tail = (self.tail + text)[-CAPTURE_TAIL:]

    def text(self) -> str:
        omitted = self.total - len(self.head) - len(self.tail)
        if omitted <= 0:
            return self.head + self.tail
        return f"{self.head}\n[... {omitted} characters omitted by capture ...]\n{self.tail}"


def _run_captured(command: str, cwd: Path, timeout: float) -> tuple[int, str]:
    """Run `/bin/sh -c command` and return its real exit code and combined output."""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PWD=str(cwd))
    deadline = time.monotonic() + timeout
    process = subprocess.Popen(
        ["/bin/sh", "-c", command], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    window = _OutputWindow()
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    os.set_blocking(process.stdout.fileno(), False)
    timed_out = False
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                # The shell may already have exited while children hold stdout.
                # Always signal the group, including TERM-resistant descendants.
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    # Reap a dead shell first: macOS refuses killpg with EPERM when
                    # the group holds only a zombie (a setsid child escaped it).
                    process.poll()
                    try:
                        os.killpg(process.pid, sig)
                    except (ProcessLookupError, PermissionError):
                        pass
                    if sig == signal.SIGTERM:
                        time.sleep(0.1)
                process.wait()
                # Keep bytes already in the pipe without waiting on a process
                # that escaped the session. The timeout note marks truncation.
                drain_deadline = time.monotonic() + 0.1
                while time.monotonic() < drain_deadline:
                    try:
                        chunk = os.read(process.stdout.fileno(), 65536)
                    except BlockingIOError:
                        break
                    if not chunk:
                        break
                    window.feed(decoder.decode(chunk))
                break
            if not selector.get_map():
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    pass
                continue
            for key, _ in selector.select(remaining):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    window.feed(decoder.decode(chunk))
    process.stdout.close()
    window.feed(decoder.decode(b"", final=True))
    output = window.text()
    code = process.returncode
    note = ""
    if timed_out:
        code = CAPTURE_TIMEOUT_EXIT
        note = f"[capture: timed out after {timeout:g}s; output truncated by timeout; the process group was killed]"
    elif code < 0:
        note = f"[capture: terminated by signal {-code}]"
        code = 128 - code
    if note and output and not output.endswith("\n"):
        output += "\n"
    return code, output + note


def _lock_directory(directory: Path):
    """Serialise concurrent --append-to updates of files in one directory (POSIX only)."""
    try:
        import fcntl
    except ImportError:
        return None
    descriptor = os.open(directory, os.O_RDONLY)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor


def _append_evidence(path: Path, criterion: str, record: dict) -> int:
    """Atomically add `record` to evidence[criterion]; returns the new list length."""
    lock = _lock_directory(path.parent)
    try:
        data = read_json(path)
        evidence = data.setdefault("evidence", {})
        if not isinstance(evidence, dict) or not isinstance(evidence.setdefault(criterion, []), list):
            raise ReportError(f"{path.name}: evidence must be an object of lists; evidence.{criterion} is not a list")
        evidence[criterion].append(record)
        text = json_text(data)
        mode = path.stat().st_mode & 0o777
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(name, mode)
            os.replace(name, path)
        except BaseException:
            if os.path.exists(name):
                os.unlink(name)
            raise
        return len(evidence[criterion])
    finally:
        if lock is not None:
            os.close(lock)


def capture_command(args: argparse.Namespace) -> int:
    """Run one command in the target and emit an honest command evidence record."""
    words = args.shell_command
    if not words:
        raise ReportError("capture needs a command after `--`")
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        raise ReportError("--timeout must be a positive number of seconds")
    if bool(args.append_to) != bool(args.criterion):
        raise ReportError("--append-to and --criterion must be used together")
    root = _root(args.target)
    try:
        command_cwd(root, args.cwd or ".")
    except RepositoryError as error:
        raise ReportError(f"--cwd: {error}") from error
    try:
        cwd = (root / Path(args.cwd or ".").expanduser()).resolve(strict=True)  # an absolute --cwd replaces the root
    except (OSError, RuntimeError) as error:
        raise ReportError(f"--cwd cannot be resolved: {error}") from error
    if not cwd.is_dir() or (cwd != root and root not in cwd.parents):
        raise ReportError("--cwd must be an existing directory inside the target; capture never runs outside it")
    try:
        relative = command_cwd(root, cwd.relative_to(root).as_posix())
    except RepositoryError as error:
        raise ReportError(f"--cwd: {error}") from error
    destination = None
    if args.append_to:
        if args.criterion not in criteria_by_id():
            raise ReportError(f"Unknown criterion: {args.criterion}")
        destination = ensure_external_output(root, args.append_to)
        read_json(destination)  # fail before running anything long
    command = words[0] if len(words) == 1 else shlex.join(words)
    code, output = _run_captured(command, cwd, args.timeout)
    record: dict = {
        "kind": "command", "command": command, "cwd": relative, "exitCode": code, "output": output,
        "timeoutSeconds": int(args.timeout) if float(args.timeout).is_integer() else args.timeout,
    }
    if args.application:
        record["application"] = args.application
    if destination is not None:
        count = _append_evidence(destination, args.criterion, record)
        print(f"readiness: appended to evidence.{args.criterion} ({count} records) in {destination}", file=sys.stderr)
    print(json_text(record), end="")
    return 0


def report_summary(receipt: dict) -> str:
    """Short human summary of a stored report; the receipt paths are the full records."""
    stored = read_json(receipt["report"])
    counts = {"passed": 0, "failed": 0, "skipped": 0}
    for value in stored["report"].values():
        counts[status(value)] += 1
    summary = receipt["summary"]
    apps = ", ".join(stored.get("apps", {})) or "."
    lines = [
        f"Level {summary['achievedLevel']} - {summary['scorePercent']:.1f}%",
        f"Criteria: {counts['passed']} passed, {counts['failed']} failed, {counts['skipped']} skipped (of {len(stored['report'])})",
        f"Applications ({len(stored.get('apps', {}))}): {apps}",
    ]
    comparison = stored.get("comparison")
    if comparison:
        lines.append(f"Changed since previous report: {len(comparison['criteria'])} criteria, {len(comparison['applications'])} applications")
    lines.extend([f"JSON: {receipt['report']}", f"Markdown: {receipt['markdown']}", "JSON receipt: re-run with --json; full evaluation with evidence: read the JSON file."])
    return "\n".join(lines) + "\n"


def run(args: argparse.Namespace) -> int:
    if args.command == "catalog":
        data = load_catalog()
        if args.id:
            if args.id not in criteria_by_id():
                raise ReportError(f"Unknown criterion: {args.id}")
            data = criteria_by_id()[args.id]
        print(json_text(data), end="")
    elif args.command == "score":
        data = read_json(args.input)
        values = data.get("report", data)
        if not isinstance(values, dict):
            raise ReportError("score input must be a criterion evaluation object")
        for key, value in values.items():
            if key not in criteria_by_id():
                continue  # Native scorer ignores unknown IDs.
            if not isinstance(value, dict):
                raise ReportError(f"{key}: expected an evaluation object")
            for field in ("numerator", "denominator"):
                number = value.get(field)
                if field == "numerator" and number is None:
                    continue
                if type(number) not in (int, float) or not math.isfinite(number):
                    raise ReportError(f"{key}: {field} must be a finite number")
        print(json_text(score_report(values)), end="")
    elif args.command == "prepare":
        repository = inspect_repository(args.target)
        output = ensure_external_output(repository["root"], args.output)
        previous = latest_report(repository, args.state_dir)
        names = ["snapshot.json", "evaluation.json", "assessment.md"]
        if previous:
            names.append("previous-report.json")
        if any((output / name).exists() or (output / name).is_symlink() for name in names):
            raise ReportError("Task output already exists; choose a new directory to preserve prior evaluations")
        output.mkdir(parents=True, exist_ok=True)
        files = {
            "snapshot.json": json_text(repository),
            "evaluation.json": json_text(new_evaluation(repository)),
            "assessment.md": assessment_prompt(repository, output, previous, args.instructions),
        }
        if previous:
            files["previous-report.json"] = json_text(previous)
        for name, content in files.items():
            with (output / name).open("x", encoding="utf-8") as stream:
                stream.write(content)
        print(json_text({"task": str(output / "assessment.md"), "evaluation": str(output / "evaluation.json"), "status": "awaiting_agent_evaluation", "criteria": len(criteria_by_id())}), end="")
    elif args.command == "report":
        receipt = store_report(read_json(args.input), args.target, args.state_dir)
        print(json_text(receipt) if args.json else report_summary(receipt), end="")
    elif args.command == "capture":
        return capture_command(args)
    else:
        repository = inspect_repository(args.target)
        previous = latest_report(repository, args.state_dir)
        if previous is None and args.command == "show":
            raise ReportError("No local readiness report for this repository; prepare and complete an assessment, then run report first")
        if args.command == "show":
            print(json_text(previous) if args.json else render_markdown(previous), end="")
        elif args.command == "fix":
            signals = None
            if args.signals is not None:
                signals = [item.strip() for item in args.signals.split(",") if item.strip()]
                if not signals:
                    raise ReportError("--signals must select at least one criterion")
            options = dict(signals=signals, all_signals=args.all_signals, target_level=args.target_level, instructions=args.instructions)
            task = fix_prompt(repository, previous, **options) if previous is not None else fix_without_report_prompt(repository, **options)
            print(task, end="")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    shell_command = None
    if argv[:1] == ["capture"] and "--" in argv:
        split = argv.index("--")
        argv, shell_command = argv[:split], argv[split + 1:]
    args = parser().parse_args(argv)
    args.shell_command = shell_command
    try:
        return run(args)
    except (ValueError, OSError, KeyError, TypeError, OverflowError) as error:
        if (isinstance(error, ValidationError) and args.command != "capture") or args.command == "report":
            if not isinstance(error, ValidationError):
                error = ReportError(str(error))
            for problem in error.problems:
                print(f"readiness: {problem}", file=sys.stderr)
            omitted = f" ({error.omitted_count} more not shown)" if error.omitted_count else ""
            print(f"{error.problem_count} problems{omitted}; fix all and re-run {args.command}", file=sys.stderr)
        else:
            print(f"readiness: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
