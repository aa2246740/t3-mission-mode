"""Read-only Git snapshots and validation of repository-local evidence.

Snapshots include the contents of tracked and non-ignored untracked files. They
never include Git credential/configuration files, and symlinks are hashed as
links rather than followed. Commands cited as evidence are not executed here.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
from collections import deque
from collections.abc import Mapping
from urllib.parse import urlsplit, urlunsplit

from .validation import Problems, ValidationError


class RepositoryError(ValidationError):
    """The repository or a supplied evidence/output path is invalid."""


# filter.<name>.clean and filter.<name>.process are executable commands.
_FILTER_COMMAND = re.compile(r"filter\..+\.(?:clean|process)\Z")


def _disabled_filter_args(root: Path) -> list[str]:
    """Blank configured clean/process filters so read-only Git cannot run them."""
    output = _git(root, "config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process)$", optional=True)
    args: list[str] = []
    output = output or b""

    seen: set[str] = set()
    for raw in output.split(b"\0"):
        key = os.fsdecode(raw)
        if not key:
            continue
        if key in seen or _FILTER_COMMAND.fullmatch(key) is None:
            continue
        seen.add(key)
        if "=" in key:
            raise RepositoryError("Cannot safely disable a Git filter whose name contains '='")
        args.extend(("-c", f"{key}=", "-c", f"{key.rsplit('.', 1)[0]}.required=false"))
    # Parent `git status` launches Git in submodules, inheriting -c overrides.
    # Include their filter names too before that first recursive status.
    listed = _git(root, "ls-files", "--stage", "-z")
    for entry in listed.split(b"\0"):
        if not entry.startswith(b"160000 ") or b"\t" not in entry:
            continue
        child = root / os.fsdecode(entry.split(b"\t", 1)[1])
        if child.is_dir() and not child.is_symlink() and child.resolve().is_relative_to(root.resolve()):
            args.extend(_disabled_filter_args(child))
    return args


def _git(root: Path, *args: str, optional: bool = False, disable_filters: bool = False) -> bytes | None:
    env = os.environ.copy()
    env["GIT_OPTIONAL_LOCKS"] = "0"
    # Caller-level Git overrides must not redirect a snapshot into another repo.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(key, None)
    config = ["-c", "core.fsmonitor=false"]
    if disable_filters:
        config.extend(_disabled_filter_args(root))
    try:
        result = subprocess.run(
            # A configured fsmonitor hook is executable code; inspection must
            # not run it or rely on an untrusted cached filesystem observation.
            ["git", *config, "-C", str(root), *args],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise RepositoryError("Git is required to inspect a repository") from exc
    if result.returncode:
        if optional:
            return None
        # Git diagnostics can contain credential-bearing remote URLs.
        raise RepositoryError(f"Unable to read Git repository ({args[0]})")
    return result.stdout


def _root(path: str | os.PathLike[str]) -> Path:
    try:
        candidate = Path(path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RepositoryError("Repository path does not exist or cannot be resolved") from exc
    if not candidate.is_dir():
        raise RepositoryError("Repository path must be a directory")
    output = _git(candidate, "rev-parse", "--show-toplevel")
    try:
        return Path(os.fsdecode(output.removesuffix(b"\n"))).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RepositoryError("Unable to resolve Git repository root") from exc


def _canonicalize_local_path(value: str, root: Path | None) -> str:
    """Resolve a filesystem remote against its checkout and drop decorations."""
    value = value.split("?", 1)[0].split("#", 1)[0]
    candidate = Path(value)
    if root is not None and not candidate.is_absolute():
        candidate = root / candidate
    if candidate.is_absolute():
        value = str(candidate.resolve())
    value = value.rstrip("/")
    return value[:-4] if value.endswith(".git") else value


def _repository_identity(origin: str | None, root: Path) -> str:
    """Network remotes stay canonical; local paths stay tied to this checkout.

    Two checkouts can both name ``../shared.git`` or the same absolute path.
    Resolving the path is not enough when that upstream is shared, so a local
    or ``file:`` origin keeps the checkout root in the identity.
    """
    if not origin:
        return f"local:{root}"
    if "://" in origin and not origin.startswith("file:"):
        return origin
    return f"{origin}@{root}"


def canonicalize_origin(origin: str, root: Path | None = None) -> str:
    """Remove credentials and normalize common HTTPS, SSH, SCP and local Git URLs.

    The transport does not define repository identity: ordinary HTTPS and SSH
    URLs for the same host/path share the canonical HTTPS representation.
    A relative local path is resolved against ``root`` when that checkout is
    known, so ``../shared.git`` in two repositories does not collapse.
    """
    value = origin.strip()
    if not value or "\x00" in value or "\n" in value or "\r" in value:
        raise RepositoryError("Invalid Git remote URL")
    if "://" not in value:
        # user:token@host:path is still SCP. The userinfo may itself contain
        # a colon, so it cannot be excluded from the optional prefix.
        scp = re.fullmatch(r"(?:[^/@]+@)?([^/:]+):(.+)", value)
        if scp:
            value = f"ssh://{scp.group(1)}/{scp.group(2).lstrip('/')}"
        else:
            return _canonicalize_local_path(value, root)
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise RepositoryError("Invalid Git remote URL") from exc
    path = parsed.path.rstrip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if parsed.scheme == "file":
        return urlunsplit(("file", host or "", path, "", ""))
    if not host:
        raise RepositoryError("Invalid Git remote URL")
    host = host.lower()
    if ":" in host:
        host = f"[{host}]"
    default_ports = {"http": 80, "https": 443, "ssh": 22, "git": 9418}
    if port is not None and port != default_ports.get(parsed.scheme):
        host = f"{host}:{port}"
    scheme = "https" if parsed.scheme in default_ports else parsed.scheme
    return urlunsplit((scheme, host, path, "", ""))


def _relative_parts(value: object, *, allow_dot: bool = False) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise RepositoryError("Evidence path must be a nonempty relative path")
    path = PurePosixPath(value)
    # Reject Windows absolute paths too, even when running on POSIX.
    if path.is_absolute() or re.match(r"^[A-Za-z]:", value) or "\\" in value:
        raise RepositoryError("Evidence path must be relative to the repository")
    parts = path.parts
    if ".." in parts or ".git" in parts:
        raise RepositoryError("Evidence path must not traverse parents or Git metadata")
    if not parts and not allow_dot:
        raise RepositoryError("Evidence file path must name a file")
    return parts


def _inside(root: Path, path: Path) -> bool:
    return path == root or root in path.parents


def _evidence_path(root: Path, value: object, *, directory: bool = False) -> Path:
    parts = _relative_parts(value, allow_dot=directory)
    try:
        path = root.joinpath(*parts).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise RepositoryError("Evidence path does not exist or cannot be resolved") from exc
    if not _inside(root, path):
        raise RepositoryError("Evidence path escapes the repository through a symlink")
    if ".git" in path.relative_to(root).parts:
        raise RepositoryError("Git metadata cannot be cited as file evidence")
    if directory and not path.is_dir():
        raise RepositoryError("Command evidence cwd must be an existing directory")
    if not directory and not path.is_file():
        raise RepositoryError("File evidence must name an existing regular file")
    return path


def _nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _snapshot_owner(root: Path, path: Path, owners: dict[Path, Path]) -> Path:
    """Find the worktree that contains path, without a rev-parse per file."""
    current = path.parent
    stacked: list[Path] = []
    while True:
        cached = owners.get(current)
        if cached is not None:
            owner = cached
            break
        stacked.append(current)
        if current == root:
            owner = root
            break
        if root not in current.parents:
            owner = _root(current)
            break
        if (current / ".git").exists():
            owner = _root(current)
            break
        current = current.parent
    if not _inside(root, owner):
        raise RepositoryError("File evidence must belong to the evaluated repository")
    for directory in stacked:
        owners[directory] = owner
    return owner


def _snapshot_entries(owner: Path, cache: dict[Path, set[bytes]]) -> set[bytes]:
    """List tracked and non-ignored untracked paths once per worktree."""
    entries = cache.get(owner)
    if entries is None:
        listed = _git(owner, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        entries = {entry for entry in listed.split(b"\x00") if entry}
        cache[owner] = entries
    return entries


def _ensure_snapshot_member(
    root: Path, path: Path, owners: dict[Path, Path], cache: dict[Path, set[bytes]]
) -> None:
    """Require a file/link or nested repository to be covered by the snapshot."""
    owner = _snapshot_owner(root, path, owners)
    if owner != root:
        # A nested repository can itself be ignored by its containing worktree.
        _ensure_snapshot_member(root, owner, owners, cache)
    relative = path.relative_to(owner).as_posix()
    raw = os.fsencode(relative)
    entries = _snapshot_entries(owner, cache)
    if raw not in entries and raw + b"/" not in entries:
        raise RepositoryError(
            "File evidence must be tracked or non-ignored so its contents are covered by the snapshot; "
            "use command evidence with recorded output for ignored files"
        )


def _ensure_evidence_snapshotted(
    root: Path, value: str, owners: dict[Path, Path], cache: dict[Path, set[bytes]]
) -> Path:
    # Cover every symlink in the reference as well as the final file. Otherwise
    # an ignored link could redirect a citation without changing the snapshot.
    pending = deque(PurePosixPath(value).parts)
    current = root
    links_followed = 0
    try:
        while pending:
            part = pending.popleft()
            if part == ".":
                continue
            if part == "..":
                current = current.parent
            else:
                current = current / part
            if not _inside(root, current) or ".git" in current.relative_to(root).parts:
                raise RepositoryError("Evidence symlink traverses outside the working tree")
            if not current.is_symlink():
                continue
            _ensure_snapshot_member(root, current, owners, cache)
            links_followed += 1
            if links_followed > 40:
                raise RepositoryError("Evidence symlink cannot be safely resolved")
            target = Path(os.readlink(current))
            current = current.parent
            if target.is_absolute():
                if not _inside(root, target):
                    raise RepositoryError("Evidence symlink traverses outside the working tree")
                current = root
                target = target.relative_to(root)
            pending.extendleft(reversed(target.parts))
    except OSError as exc:
        raise RepositoryError("Unable to inspect file evidence safely") from exc
    _ensure_snapshot_member(root, current, owners, cache)
    return current


def _validate_line(path: Path, requested_line: int) -> None:
    """Check a citation's line without decoding or exposing file contents."""
    lines = 0
    last_byte = b""
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise RepositoryError("File evidence changed during validation")
            while chunk := stream.read(1024 * 1024):
                # Universal newlines, including a CRLF split across chunks.
                lines += chunk.count(b"\n") + chunk.count(b"\r") - chunk.count(b"\r\n")
                if last_byte == b'\r' and chunk.startswith(b'\n'):
                    lines -= 1
                if lines >= requested_line:
                    return
                last_byte = chunk[-1:]
    except OSError as exc:
        raise RepositoryError("Unable to validate file evidence line") from exc
    if last_byte and last_byte not in {b"\n", b"\r"}:
        lines += 1
    if requested_line > lines:
        raise RepositoryError("File evidence line does not exist")


