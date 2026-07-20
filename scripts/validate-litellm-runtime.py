#!/usr/bin/env python3
"""Validate the locked LiteLLM runtime and the canonical connector."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONNECTOR = ROOT / "connectors" / "litellm"
LOCKFILE = CONNECTOR / "uv.lock"
RESULT_PREFIX = "LITELLM_RUNTIME_RESULT="


class RuntimeValidationError(RuntimeError):
    """Raised when the locked runtime or connector validation fails."""


def run(command: Sequence[str], timeout: float = 300) -> str:
    environment = dict(os.environ)
    completed = subprocess.run(
        list(command),
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        detail = "\n".join(
            value.strip()
            for value in (completed.stdout, completed.stderr)
            if value.strip()
        )
        raise RuntimeValidationError(
            f"command failed with exit {completed.returncode}: {' '.join(command)}"
            + (f"\n{detail[-12_000:]}" if detail else "")
        )
    return completed.stdout.strip()


def locked_litellm_version() -> str:
    document = tomllib.loads(LOCKFILE.read_text(encoding="utf-8"))
    packages = document.get("package")
    if not isinstance(packages, list):
        raise RuntimeValidationError("connector lockfile has no package list")
    versions = [
        package.get("version")
        for package in packages
        if isinstance(package, dict) and package.get("name") == "litellm"
    ]
    if len(versions) != 1 or not isinstance(versions[0], str):
        raise RuntimeValidationError(
            "connector lockfile must pin exactly one LiteLLM release"
        )
    return versions[0]


def uv_command(*arguments: str) -> list[str]:
    return ["uv", "run", "--frozen", "--project", str(CONNECTOR), *arguments]


def main() -> None:
    expected = locked_litellm_version()
    actual = run(
        uv_command(
            "python",
            "-c",
            "from importlib.metadata import version; print(version('litellm'))",
        )
    )
    if actual != expected:
        raise RuntimeValidationError(
            f"locked LiteLLM release is {expected}, but the runtime resolved {actual}"
        )

    checks = {
        "tests": uv_command(
            "pytest",
            "--rootdir",
            str(CONNECTOR),
            str(CONNECTOR / "tests"),
        ),
        "ruff": uv_command("ruff", "check", str(CONNECTOR)),
        "mypy": uv_command("mypy", str(CONNECTOR / "src")),
    }
    for command in checks.values():
        run(command)

    result = {
        "status": "passed",
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "litellm": actual,
        "checks": sorted(checks),
    }
    print(f"{RESULT_PREFIX}{json.dumps(result, sort_keys=True, separators=(',', ':'))}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.SubprocessError, RuntimeValidationError) as error:
        print(f"[litellm-runtime] FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from error
