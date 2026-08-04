#!/usr/bin/python3 -I
"""Narrow host lifecycle for the isolated Submarine Dash Redis."""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import plistlib
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path

PORT = 6691
PRESERVED_PORTS = (6379, 6688, 6690, 8079)
APP = Path("/Library/Application Support/SubmarineDash")
REDIS_ROOT = Path("/Library/Application Support/SubmarineDashRedis")
LOG_ROOT = Path("/Library/Logs/SubmarineDashRedis")
REGISTRY_ROOT = Path("/Library/Application Support/RedisGateway")
REGISTRY_HELPER = Path("/usr/local/libexec/torrence-route-registry")
REGISTRY_BASE = Path("/usr/local/libexec/torrence-route-registry.pre-submarine")
HOST_LOCK = Path("/var/run/redis-gateway/host-mutation.lock")
TORRENCE_REGISTRY_SHA256 = "966ff65f26a06d6ef5844c1d576fc21d7e8535d7d22e283dda662f0ed8427d52"
APPROVED_BUNDLES = REGISTRY_ROOT / "submarine-approved-installers"
INSTALL_TRANSACTION = REGISTRY_ROOT / "submarine-install-transaction.json"
SERVICE_LABELS = (
    "com.roadcrosser.submarine-redis",
    "com.roadcrosser.submarine-redis-backup",
    "com.roadcrosser.submarine-redis-doctor",
)
EXPECTED_ROUTES = frozenset({"torrence", "x-to-notion", "submarine-dash"})
PUBLIC_INGRESS = APP / "public-ingress.json"
IMMUTABLE_REDIS_SERVER = Path("/usr/local/lib/submarine-redis/current/bin/redis-server")
HOMEBREW_REDIS_SERVER = Path("/opt/homebrew/bin/redis-server")
REDIS_CLI = Path("/opt/homebrew/bin/redis-cli")
PRODUCTION_MANAGED_FILES = (
    REGISTRY_HELPER, REGISTRY_BASE,
    REGISTRY_ROOT / "routes.d/submarine-dash.json",
    REGISTRY_ROOT / "tokens.candidate.json", REGISTRY_ROOT / "tokens.active.json",
    REGISTRY_ROOT / "tokens.last-known-good.json",
    APP / "credentials.env", APP / "srh-token",
    REDIS_ROOT / "redis.conf", REDIS_ROOT / "users.acl",
    Path("/usr/local/libexec/submarine-start-redis-guarded"),
    Path("/usr/local/bin/submarine-redis-host"),
    Path("/Library/LaunchDaemons/com.roadcrosser.submarine-redis.plist"),
    Path("/Library/LaunchDaemons/com.roadcrosser.submarine-redis-backup.plist"),
    Path("/Library/LaunchDaemons/com.roadcrosser.submarine-redis-doctor.plist"),
)
REGISTRY_MANAGED_FILES = PRODUCTION_MANAGED_FILES[:6]
PRODUCTION_MANAGED_DIRECTORIES = (
    APP / "backups/generations", APP / "backups", APP,
    REDIS_ROOT / "data", REDIS_ROOT / "log", REDIS_ROOT, LOG_ROOT,
    Path("/usr/local/lib/submarine-redis"),
)


class HostError(RuntimeError):
    pass


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, payload: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        write_all(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        fsync_dir(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def write_all(descriptor: int, payload: bytes) -> None:
    written = 0
    while written < len(payload):
        count = os.write(descriptor, payload[written:])
        if count <= 0:
            raise HostError("durable file write made no progress")
        written += count


def require_regular(path: Path, mode: int | None = None) -> None:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or metadata.st_nlink != 1:
        raise HostError(f"unsafe regular file: {path}")
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        raise HostError(f"unsafe file mode: {path}")


def ensure_directory(path: Path, mode: int) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, mode=mode)
        metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise HostError(f"unsafe managed directory: {path}")
    os.chmod(path, mode)


def directory_snapshot(path: Path) -> dict[str, int] | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise HostError(f"unsafe managed directory: {path}")
    return {"mode": stat.S_IMODE(metadata.st_mode), "uid": metadata.st_uid, "gid": metadata.st_gid}


def restore_directory(path: Path, snapshot: dict[str, int] | None) -> None:
    if snapshot is None:
        if path.is_symlink():
            raise HostError(f"managed directory became a symlink during rollback: {path}")
        if path.exists():
            shutil.rmtree(path)
        return
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise HostError(f"managed directory diverged during rollback: {path}")
    os.chmod(path, int(snapshot["mode"]))
    os.chown(path, int(snapshot["uid"]), int(snapshot["gid"]))


def listener_identity(port: int) -> str | None:
    probe = subprocess.run(
        ["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpct"],
        check=False, capture_output=True, text=True,
    )
    lines = sorted(line for line in probe.stdout.splitlines() if line[:1] in {"p", "c", "t"})
    return "\n".join(lines) or None


def listener_snapshot() -> dict[int, str | None]:
    return {port: listener_identity(port) for port in PRESERVED_PORTS}


def assert_listener_snapshot(before: dict[int, str | None]) -> None:
    after = listener_snapshot()
    if before != after:
        raise HostError("an unrelated listener changed during Submarine installation")


@contextmanager
def host_lock(path: Path = HOST_LOCK):
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    created = False
    try:
        descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        expected_uid, expected_gid = os.geteuid(), os.getegid()
        if created:
            os.fchown(descriptor, expected_uid, expected_gid)
            os.fchmod(descriptor, 0o600)
            metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size != 0
                or metadata.st_uid != expected_uid or metadata.st_gid != expected_gid
                or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise HostError("shared host lock is unsafe")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


@contextmanager
def registry_mutation_lock(root: Path = Path("/")):
    registry = root / REGISTRY_ROOT.relative_to("/")
    registry.mkdir(mode=0o750, parents=True, exist_ok=True)
    lock = registry / ".mutation.lockfile"
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid()):
            raise HostError("canonical registry mutation lock is unsafe")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def source_root() -> Path:
    return Path(__file__).resolve().parent


def render_credentials(passwords: dict[str, str]) -> bytes:
    return "".join(f"SUBMARINE_REDIS_{name}_PASSWORD={passwords[name]}\n" for name in sorted(passwords)).encode()


def parse_credentials(path: Path) -> dict[str, str]:
    require_regular(path, 0o600)
    values = dict(line.split("=", 1) for line in path.read_text().splitlines())
    expected = {f"SUBMARINE_REDIS_{name}_PASSWORD" for name in ("APP", "BACKUP", "SRH")}
    if set(values) != expected or any(len(value) != 64 for value in values.values()):
        raise HostError("existing Submarine credentials are malformed")
    return {name: values[f"SUBMARINE_REDIS_{name}_PASSWORD"] for name in ("APP", "BACKUP", "SRH")}