def _root_alias_relative(destination: Path, root: Path) -> Path | None:
    """Allow an alias of a root ancestor, never an alias pointing into the root."""
    real = root.resolve(strict=False)
    for split in range(1, len(real.parts)):
        head, tail = real.parts[:split], real.parts[split:]
        for start in range(1, len(destination.parts) - len(tail) + 1):
            if destination.parts[start:start + len(tail)] != tail:
                continue
            if Path(*destination.parts[:start]).resolve(strict=False) == Path(*head):
                return Path(*destination.parts[start + len(tail):])
    return None


def command_cwd(root: Path, value: object, *, check_paths: bool = True) -> str:
    """Normalize an absolute in-target cwd; preserve outside absolute spellings.

    Outside directories are not part of the snapshot and may no longer exist.
    Do not resolve symlinks below the root: the runner contract checks them.
    """
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or re.match(r"^[A-Za-z]:", value):
        raise RepositoryError("cwd must be a nonempty target-relative or absolute directory; record the shell's actual directory")
    path = Path(value)
    if path.is_absolute():
        try:
            relative = path.relative_to(root)
        except ValueError:
            relative = _root_alias_relative(path, root)
        if relative is None:
            return value
        value = relative.as_posix()
    _relative_parts(value, allow_dot=True)
    if check_paths:
        _evidence_path(root, value, directory=True)
    return value


