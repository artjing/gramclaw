#!/usr/bin/env python3
"""Reject loose or unhashed requirements in requirements.lock."""

from __future__ import annotations

import pathlib
import re
import sys

LOCK_PATH = pathlib.Path(__file__).with_name("requirements.lock")
PIN = re.compile(r"^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+(?:\s+\\)?$")
HASH = re.compile(r"^\s+--hash=sha256:[a-f0-9]{64}(?:\s+\\)?$")
REQUIRED = {
    "instagrapi": "2.18.12",
    "keyring": "25.7.0",
    "pillow": "12.2.0",
}


def main() -> int:
    lines = LOCK_PATH.read_text(encoding="utf-8").splitlines()
    found: dict[str, str] = {}
    current = None
    hashes = 0
    errors: list[str] = []

    def finish() -> None:
        nonlocal current, hashes
        if current and hashes == 0:
            errors.append(f"{current} has no sha256 hash")
        current = None
        hashes = 0

    for number, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            finish()
            continue
        if raw[:1].isspace():
            if not current or not HASH.fullmatch(raw):
                errors.append(f"line {number} is not a valid hash continuation")
            else:
                hashes += 1
            continue
        finish()
        if not PIN.fullmatch(raw):
            errors.append(f"line {number} is not an exact pin")
            continue
        requirement = raw.removesuffix("\\").strip()
        name, version = requirement.split("==", 1)
        current = name
        found[name.lower().replace("_", "-")] = version
    finish()

    for name, version in REQUIRED.items():
        if found.get(name) != version:
            errors.append(f"{name} must be pinned to {version}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"requirements.lock: {len(found)} exact, hashed packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
