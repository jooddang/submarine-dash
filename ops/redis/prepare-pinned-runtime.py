#!/usr/bin/python3 -I
"""Build Submarine's own immutable Redis runtime from reviewed source bytes."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import sys
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent
BASE = BUNDLE / "pinned-runtime-base.py"
loader = importlib.machinery.SourceFileLoader("submarine_pinned_runtime_base", str(BASE))
spec = importlib.util.spec_from_loader(loader.name, loader)
if spec is None:
    raise SystemExit("could not load pinned runtime builder")
module = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = module
loader.exec_module(module)
module.RUNTIME_ROOT = Path("/usr/local/lib/submarine-redis")
runtime = module.prepare_runtime()
pointer = module.RUNTIME_ROOT / "current"
temporary = module.RUNTIME_ROOT / f".current.{os.getpid()}"
temporary.symlink_to(runtime)
os.replace(temporary, pointer)