def create_acl(passwords: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
    passwords = passwords or {name: secrets.token_hex(32) for name in ("APP", "BACKUP", "SRH")}
    hashes = {name: hashlib.sha256(value.encode()).hexdigest() for name, value in passwords.items()}
    acl = "\n".join((
        "user default off",
        f"user submarine_app on #{hashes['APP']} resetkeys resetchannels -@all +@read +@write +eval +time +ping +select -flushall -flushdb -config -acl -shutdown ~sd:* ~submarine-dash:*",
        f"user submarine_backup on #{hashes['BACKUP']} resetkeys resetchannels -@all +ping +info +lastsave +bgsave",
        f"user submarine_srh on #{hashes['SRH']} resetkeys resetchannels -@all +@read +@write +eval +time +ping +select -flushall -flushdb -config -acl -shutdown ~sd:* ~submarine-dash:*",
        "",
    )).encode()
    return acl, passwords


def write_layout(root: Path, files: Path, service_uid: int | None = None, service_gid: int | None = None) -> None:
    app = root / APP.relative_to("/")
    redis = root / REDIS_ROOT.relative_to("/")
    logs = root / LOG_ROOT.relative_to("/")
    for path, mode in ((app, 0o700), (app / "backups", 0o700),
                       (app / "backups/generations", 0o700),
                       (redis, 0o750), (redis / "data", 0o750),
                       (redis / "log", 0o750), (logs, 0o700)):
        ensure_directory(path, mode)
    credential_path = app / "credentials.env"
    existing = parse_credentials(credential_path) if credential_path.exists() else None
    acl, passwords = create_acl(existing)
    atomic_write(redis / "users.acl", acl, 0o640)
    atomic_write(redis / "redis.conf", (files / "redis-submarine.conf").read_bytes(), 0o640)
    if existing is None:
        atomic_write(credential_path, render_credentials(passwords), 0o600)
    destinations = {
        "start-redis-guarded.sh": root / "usr/local/libexec/submarine-start-redis-guarded",
        "submarine_redis_host.py": root / "usr/local/bin/submarine-redis-host",
        "com.roadcrosser.submarine-redis.plist": root / "Library/LaunchDaemons/com.roadcrosser.submarine-redis.plist",
        "com.roadcrosser.submarine-redis-backup.plist": root / "Library/LaunchDaemons/com.roadcrosser.submarine-redis-backup.plist",
        "com.roadcrosser.submarine-redis-doctor.plist": root / "Library/LaunchDaemons/com.roadcrosser.submarine-redis-doctor.plist",
    }
    for name, destination in destinations.items():
        atomic_write(destination, (files / name).read_bytes(), 0o755 if destination.parts[-2] in {"bin", "libexec"} else 0o644)
    if service_uid is not None and service_gid is not None:
        for path in (redis / "data", redis / "log"):
            os.chown(path, service_uid, service_gid)
        for path in (redis, redis / "redis.conf", redis / "users.acl"):
            os.chown(path, 0, service_gid)


def install_registry_compat(root: Path, files: Path) -> None:
    helper = root / REGISTRY_HELPER.relative_to("/")
    base = root / REGISTRY_BASE.relative_to("/")
    if not base.exists():
        require_regular(helper)
        if digest(helper) != TORRENCE_REGISTRY_SHA256:
            raise HostError("installed Torrence registry helper does not match reviewed source")
        atomic_write(base, helper.read_bytes(), 0o755)
    elif digest(base) != TORRENCE_REGISTRY_SHA256:
        raise HostError("preserved Torrence registry helper digest is stale")
    atomic_write(helper, registry_compat_payload(root, files), 0o755)


def registry_compat_payload(root: Path, files: Path) -> bytes:
    wrapper = (files / "route-registry-compat.py").read_text()
    if root != Path("/"):
        wrapper = wrapper.replace(str(REGISTRY_BASE), str(root / REGISTRY_BASE.relative_to("/")))
    return wrapper.encode()


def install_test(root: Path, fail_at: str | None = None) -> None:
    files = source_root()
    transaction = root / "var/run/submarine-install-transaction"
    snapshot = root / "var/run/submarine-install-snapshot"
    with registry_mutation_lock(root):
        _install_test_locked(root, fail_at, transaction, snapshot)


def _install_test_locked(root: Path, fail_at: str | None, transaction: Path, snapshot: Path) -> None:
    files = source_root()
    if transaction.exists():
        raise HostError("incomplete install transaction requires recovery")
    transaction.parent.mkdir(parents=True, exist_ok=True)
    managed = (
        REDIS_ROOT / "redis.conf", REDIS_ROOT / "users.acl",
        APP / "credentials.env", APP / "srh-token",
        REGISTRY_HELPER, REGISTRY_BASE,
        Path("/usr/local/libexec/submarine-start-redis-guarded"),
        Path("/usr/local/bin/submarine-redis-host"),
        Path("/Library/LaunchDaemons/com.roadcrosser.submarine-redis.plist"),
        Path("/Library/LaunchDaemons/com.roadcrosser.submarine-redis-backup.plist"),
        Path("/Library/LaunchDaemons/com.roadcrosser.submarine-redis-doctor.plist"),
    )
    before = {}
    for relative in managed:
        path = root / relative.relative_to("/")
        before[str(relative)] = path.read_bytes().hex() if path.is_file() else None
    atomic_write(transaction, json.dumps(before, sort_keys=True).encode(), 0o600)
    atomic_write(snapshot, json.dumps(before, sort_keys=True).encode(), 0o600)
    try:
        install_registry_compat(root, files)
        if fail_at == "after-registry":
            raise HostError("injected install failure")
        write_layout(root, files)
        if fail_at == "after-layout":
            raise HostError("injected install failure")
        transaction.unlink()
    except BaseException:
        for relative_text, payload in before.items():
            path = root / Path(relative_text).relative_to("/")
            if payload is not None:
                atomic_write(path, bytes.fromhex(payload), 0o755 if path in {root / REGISTRY_HELPER.relative_to('/'), root / REGISTRY_BASE.relative_to('/')} else 0o600)
            elif path.is_file() or path.is_symlink():
                path.unlink()
        transaction.unlink(missing_ok=True)
        raise


def ensure_service_identity() -> bool:
    user = subprocess.run(["/usr/bin/dscl", ".", "-read", "/Users/_submarine", "UniqueID"], check=False, capture_output=True, text=True)
    group = subprocess.run(["/usr/bin/dscl", ".", "-read", "/Groups/_submarine", "PrimaryGroupID"], check=False, capture_output=True, text=True)
    if user.returncode == 0 or group.returncode == 0:
        if user.returncode != 0 or group.returncode != 0:
            raise HostError("_submarine user/group identity is incomplete")
        validate_service_identity()
        return False
    user_ids = subprocess.run(["/usr/bin/dscl", ".", "-list", "/Users", "UniqueID"], check=True, capture_output=True, text=True)
    group_ids = subprocess.run(["/usr/bin/dscl", ".", "-list", "/Groups", "PrimaryGroupID"], check=True, capture_output=True, text=True)
    used = {int(line.rsplit(None, 1)[1]) for text in (user_ids.stdout, group_ids.stdout) for line in text.splitlines() if line.rsplit(None, 1)[-1].isdigit()}
    uid = next(candidate for candidate in range(390, 500) if candidate not in used)
    subprocess.run(["/usr/bin/dscl", ".", "-create", "/Groups/_submarine"], check=True)
    subprocess.run(["/usr/bin/dscl", ".", "-create", "/Groups/_submarine", "PrimaryGroupID", str(uid)], check=True)
    for record, value in (("UniqueID", str(uid)), ("PrimaryGroupID", str(uid)),
                          ("UserShell", "/usr/bin/false"), ("NFSHomeDirectory", "/var/empty"),
                          ("RealName", "Submarine Dash Redis")):
        subprocess.run(["/usr/bin/dscl", ".", "-create", "/Users/_submarine", record, value], check=True)
    validate_service_identity()
    return True


def record_value(record: dict[str, object], attribute: str) -> str:
    matches = [value for key, value in record.items() if key.rsplit(":", 1)[-1] == attribute]
    if len(matches) != 1:
        raise HostError(f"service identity attribute diverged: {attribute}")
    values = matches[0] if isinstance(matches[0], list) else [matches[0]]
    if len(values) != 1 or not isinstance(values[0], str):
        raise HostError(f"service identity attribute diverged: {attribute}")
    return values[0]


def validate_identity_records(
    user: dict[str, object], group: dict[str, object], user_listing: str, group_listing: str,
) -> None:
    uid = record_value(user, "UniqueID")
    gid = record_value(group, "PrimaryGroupID")
    expected = {
        "RecordName": "_submarine", "PrimaryGroupID": gid,
        "UserShell": "/usr/bin/false", "NFSHomeDirectory": "/var/empty",
    }
    if uid != gid or any(record_value(user, name) != value for name, value in expected.items()):
        raise HostError("_submarine service identity attributes diverge")
    if record_value(group, "RecordName") != "_submarine":
        raise HostError("_submarine group identity diverges")
    users = [line.rsplit(None, 1) for line in user_listing.splitlines() if len(line.rsplit(None, 1)) == 2]
    groups = [line.rsplit(None, 1) for line in group_listing.splitlines() if len(line.rsplit(None, 1)) == 2]
    if [name for name, value in users if value == uid] != ["_submarine"]:
        raise HostError("_submarine UID is not unique")
    if [name for name, value in groups if value == gid] != ["_submarine"]:
        raise HostError("_submarine GID is not unique")


def validate_service_identity() -> None:
    user = capture_dscl_record("/Users/_submarine")
    group = capture_dscl_record("/Groups/_submarine")
    if user is None or group is None:
        raise HostError("_submarine user/group identity is incomplete")
    user_listing = subprocess.run(
        ["/usr/bin/dscl", ".", "-list", "/Users", "UniqueID"],
        check=True, capture_output=True, text=True,
    ).stdout
    group_listing = subprocess.run(
        ["/usr/bin/dscl", ".", "-list", "/Groups", "PrimaryGroupID"],
        check=True, capture_output=True, text=True,
    ).stdout
    validate_identity_records(user, group, user_listing, group_listing)


def capture_dscl_record(record: str) -> dict[str, object] | None:
    completed = subprocess.run(
        ["/usr/bin/dscl", ".", "-read", record, "-plist"],
        check=False, capture_output=True,
    )
    if completed.returncode != 0:
        return None
    try:
        parsed = plistlib.loads(completed.stdout)
    except plistlib.InvalidFileException as error:
        raise HostError(f"service identity record is malformed: {record}") from error
    if not isinstance(parsed, dict):
        raise HostError(f"service identity record is malformed: {record}")
    return parsed


def restore_dscl_record(record: str, snapshot: dict[str, object] | None) -> None:
    subprocess.run(["/usr/bin/dscl", ".", "-delete", record], check=False)
    if snapshot is None:
        return
    subprocess.run(["/usr/bin/dscl", ".", "-create", record], check=True)
    for raw_attribute, raw_values in sorted(snapshot.items()):
        attribute = raw_attribute.rsplit(":", 1)[-1]
        values = raw_values if isinstance(raw_values, list) else [raw_values]
        if not values or any(not isinstance(value, str) for value in values):
            raise HostError(f"service identity attribute is malformed: {attribute}")
        subprocess.run(
            ["/usr/bin/dscl", ".", "-create", record, attribute, values[0]], check=True,
        )
        for value in values[1:]:
            subprocess.run(
                ["/usr/bin/dscl", ".", "-append", record, attribute, value], check=True,
            )


def launchd_state(label: str) -> dict[str, bool]:
    completed = subprocess.run(
        ["/bin/launchctl", "print", f"system/{label}"],
        check=False, capture_output=True, text=True,
    )
    return {
        "loaded": completed.returncode == 0,
        "running": completed.returncode == 0 and "state = running" in completed.stdout,
    }


def wait_for_port_closed(port: int, attempts: int = 40) -> None:
    for _ in range(attempts):
        if listener_identity(port) is None:
            return
        time.sleep(0.25)
    raise HostError(f"Redis listener did not close on {port}")


def quiesce_submarine_services() -> None:
    for label in reversed(SERVICE_LABELS):
        completed = subprocess.run(
            ["/bin/launchctl", "bootout", f"system/{label}"], check=False,
        )
        if completed.returncode != 0 and launchd_state(label)["loaded"]:
            raise HostError(f"Submarine LaunchDaemon bootout failed: {label}")
    wait_for_port_closed(PORT)


def wait_for_maintenance_idle(attempts: int = 40) -> None:
    for _ in range(attempts):
        if all(not launchd_state(label)["running"] for label in SERVICE_LABELS[1:]):
            return
        time.sleep(0.25)
    raise HostError("Submarine maintenance jobs did not become idle")


def restore_launchd_state(snapshot: dict[str, dict[str, bool]]) -> None:
    for label in SERVICE_LABELS:
        expected = snapshot[label]
        if expected["loaded"]:
            plist = f"/Library/LaunchDaemons/{label}.plist"
            if subprocess.run(
                ["/bin/launchctl", "bootstrap", "system", plist], check=False,
            ).returncode != 0:
                raise HostError(f"prior LaunchDaemon state could not be restored: {label}")
    for label in SERVICE_LABELS:
        expected = snapshot[label]
        for _ in range(40):
            actual = launchd_state(label)
            durable_match = actual["loaded"] == expected["loaded"]
            runtime_match = label != SERVICE_LABELS[0] or actual["running"] == expected["running"]
            if durable_match and runtime_match:
                break
            time.sleep(0.25)
        else:
            raise HostError(f"prior LaunchDaemon runtime state diverged: {label}")
    if snapshot[SERVICE_LABELS[0]]["running"]:
        wait_for_port(PORT)
    else:
        wait_for_port_closed(PORT)


def service_ids() -> tuple[int, int]:
    import grp
    import pwd
    return pwd.getpwnam("_submarine").pw_uid, grp.getgrnam("_submarine").gr_gid


def prepare_runtime(bundle: Path) -> None:
    completed = subprocess.run(
        [str(bundle / "prepare-pinned-runtime.py")],
        check=False, stdin=subprocess.DEVNULL, capture_output=True,
        env={"HOME": "/var/empty", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
    )
    if completed.returncode != 0:
        raise HostError("Submarine immutable Redis runtime preparation failed")
    runtime = Path("/usr/local/lib/submarine-redis/current").resolve(strict=True)
    if len(runtime.name) != 64 or any(character not in "0123456789abcdef" for character in runtime.name):
        raise HostError("Submarine Redis runtime is not content-addressed")
    for parent in (runtime, runtime / "bin", runtime / "lib"):
        if stat.S_IMODE(parent.stat().st_mode) & 0o111 == 0:
            raise HostError("Submarine Redis runtime is not service-traversable")


def wait_for_port(port: int, attempts: int = 40) -> None:
    for _ in range(attempts):
        with socket.socket() as probe:
            probe.settimeout(0.1)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.25)
    raise HostError(f"Redis listener did not become ready on {port}")


def load_registry_helper():
    loader = importlib.machinery.SourceFileLoader("submarine_registry_helper", str(REGISTRY_HELPER))
    specification = importlib.util.spec_from_loader(loader.name, loader)
    if specification is None:
        raise HostError("shared route registry helper could not be loaded")
    module = importlib.util.module_from_spec(specification)
    loader.exec_module(module)
    return module


def route_fragment() -> dict[str, object]:
    credentials = parse_credentials(APP / "credentials.env")
    token_path = APP / "srh-token"
    token = token_path.read_text().strip() if token_path.exists() else secrets.token_hex(32)
    if len(token) != 64 or any(character not in "0123456789abcdef" for character in token):
        raise HostError("existing Submarine SRH token is malformed")
    if not token_path.exists():
        atomic_write(token_path, (token + "\n").encode(), 0o600)
    return {
        "token": token,
        "srh_id": "submarine-dash",
        "connection_string": f"redis://submarine_srh:{credentials['SRH']}@127.0.0.1:6691/0",
        "max_connections": 20,
    }


def plan_route_publication() -> tuple[object, dict[str, object], bytes, bytes]:
    helper = load_registry_helper()
    fragment = helper.validate_fragment(
        route_fragment(), allowed_ports=frozenset({6688, 6690, 6691}),
    )
    aggregate = helper.aggregate_fragments(
        REGISTRY_ROOT, allowed_ports=frozenset({6688, 6690, 6691}), owner_uid=0, owner_gid=0,
    )
    aggregate = {token: route for token, route in aggregate.items() if route["srh_id"] != "submarine-dash"}
    aggregate[fragment["token"]] = {
        "srh_id": fragment["srh_id"], "connection_string": fragment["connection_string"],
        "max_connections": fragment["max_connections"],
    }
    return helper, fragment, helper._fragment_payload(fragment), helper._aggregate_payload(aggregate)


def publish_route_locked(plan: tuple[object, dict[str, object], bytes, bytes]) -> None:
    import grp
    helper, fragment, expected_fragment, expected_aggregate = plan
    active_gid = grp.getgrnam("_torrence").gr_gid
    helper.write_fragment(
        REGISTRY_ROOT, "submarine-dash.json", fragment, owner_uid=0, owner_gid=0,
    )
    helper.generate_candidate(
        REGISTRY_ROOT, allowed_ports=frozenset({6688, 6690, 6691}), owner_uid=0, owner_gid=0,
    )
    helper.activate_candidate(
        REGISTRY_ROOT, owner_uid=0, owner_gid=0, active_gid=active_gid,
        verify_command=None, verify_timeout_seconds=10,
    )
    if ((REGISTRY_ROOT / "routes.d/submarine-dash.json").read_bytes() != expected_fragment
            or (REGISTRY_ROOT / "tokens.candidate.json").read_bytes() != expected_aggregate
            or (REGISTRY_ROOT / "tokens.active.json").read_bytes() != expected_aggregate):
        raise HostError("shared registry publication diverged from its write-ahead plan")


def authenticated_redis_ping(connection_string: str) -> None:
    parsed = urllib.parse.urlsplit(connection_string)
    if (parsed.scheme != "redis" or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username is None or parsed.password is None or parsed.port is None
            or parsed.query or parsed.fragment):
        raise HostError("active route connection is outside the authenticated loopback boundary")
    with socket.create_connection((parsed.hostname, parsed.port), timeout=2) as connection:
        def command(*parts: str) -> bytes:
            return f"*{len(parts)}\r\n".encode() + b"".join(
                f"${len(part.encode())}\r\n{part}\r\n".encode() for part in parts
            )
        connection.sendall(command("AUTH", parsed.username, parsed.password) + command("PING"))
        stream = connection.makefile("rb")
        if stream.readline() != b"+OK\r\n" or stream.readline() != b"+PONG\r\n":
            raise HostError("active route failed authenticated Redis health")


def authenticated_srh_ping(token: str, url: str = "http://127.0.0.1:8079/") -> None:
    if len(token) != 64 or any(character not in "0123456789abcdef" for character in token):
        raise HostError("active route token is malformed")
    request = urllib.request.Request(
        url, method="POST", data=b'["PING"]',
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    try:
        response = opener.open(request, timeout=5)
        status, final_url = response.status, response.geturl()
        content_type, body = response.headers.get("Content-Type", ""), response.read(65536)
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise HostError("active route failed authenticated SRH health") from error
    if (status != 200 or final_url != url or "application/json" not in content_type.lower()):
        raise HostError("active route failed authenticated SRH health")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise HostError("active route returned malformed SRH health") from error
    if payload != {"result": "PONG"}:
        raise HostError("active route failed authenticated SRH health")


def verify_active_routes(
    expected_routes: frozenset[str], active: Path | None = None,
    backend_ping=authenticated_redis_ping, srh_ping=authenticated_srh_ping,
) -> None:
    active = active or REGISTRY_ROOT / "tokens.active.json"
    require_regular(active, 0o640)
    try:
        payload = json.loads(active.read_text())
    except json.JSONDecodeError as error:
        raise HostError("active SRH route registry is malformed") from error
    if not isinstance(payload, dict):
        raise HostError("active SRH route registry is malformed")
    routes = list(payload.values())
    if ({route.get("srh_id") for route in routes if isinstance(route, dict)} != expected_routes
            or len(routes) != len(expected_routes)):
        raise HostError("active SRH route set diverged")
    for token, route in payload.items():
        if set(route) < {"srh_id", "connection_string"}:
            raise HostError("active SRH route is malformed")
        backend_ping(str(route["connection_string"]))
        srh_ping(str(token))


def existing_route_set() -> frozenset[str]:
    active = REGISTRY_ROOT / "tokens.active.json"
    require_regular(active, 0o640)
    try:
        payload = json.loads(active.read_text())
    except json.JSONDecodeError as error:
        raise HostError("active SRH route registry is malformed") from error
    if not isinstance(payload, dict) or any(not isinstance(route, dict) for route in payload.values()):
        raise HostError("active SRH route registry is malformed")
    routes = frozenset(route.get("srh_id") for route in payload.values())
    if routes not in {frozenset({"torrence", "x-to-notion"}), EXPECTED_ROUTES} or len(payload) != len(routes):
        raise HostError("pre-install SRH route set diverged")
    return routes


def capture_install_transaction() -> dict[str, object]:
    maintenance = {label: launchd_state(label) for label in SERVICE_LABELS[1:]}
    if any(state["running"] for state in maintenance.values()):
        raise HostError("Submarine maintenance job started during transaction preflight")
    files: dict[str, object] = {}
    for path in PRODUCTION_MANAGED_FILES:
        if path.exists() and not path.is_symlink():
            require_regular(path)
            files[str(path)] = {
                "mode": stat.S_IMODE(path.stat().st_mode),
                "uid": path.stat().st_uid,
                "gid": path.stat().st_gid,
                "payload": base64.b64encode(path.read_bytes()).decode("ascii"),
            }
        else:
            files[str(path)] = None
    pointer = Path("/usr/local/lib/submarine-redis/current")
    runtime_root = pointer.parent
    directories = {str(path): directory_snapshot(path) for path in PRODUCTION_MANAGED_DIRECTORIES}
    return {
        "schemaVersion": 3,
        "files": files,
        "directories": directories,
        "registryAllowedDigests": {
            str(path): [digest(path) if path.is_file() and not path.is_symlink() else None]
            for path in REGISTRY_MANAGED_FILES
        },
        "runtimeEntries": sorted(path.name for path in runtime_root.iterdir()) if runtime_root.is_dir() else [],
        "runtimeTarget": os.readlink(pointer) if pointer.is_symlink() else None,
        "identity": {
            "user": capture_dscl_record("/Users/_submarine"),
            "group": capture_dscl_record("/Groups/_submarine"),
        },
        "launchd": {SERVICE_LABELS[0]: launchd_state(SERVICE_LABELS[0]), **maintenance},
    }


def write_install_transaction(transaction: dict[str, object]) -> None:
    atomic_write(INSTALL_TRANSACTION, json.dumps(transaction, sort_keys=True, separators=(",", ":")).encode(), 0o600)


def authorize_registry_payload(transaction: dict[str, object], path: Path, payload: bytes) -> None:
    expected = hashlib.sha256(payload).hexdigest()
    values = transaction["registryAllowedDigests"][str(path)]
    if expected not in values:
        values.append(expected)


def verify_registry_recovery_cas(transaction: dict[str, object]) -> None:
    allowed = transaction["registryAllowedDigests"]
    for path in REGISTRY_MANAGED_FILES:
        current = digest(path) if path.is_file() and not path.is_symlink() else None
        if current not in allowed[str(path)]:
            raise HostError("shared registry changed after interrupted Submarine install; refusing rollback")


def recover_install_transaction() -> None:
    if not INSTALL_TRANSACTION.exists():
        return
    require_regular(INSTALL_TRANSACTION, 0o600)
    transaction = json.loads(INSTALL_TRANSACTION.read_text())
    if (transaction.get("schemaVersion") != 3
            or set(transaction.get("files", {})) != {str(path) for path in PRODUCTION_MANAGED_FILES}
            or set(transaction.get("launchd", {})) != set(SERVICE_LABELS)
            or set(transaction.get("identity", {})) != {"user", "group"}
            or set(transaction.get("directories", {})) != {str(path) for path in PRODUCTION_MANAGED_DIRECTORIES}
            or set(transaction.get("registryAllowedDigests", {})) != {str(path) for path in REGISTRY_MANAGED_FILES}
            or not isinstance(transaction.get("runtimeEntries"), list)):
        raise HostError("Submarine install transaction is malformed")
    verify_registry_recovery_cas(transaction)
    quiesce_submarine_services()
    for path_text, snapshot in transaction["files"].items():
        path = Path(path_text)
        if snapshot is None:
            if path.is_file() or path.is_symlink():
                path.unlink()
        else:
            atomic_write(path, base64.b64decode(snapshot["payload"], validate=True), int(snapshot["mode"]))
            os.chown(path, int(snapshot["uid"]), int(snapshot["gid"]))
    pointer = Path("/usr/local/lib/submarine-redis/current")
    if pointer.is_symlink() or pointer.exists():
        pointer.unlink()
    if transaction.get("runtimeTarget") is not None:
        pointer.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        pointer.symlink_to(transaction["runtimeTarget"])
    prior_runtime_entries = set(transaction["runtimeEntries"])
    if pointer.parent.is_dir():
        for entry in pointer.parent.iterdir():
            if entry.name not in prior_runtime_entries and entry.name != "current":
                if (len(entry.name) != 64 or any(character not in "0123456789abcdef" for character in entry.name)
                        or entry.is_symlink() or not entry.is_dir()):
                    raise HostError("unexpected runtime entry prevents exact rollback")
                shutil.rmtree(entry)
    for path_text, snapshot in transaction["directories"].items():
        restore_directory(Path(path_text), snapshot)
    restore_dscl_record("/Groups/_submarine", transaction["identity"]["group"])
    restore_dscl_record("/Users/_submarine", transaction["identity"]["user"])
    restore_launchd_state(transaction["launchd"])
    INSTALL_TRANSACTION.unlink()
    fsync_dir(INSTALL_TRANSACTION.parent)


def install_production(bundle: Path) -> None:
    bundle = bundle.resolve()
    approved = APPROVED_BUNDLES.resolve()
    if bundle.parent != approved or len(bundle.name) != 64 or any(character not in "0123456789abcdef" for character in bundle.name):
        raise HostError("installer bundle is outside the approved content-addressed root")
    require_regular(bundle / "submarine_redis_host.py", 0o500)
    if (bundle / "submarine_redis_host.py").resolve() != Path(__file__).resolve():
        raise HostError("production worker must execute from the approved bundle")
    with host_lock(), registry_mutation_lock():
        recover_install_transaction()
        before_routes = existing_route_set()
        verify_active_routes(before_routes)
        unrelated = listener_snapshot()
        wait_for_maintenance_idle()
        transaction = capture_install_transaction()
        write_install_transaction(transaction)
        try:
            if listener_identity(PORT) is not None:
                if not transaction["launchd"][SERVICE_LABELS[0]]["running"]:
                    raise HostError("port 6691 is occupied by an unmanaged listener")
                uid, _ = service_ids()
                _, listener_uid, command = listener_process(PORT)
                prior_runtime = Path("/usr/local/lib/submarine-redis/current").resolve(strict=True)
                prior_executable = prior_runtime / "bin/redis-server"
                if (listener_uid != uid or not command.startswith(str(prior_executable) + " ")
                        or str(REDIS_ROOT / "redis.conf") not in command):
                    raise HostError("port 6691 listener is not the owned Submarine service")
                quiesce_submarine_services()
            ensure_service_identity()
            prepare_runtime(bundle)
            authorize_registry_payload(transaction, REGISTRY_HELPER, registry_compat_payload(Path("/"), bundle))
            if not REGISTRY_BASE.exists():
                authorize_registry_payload(transaction, REGISTRY_BASE, REGISTRY_HELPER.read_bytes())
            write_install_transaction(transaction)
            install_registry_compat(Path("/"), bundle)
            if (REGISTRY_HELPER.read_bytes() != registry_compat_payload(Path("/"), bundle)
                    or digest(REGISTRY_BASE) != TORRENCE_REGISTRY_SHA256):
                raise HostError("shared registry helper diverged from its write-ahead plan")
            verify_registry_recovery_cas(transaction)
            uid, gid = service_ids()
            write_layout(Path("/"), bundle, uid, gid)
            assert_listener_snapshot(unrelated)
            plist = "/Library/LaunchDaemons/com.roadcrosser.submarine-redis.plist"
            launched = subprocess.run(["/bin/launchctl", "bootstrap", "system", plist], check=False)
            if launched.returncode != 0:
                raise HostError("Submarine LaunchDaemon bootstrap failed")
            wait_for_port(PORT)
            publication = plan_route_publication()
            authorize_registry_payload(transaction, REGISTRY_ROOT / "routes.d/submarine-dash.json", publication[2])
            authorize_registry_payload(transaction, REGISTRY_ROOT / "tokens.candidate.json", publication[3])
            authorize_registry_payload(transaction, REGISTRY_ROOT / "tokens.active.json", publication[3])
            write_install_transaction(transaction)
            publish_route_locked(publication)
            verify_registry_recovery_cas(transaction)
            verify_active_routes(EXPECTED_ROUTES)
            assert_listener_snapshot(unrelated)
            for suffix in ("backup", "doctor"):
                service_plist = f"/Library/LaunchDaemons/com.roadcrosser.submarine-redis-{suffix}.plist"
                if subprocess.run(["/bin/launchctl", "bootstrap", "system", service_plist], check=False).returncode != 0:
                    raise HostError(f"Submarine {suffix} LaunchDaemon bootstrap failed")
            INSTALL_TRANSACTION.unlink()
            fsync_dir(INSTALL_TRANSACTION.parent)
        except BaseException:
            recover_install_transaction()
            assert_listener_snapshot(unrelated)
            raise


def backup(root: Path, fail_before_commit: bool = False) -> Path:
    if root == Path("/"):
        credentials = dict(line.split("=", 1) for line in (APP / "credentials.env").read_text().splitlines())
        before = int(redis_command("submarine_backup", credentials["SUBMARINE_REDIS_BACKUP_PASSWORD"], "LASTSAVE"))
        redis_command("submarine_backup", credentials["SUBMARINE_REDIS_BACKUP_PASSWORD"], "BGSAVE")
        for _ in range(120):
            info = str(redis_command("submarine_backup", credentials["SUBMARINE_REDIS_BACKUP_PASSWORD"], "INFO", "persistence"))
            if "rdb_bgsave_in_progress:0" in info and "rdb_last_bgsave_status:ok" in info:
                break
            time.sleep(0.25)
        else:
            raise HostError("Redis BGSAVE did not complete")
        if int(redis_command("submarine_backup", credentials["SUBMARINE_REDIS_BACKUP_PASSWORD"], "LASTSAVE")) < before:
            raise HostError("Redis LASTSAVE regressed")
    data = root / REDIS_ROOT.relative_to("/") / "data/dump.rdb"
    require_regular(data)
    generations = root / APP.relative_to("/") / "backups/generations"
    generations.mkdir(parents=True, exist_ok=True)
    generation = generations / f"daily-{time.time_ns()}"
    staging = generations / f".{generation.name}.staging"
    staging.mkdir(mode=0o700)
    copy = staging / "dump.rdb"
    atomic_write(copy, data.read_bytes(), 0o600)
    checksum = digest(copy)
    atomic_write(staging / "manifest.json", json.dumps({"sha256": checksum, "bytes": copy.stat().st_size}, sort_keys=True).encode(), 0o600)
    os.replace(staging, generation)
    fsync_dir(generations)
    if fail_before_commit:
        raise HostError("injected backup interruption before commit")
    validation = Path(tempfile.mkdtemp(prefix=".restore-validation.", dir=generations))
    validation.rmdir()
    try:
        restore_disposable(generation, validation, allow_uncommitted=True)
    finally:
        for name in ("VERIFIED", "redis.conf", "dump.rdb"):
            (validation / name).unlink(missing_ok=True)
        validation.rmdir()
    atomic_write(generation / "COMMITTED", (checksum + "\n").encode(), 0o600)
    return generation


def verify_generation(generation: Path) -> dict[str, object]:
    require_regular(generation / "COMMITTED", 0o600)
    require_regular(generation / "manifest.json", 0o600)
    require_regular(generation / "dump.rdb", 0o600)
    manifest = json.loads((generation / "manifest.json").read_text())
    if set(manifest) != {"bytes", "sha256"} or manifest["sha256"] != digest(generation / "dump.rdb"):
        raise HostError("backup generation checksum mismatch")
    if (generation / "COMMITTED").read_text() != manifest["sha256"] + "\n":
        raise HostError("backup commit marker mismatch")
    return manifest


def restore_disposable(generation: Path, destination: Path, allow_uncommitted: bool = False) -> None:
    if allow_uncommitted:
        require_regular(generation / "manifest.json", 0o600)
        require_regular(generation / "dump.rdb", 0o600)
        manifest = json.loads((generation / "manifest.json").read_text())
        if manifest.get("sha256") != digest(generation / "dump.rdb"):
            raise HostError("provisional backup checksum mismatch")
    else:
        verify_generation(generation)
    if destination.exists() or destination.is_symlink():
        raise HostError("disposable restore destination already exists")
    destination.mkdir(mode=0o700)
    atomic_write(destination / "dump.rdb", (generation / "dump.rdb").read_bytes(), 0o600)
    if digest(destination / "dump.rdb") != digest(generation / "dump.rdb"):
        raise HostError("disposable restore diverged")
    server = IMMUTABLE_REDIS_SERVER if IMMUTABLE_REDIS_SERVER.exists() else HOMEBREW_REDIS_SERVER
    if server == HOMEBREW_REDIS_SERVER:
        canonical = destination.resolve()
        temporary_roots = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
        if not any(str(canonical).startswith(prefix) for prefix in temporary_roots):
            raise HostError("production disposable restore requires immutable Redis runtime")
    if not server.exists() or not REDIS_CLI.exists():
        raise HostError("reviewed Redis runtime and CLI are required for disposable restore")
    socket_root = Path(tempfile.mkdtemp(prefix="submarine-restore-"))
    os.chmod(socket_root, 0o700)
    redis_socket = socket_root / "redis.sock"
    config = destination / "redis.conf"
    atomic_write(config, (
        f"port 0\nunixsocket \"{redis_socket}\"\nunixsocketperm 700\n"
        f"protected-mode yes\ndir \"{destination}\"\n"
        "dbfilename dump.rdb\nappendonly no\nsave \"\"\ndaemonize no\n"
    ).encode(), 0o600)
    process = subprocess.Popen([str(server), str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_unix_socket(redis_socket, process)
        pong = subprocess.run([str(REDIS_CLI), "-s", str(redis_socket), "PING"], check=False, capture_output=True, text=True)
        if pong.returncode != 0 or pong.stdout.strip() != "PONG":
            raise HostError("disposable Redis did not accept the restored RDB")
    finally:
        terminate_process(process)
        redis_socket.unlink(missing_ok=True)
        socket_root.rmdir()
    atomic_write(destination / "VERIFIED", (digest(destination / "dump.rdb") + "\n").encode(), 0o600)


def wait_for_unix_socket(path: Path, process: subprocess.Popen, attempts: int = 40) -> None:
    for _ in range(attempts):
        if process.poll() is not None:
            raise HostError("disposable Redis exited before its private socket was ready")
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            time.sleep(0.25)
            continue
        if not stat.S_ISSOCK(metadata.st_mode):
            raise HostError("disposable Redis socket path was replaced")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            try:
                probe.connect(str(path))
                return
            except OSError:
                pass
        time.sleep(0.25)
    raise HostError("disposable Redis private socket did not become ready")


def terminate_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise HostError("disposable Redis could not be terminated") from error


def redis_command(user: str, password: str, *parts: str) -> str | int:
    def encode(command: tuple[str, ...]) -> bytes:
        return f"*{len(command)}\r\n".encode() + b"".join(
            f"${len(part.encode())}\r\n{part}\r\n".encode() for part in command
        )
    def read_response(stream):
        prefix = stream.read(1)
        line = stream.readline().removesuffix(b"\r\n")
        if prefix == b"+":
            return line.decode()
        if prefix == b":":
            return int(line)
        if prefix == b"$":
            size = int(line)
            payload = stream.read(size)
            stream.read(2)
            return payload.decode()
        raise HostError("Redis command returned an error")
    with socket.create_connection(("127.0.0.1", PORT), timeout=2) as connection:
        connection.sendall(encode(("AUTH", user, password)) + encode(parts))
        stream = connection.makefile("rb")
        if read_response(stream) != "OK":
            raise HostError("Redis authentication failed")
        return read_response(stream)


def validate_public_auth_response(status: int, content_type: str, body: bytes) -> None:
    if status not in {400, 401, 403} or "application/json" not in content_type.lower():
        raise HostError("public URL did not return the SRH JSON authorization boundary")
    if b"ngrok" in body.lower() or b"<html" in body.lower():
        raise HostError("public URL reached an ngrok landing page")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise HostError("public authorization response is not JSON") from error
    if not isinstance(payload, dict) or not any(key in payload for key in ("error", "message")):
        raise HostError("public authorization JSON has an unexpected shape")
    message = " ".join(str(payload.get(key, "")) for key in ("error", "message")).lower()
    if "authorization" not in message and "unauthorized" not in message:
        raise HostError("public response is not the SRH authorization error")


def parse_redis_config(path: Path) -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition(" ")
        if not separator or not value.strip():
            raise HostError("Submarine Redis configuration is malformed")
        directives.setdefault(key.lower(), []).append(value.strip().strip('"'))
    return directives


def verify_static_controls(config: Path, acl: Path, credentials_path: Path | None = None) -> None:
    directives = parse_redis_config(config)
    expected = {
        "bind": "127.0.0.1", "port": "6691", "protected-mode": "yes",
        "databases": "1", "appendonly": "yes", "appendfsync": "always",
        "maxmemory-policy": "noeviction",
        "aclfile": "/Library/Application Support/SubmarineDashRedis/users.acl",
        "dir": "/Library/Application Support/SubmarineDashRedis/data",
    }
    if any(directives.get(key) != [value] for key, value in expected.items()):
        raise HostError("Submarine Redis static controls diverged")
    lines = [line.split() for line in acl.read_text().splitlines() if line.strip()]
    users = {parts[1]: parts[2:] for parts in lines if len(parts) >= 3 and parts[0] == "user"}
    if set(users) != {"default", "submarine_app", "submarine_backup", "submarine_srh"} or users["default"] != ["off"]:
        raise HostError("Submarine Redis ACL users diverged")
    for name, rules in users.items():
        if "nopass" in rules or (name != "default" and ("on" not in rules or not any(rule.startswith("#") for rule in rules))):
            raise HostError("Submarine Redis ACL authentication diverged")
    if credentials_path is not None:
        credentials = parse_credentials(credentials_path)
        mapping = {"APP": "submarine_app", "BACKUP": "submarine_backup", "SRH": "submarine_srh"}
        for name, user in mapping.items():
            expected_hash = "#" + hashlib.sha256(credentials[name].encode()).hexdigest()
            if users[user].count(expected_hash) != 1:
                raise HostError("Submarine Redis ACL credential hash diverged")


def listener_process(port: int) -> tuple[int, int, str]:
    probe = subprocess.run(
        ["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpu"],
        check=False, capture_output=True, text=True,
    )
    pids = {int(line[1:]) for line in probe.stdout.splitlines() if line.startswith("p")}
    uids = {int(line[1:]) for line in probe.stdout.splitlines() if line.startswith("u")}
    if len(pids) != 1 or len(uids) != 1:
        raise HostError("Submarine Redis listener process is ambiguous")
    pid, uid = pids.pop(), uids.pop()
    command = subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "command="], check=True, capture_output=True, text=True,
    ).stdout.strip()
    return pid, uid, command


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def configured_public_url(config_path: Path, allow_local: bool = False) -> str:
    require_regular(config_path, 0o600)
    metadata = config_path.stat()
    expected_uid, expected_gid = (os.geteuid(), os.getegid()) if allow_local else (0, 0)
    if metadata.st_uid != expected_uid or metadata.st_gid != expected_gid:
        raise HostError("public ingress configuration ownership diverged")
    try:
        payload = json.loads(config_path.read_text())
    except json.JSONDecodeError as error:
        raise HostError("public ingress configuration is malformed") from error
    if not isinstance(payload, dict) or set(payload) != {"origin", "path"}:
        raise HostError("public ingress configuration is malformed")
    origin, path = payload["origin"], payload["path"]
    if not isinstance(origin, str) or not isinstance(path, str) or not path.startswith("/"):
        raise HostError("public ingress configuration is malformed")
    parsed = urllib.parse.urlsplit(origin)
    approved_public = parsed.scheme == "https" and parsed.hostname is not None and parsed.hostname.endswith((".ngrok-free.dev", ".ngrok.app"))
    approved_local = allow_local and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if (not (approved_public or approved_local) or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment or parsed.username or parsed.password
            or "?" in path or "#" in path or urllib.parse.urlsplit(path).netloc):
        raise HostError("configured public ingress is outside the approved boundary")
    return origin.rstrip("/") + path


def verify_public_auth(url: str, allow_local: bool = False, config_path: Path = PUBLIC_INGRESS) -> None:
    expected = configured_public_url(config_path, allow_local)
    parsed = urllib.parse.urlsplit(url)
    if url != expected or parsed.query or parsed.fragment:
        raise HostError("public verifier URL differs from the configured ingress route")
    request = urllib.request.Request(url, method="POST", data=b'["PING"]', headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(request, timeout=10)
        if response.geturl() != expected:
            raise HostError("public verifier crossed the configured ingress origin")
        status, content_type, body = response.status, response.headers.get("Content-Type", ""), response.read(65536)
    except urllib.error.HTTPError as error:
        status, content_type, body = error.code, error.headers.get("Content-Type", ""), error.read(65536)
    validate_public_auth_response(status, content_type, body)


def doctor(root: Path) -> dict[str, object]:
    config = root / REDIS_ROOT.relative_to("/") / "redis.conf"
    acl = root / REDIS_ROOT.relative_to("/") / "users.acl"
    require_regular(config, 0o640)
    require_regular(acl, 0o640)
    credentials_path = root / APP.relative_to("/") / "credentials.env"
    verify_static_controls(config, acl, credentials_path if root == Path("/") else None)
    if root == Path("/"):
        uid, _ = service_ids()
        _, listener_uid, command = listener_process(PORT)
        runtime = Path("/usr/local/lib/submarine-redis/current").resolve(strict=True)
        executable = runtime / "bin/redis-server"
        if (listener_uid != uid or not command.startswith(str(executable) + " ")
                or str(REDIS_ROOT / "redis.conf") not in command):
            raise HostError("Submarine Redis listener identity diverged")
        for label in SERVICE_LABELS:
            state = launchd_state(label)
            if not state["loaded"] or (label == SERVICE_LABELS[0] and not state["running"]):
                raise HostError("Submarine LaunchDaemon state diverged")
        credentials = parse_credentials(APP / "credentials.env")
        if redis_command("submarine_backup", credentials["BACKUP"], "PING") != "PONG":
            raise HostError("authenticated Submarine Redis PING failed")
        verify_active_routes(EXPECTED_ROUTES)
    return {"status": "ok", "port": PORT, "service": "_submarine"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-root", type=Path)
    parser.add_argument("--approved-production-bundle", type=Path, help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install")
    install.add_argument("--fail-at", choices=("after-registry", "after-layout"))
    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--fail-before-commit", action="store_true")
    verify = commands.add_parser("verify-backup")
    verify.add_argument("generation", type=Path)
    restore = commands.add_parser("restore-disposable")
    restore.add_argument("generation", type=Path)
    restore.add_argument("destination", type=Path)
    commands.add_parser("doctor")
    public = commands.add_parser("verify-public-auth")
    public.add_argument("url")
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    is_test = arguments.test_root is not None
    if is_test:
        if os.geteuid() == 0:
            raise HostError("test mode refuses root")
        root = arguments.test_root.resolve()
        if root == Path("/"):
            raise HostError("test root cannot be filesystem root")
    else:
        if os.geteuid() != 0:
            raise HostError("production host operation requires root")
        root = Path("/")
    if arguments.command == "install":
        if is_test:
            install_test(root, arguments.fail_at)
        elif arguments.approved_production_bundle is not None:
            install_production(arguments.approved_production_bundle)
        else:
            raise HostError("production installation is reachable only through secure-install-bootstrap.py")
        output = {"status": "installed", "root": str(root)}
    elif arguments.command == "backup":
        output = {"generation": str(backup(root, arguments.fail_before_commit))}
    elif arguments.command == "verify-backup":
        output = verify_generation(arguments.generation)
    elif arguments.command == "restore-disposable":
        restore_disposable(arguments.generation, arguments.destination)
        output = {"status": "verified"}
    elif arguments.command == "doctor":
        output = doctor(root)
    else:
        ingress = root / PUBLIC_INGRESS.relative_to("/") if is_test else PUBLIC_INGRESS
        verify_public_auth(arguments.url, allow_local=is_test, config_path=ingress)
        output = {"status": "verified", "boundary": "srh-json-auth"}
    print(json.dumps(output, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HostError as error:
        print(f"submarine redis host error: {error}", file=sys.stderr)
        raise SystemExit(1)