def validate_evidence(root: str | os.PathLike[str], evidence: object, *, labels: list[str] | None = None) -> None:
    """Validate all fields/records without executing commands; collect diagnostics."""
    repository_root = _root(root)
    owners: dict[Path, Path] = {repository_root: repository_root}
    cache: dict[Path, set[bytes]] = {}
    problems = Problems()
    items = evidence if isinstance(evidence, list) else [evidence]
    for index, item in enumerate(items):
        label = labels[index] if labels is not None else f"evidence[{index}]"
        if not isinstance(item, Mapping):
            problems.add(f"{label}: must be an object; supply a file or command record")
            continue
        if item.get("kind") == "file":
            path = None
            try:
                path = _evidence_path(repository_root, item.get("path"))
                if _ensure_evidence_snapshotted(repository_root, item["path"], owners, cache) != path:
                    raise RepositoryError("File evidence changed during validation")
            except (ValueError, OSError) as exc:
                path = None
                problems.add(f"{label}.path: {exc}; cite an existing snapshotted repository file")
            if not _nonempty(item.get("note")):
                problems.add(f"{label}.note: must be nonempty; describe what the file proves")
            if "line" in item:
                if type(item["line"]) is not int or item["line"] < 1:
                    problems.add(f"{label}.line: must be a positive integer; cite an existing line")
                elif path is not None:
                    try:
                        _validate_line(path, item["line"])
                    except RepositoryError as exc:
                        problems.add(f"{label}.line: {exc}; cite an existing line")
        elif item.get("kind") == "command":
            if not _nonempty(item.get("command")):
                problems.add(f"{label}.command: must be nonempty; record the actual command")
            try:
                normalized = command_cwd(repository_root, item.get("cwd"))
                if isinstance(item, dict):
                    item["cwd"] = normalized
            except (ValueError, OSError) as exc:
                problems.add(f"{label}.cwd: {exc}; record a target-relative or absolute shell directory")
            if type(item.get("exitCode")) is not int:
                problems.add(f"{label}.exitCode: must be an integer; record the actual exit code")
            if not isinstance(item.get("output"), str):
                problems.add(f"{label}.output: must be a string; record actual output, including an empty string when silent")
        else:
            problems.add(f"{label}.kind: must be 'file' or 'command'; choose the actual evidence type")
    problems.raise_if_any(RepositoryError)


