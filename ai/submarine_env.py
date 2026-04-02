"""
Gymnasium environment for Deep Dive Dash.
Communicates with the Node.js env-server via subprocess stdin/stdout.
"""

import json
import subprocess
import os
import numpy as np
import gymnasium as gym
from gymnasium import spaces

# Observation vector size (must match env-server.ts extractObservation)
OBS_SIZE = 51

# Path to env-server
ENV_SERVER_PATH = os.path.join(os.path.dirname(__file__), "env-server.ts")


class SubmarineDashEnv(gym.Env):
    """Gymnasium wrapper around the Node.js deterministic simulation."""

    metadata = {"render_modes": []}

    def __init__(self, seed: int = 42):
        super().__init__()
        self._seed = seed
        self._process: subprocess.Popen | None = None

        # Action: 0=nothing, 1=short jump, 2=long jump (hold)
        self.action_space = spaces.Discrete(3)

        # Observation: structured vector from env-server
        self.observation_space = spaces.Box(
            low=-10.0, high=10.0, shape=(OBS_SIZE,), dtype=np.float32
        )

    def _ensure_process(self) -> None:
        """Start the Node.js env-server subprocess if not running."""
        if self._process is not None and self._process.poll() is None:
            return

        project_root = os.path.dirname(os.path.dirname(__file__))
        self._process = subprocess.Popen(
            ["npx", "tsx", ENV_SERVER_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=project_root,
            text=True,
            bufsize=1,  # line-buffered
        )

        # Wait for "ready" signal on stderr
        if self._process.stderr:
            ready_line = self._process.stderr.readline()
            if "ready" not in ready_line:
                raise RuntimeError(f"env-server failed to start: {ready_line}")

    def _send(self, msg: dict) -> dict:
        """Send a JSON message and read the response."""
        assert self._process is not None
        assert self._process.stdin is not None
        assert self._process.stdout is not None

        self._process.stdin.write(json.dumps(msg) + "\n")
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            raise RuntimeError("env-server closed unexpectedly")
        return json.loads(line)

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        if seed is not None:
            self._seed = seed

        self._ensure_process()
        resp = self._send({"cmd": "reset", "seed": self._seed})

        if "error" in resp:
            raise RuntimeError(resp["error"])

        obs = np.array(resp["obs"], dtype=np.float32)
        info = resp.get("info", {})
        return obs, info

    def step(self, action: int):
        resp = self._send({"cmd": "step", "action": int(action)})

        if "error" in resp:
            raise RuntimeError(resp["error"])

        obs = np.array(resp["obs"], dtype=np.float32)
        reward = float(resp["reward"])
        terminated = bool(resp["terminated"])
        truncated = bool(resp["truncated"])
        info = resp.get("info", {})
        return obs, reward, terminated, truncated, info

    def close(self):
        if self._process is not None and self._process.poll() is None:
            try:
                self._send({"cmd": "close"})
            except Exception:
                pass
            self._process.terminate()
            self._process.wait(timeout=5)
            self._process = None

    def __del__(self):
        self.close()


def make_env(seed: int = 42):
    """Factory function for SubprocVecEnv compatibility."""
    def _init():
        return SubmarineDashEnv(seed=seed)
    return _init
