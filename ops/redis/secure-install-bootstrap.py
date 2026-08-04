#!/usr/bin/python3 -I
"""Authenticate and install one reviewed Submarine Redis host bundle."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

SOURCE = Path("/Users/jooddang/dev/submarine-dash-wt-auth-consolidation/ops/redis")
APPROVED = Path("/Library/Application Support/RedisGateway/submarine-approved-installers")
TOOL_HASHES = {
    "com.roadcrosser.submarine-redis-backup.plist": "f38c036ce821ad33718e8e4565101f0bb6197d17ef4a008742c8fc9addb48053",
    "com.roadcrosser.submarine-redis-doctor.plist": "446f3b2c1e779f4e8df393930b7c2563b3b3cc94367e6b544678e6635d07f591",
    "com.roadcrosser.submarine-redis.plist": "3d4ee6349f391867a73518be4614b724442d3bdc8673687d75bcd6fd37462be9",
    "pinned-runtime-base.py": "2a7c5cfa25478104fa4907ccb213269874efa036c13437f9458f7de7384d64f0",
    "prepare-pinned-runtime.py": "691c38f4d80e61e17943fae2fc7a885f5fd5bd04b186881fb4c874af90b70c21",
    "redis-submarine.conf": "576fc4365c1779f8ac6128ceda00e8a05b4e20958e9398dfcfcb8dd54370dd3e",
    "route-registry-compat.py": "6e362d7fee1d806ac93305cd9632d99fac9e8bbbf33a0b397e6ad1f72accb453",
    "start-redis-guarded.sh": "f95665afb68bf01dd71e697ec098f9efb6d11d4f49c77e35c660bd0dbb633bfe",
    "submarine_redis_host.py": "fb6824e16ca08250fac0e254d99514502c4660692e55c779c272c7ed8b352d50",
}
TOOL_SOURCES = {
    "pinned-runtime-base.py": Path("/Users/jooddang/dev/x-to-notion-mobile/ops/redis/prepare-pinned-redis-runtime.py"),
}


class BootstrapError(RuntimeError):
    pass


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_all(descriptor: int, payload: bytes) -> None:
    written = 0
    while written < len(payload):
        count = os.write(descriptor, payload[written:])
        if count <= 0:
            raise BootstrapError("approved bundle write made no progress")
        written += count


def read_pinned(name: str, expected: str) -> bytes:
    path = TOOL_SOURCES.get(name, SOURCE / name)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise BootstrapError(f"unsafe bootstrap input: {name}")
        payload = b""
        while chunk := os.read(descriptor, 1024 * 1024):
            payload += chunk
    finally:
        os.close(descriptor)
    if sha256(payload) != expected:
        raise BootstrapError(f"stale bootstrap digest: {name}")
    return payload


def main() -> int:
    if os.geteuid() != 0:
        raise BootstrapError("bootstrap requires root")
    payloads = {name: read_pinned(name, expected) for name, expected in TOOL_HASHES.items()}
    manifest = {name: sha256(payload) for name, payload in payloads.items()}
    bundle_hash = sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
    APPROVED.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = APPROVED / bundle_hash
    if not destination.exists():
        staging = APPROVED / f".{bundle_hash}.{os.getpid()}"
        staging.mkdir(mode=0o700)
        try:
            for name, payload in payloads.items():
                path = staging / name
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o500)
                write_all(descriptor, payload)
                os.fsync(descriptor)
                os.close(descriptor)
            os.replace(staging, destination)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    worker = destination / "submarine_redis_host.py"
    completed = subprocess.run(
        [str(worker), "--approved-production-bundle", str(destination), "install"],
        env={"HOME": "/var/empty", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        stdin=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BootstrapError as error:
        print(f"Submarine installer bootstrap error: {error}", file=sys.stderr)
        raise SystemExit(1)
