#!/usr/bin/python3 -I
"""Compatibility shim that extends the installed Torrence registry to 6691.

The original reviewed helper is retained beside this file.  Existing X and
Torrence publishers import the canonical path and therefore inherit the
three-port allow-list without changing their repositories.
"""
from __future__ import annotations

import types
from pathlib import Path

BASE = Path("/usr/local/libexec/torrence-route-registry.pre-submarine")


def _load():
    source = BASE.read_text(encoding="utf-8")
    replacements = {
        "DEFAULT_ALLOWED_PORTS = frozenset({6688, 6690})":
            "DEFAULT_ALLOWED_PORTS = frozenset({6688, 6690, 6691})",
        '} != {"torrence", "x-to-notion"} or len(aggregate) != 2:':
            '} != {"torrence", "x-to-notion", "submarine-dash"} or len(aggregate) != 3:',
        '"cutover requires exactly the Torrence and X routes"':
            '"cutover requires exactly the Torrence, X, and Submarine routes"',
    }
    for old, new in replacements.items():
        if source.count(old) != 1:
            raise RuntimeError("preserved registry helper compatibility anchor diverged")
        source = source.replace(old, new)
    module = types.ModuleType("torrence_route_registry_base")
    module.__file__ = str(BASE)
    exec(compile(source, str(BASE), "exec"), module.__dict__)
    return module


_base = _load()
DEFAULT_ALLOWED_PORTS = _base.DEFAULT_ALLOWED_PORTS


def __getattr__(name):
    return getattr(_base, name)


if __name__ == "__main__":
    raise SystemExit(_base.main())