def ensure_external_output(
    root: str | os.PathLike[str], path: str | os.PathLike[str]
) -> Path:
    """Resolve an output location and reject writes anywhere inside the target."""
    repository_root = _root(root)
    try:
        destination = Path(path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError) as exc:
        raise RepositoryError("Output path cannot be resolved") from exc
    if _inside(repository_root, destination):
        raise RepositoryError("Output must be outside the repository being evaluated")
    return destination


def _frame(digest, tag: bytes, content: bytes) -> None:
    digest.update(tag)
    digest.update(len(content).to_bytes(8, "big"))
    digest.update(content)


def _status(root: Path) -> bytes:
    return _git(
        root,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        disable_filters=True,
    )


def _head(root: Path) -> str | None:
    output = _git(root, "rev-parse", "--verify", "HEAD", optional=True)
    return output.decode("ascii").strip() if output else None


def _snapshot(root: Path, head: str | None, status_before: bytes) -> str:
    digest = hashlib.sha256()
    _frame(digest, b"version", b"agent-readiness-working-tree-v1")
    _frame(digest, b"head", (head or "").encode("ascii"))
    _frame(digest, b"status", status_before)
    listed = _git(
        root,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        disable_filters=True,
    )
    for raw in sorted(set(listed.split(b"\x00")) - {b""}):
        relative = os.fsdecode(raw)
        # Git paths are POSIX-relative, but a backslash is a legal filename on
        # POSIX and must not be interpreted as a separator during snapshots.
        parts = PurePosixPath(relative).parts
        if PurePosixPath(relative).is_absolute() or ".." in parts or ".git" in parts:
            raise RepositoryError("Git returned an unsafe working-tree path")
        path = root.joinpath(*parts)
        try:
            parent = path.parent.resolve()
            if not _inside(root, parent):
                raise RepositoryError("A tracked path escapes the repository through a symlink")
            info = path.lstat()
        except FileNotFoundError:
            _frame(digest, b"path", raw)
            _frame(digest, b"kind", b"missing")
            continue
        except OSError as exc:
            raise RepositoryError("Unable to inspect a repository file") from exc
        _frame(digest, b"path", raw)
        if stat.S_ISLNK(info.st_mode):
            _frame(digest, b"kind", b"symlink")
            _frame(digest, b"target", os.fsencode(os.readlink(path)))
        elif stat.S_ISREG(info.st_mode):
            _frame(digest, b"kind", b"regular")
            _frame(digest, b"executable", b"yes" if info.st_mode & 0o111 else b"no")
            content_hash = hashlib.sha256()
            try:
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(descriptor, "rb") as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode):
                        raise RepositoryError("Repository file changed during inspection")
                    while chunk := stream.read(1024 * 1024):
                        content_hash.update(chunk)
                    finished = os.fstat(stream.fileno())
                current = path.lstat()
            except OSError as exc:
                raise RepositoryError("Unable to read a repository file safely") from exc
            signature = lambda entry: (entry.st_dev, entry.st_ino, entry.st_size, entry.st_mtime_ns, entry.st_ctime_ns)
            if not signature(info) == signature(opened) == signature(finished) == signature(current):
                raise RepositoryError("Repository file changed during inspection; retry the snapshot")
            _frame(digest, b"content-sha256", content_hash.digest())
        elif stat.S_ISDIR(info.st_mode):
            # git ls-files emits directory entries for gitlinks. Include checked
            # out submodules, including their working files and local changes.
            _frame(digest, b"kind", b"directory")
            nested = _git(path, "rev-parse", "--show-toplevel", optional=True)
            if nested and Path(os.fsdecode(nested.removesuffix(b"\n"))).resolve() == path.resolve():
                nested_head = _head(path)
                _frame(digest, b"submodule", _snapshot(path, nested_head, _status(path)).encode("ascii"))
        else:
            # Never open devices, FIFOs or sockets.
            _frame(digest, b"kind", f"special:{stat.S_IFMT(info.st_mode)}".encode("ascii"))
    if _status(root) != status_before or _head(root) != head:
        raise RepositoryError("Repository changed during inspection; retry the snapshot")
    return digest.hexdigest()


def inspect_repository(path: str | os.PathLike[str]) -> dict:
    """Describe a Git worktree and fingerprint its current on-disk contents."""
    root = _root(path)
    head = _head(root)
    branch_bytes = _git(root, "symbolic-ref", "--quiet", "--short", "HEAD", optional=True)
    branch = os.fsdecode(branch_bytes.rstrip(b"\n")) if branch_bytes else None
    remote = _git(root, "config", "--get", "remote.origin.url", optional=True)
    if not remote:
        remotes = _git(root, "remote").decode("utf-8", "surrogateescape").splitlines()
        if remotes:
            remote = _git(root, "config", "--get", f"remote.{sorted(remotes)[0]}.url", optional=True)
    origin = canonicalize_origin(os.fsdecode(remote).strip(), root) if remote else None
    status = _status(root)
    return {
        "root": str(root),
        "head": head,
        "branch": branch,
        "origin": origin,
        "identity": _repository_identity(origin, root),
        "dirty": bool(status),
        "fingerprint": _snapshot(root, head, status),
    }
