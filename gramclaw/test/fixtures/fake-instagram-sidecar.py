#!/usr/bin/env python3
"""Fake NDJSON sidecar for Node integration tests. Never contacts Instagram."""

from __future__ import annotations

import json
import sys
import time


def emit(message, *, split=False):
    payload = json.dumps({"v": 1, **message}, separators=(",", ":")) + "\n"
    if split:
        midpoint = len(payload) // 2
        sys.stdout.write(payload[:midpoint])
        sys.stdout.flush()
        sys.stdout.write(payload[midpoint:])
    else:
        sys.stdout.write(payload)
    sys.stdout.flush()


def read():
    return json.loads(sys.stdin.readline())


def result():
    emit(
        {
            "type": "result",
            "ok": True,
            "identity": {
                "username": "example",
                "userId": "123",
                "displayName": "Example User",
                "avatarUrl": None,
            },
            "credentialId": "ig:123",
            "bridgeAvailable": True,
            "password": "result-password-canary",
            "cookies": {"sessionid": "result-session-canary"},
        },
        split=True,
    )


request = read()
operation = request.get("op")
if operation == "doctor":
    emit(
        {
            "type": "result",
            "ok": True,
            "runtime": {
                "python": ".".join(str(item) for item in sys.version_info[:3]),
                "packages": {"instagrapi": "2.16.25", "keyring": "25.7.0"},
            },
            "keyring": {"available": True, "backend": "FakeSecureKeyring"},
        }
    )
elif operation == "status":
    emit(
        {
            "type": "result",
            "ok": True,
            "available": True,
            "username": "example",
            "userId": "123",
        }
    )
elif operation == "credentials":
    emit(
        {
            "type": "result",
            "ok": True,
            "credentials": {
                "cookies": {
                    "sessionid": "session-secret-canary",
                    "csrftoken": "csrf-secret-canary",
                    "ds_user_id": "123",
                    "ignored_cookie": "must-not-cross",
                },
                "userId": "123",
            },
        }
    )
elif operation in {"verify", "merge-cookies"}:
    if operation == "verify":
        result()
    else:
        emit({"type": "result", "ok": True, "updated": True})
elif operation == "delete":
    emit({"type": "result", "ok": True, "deleted": True})
elif operation == "login":
    username = request.get("username")
    password = request.get("password", "")
    print(f"discard-this-stderr:{password}", file=sys.stderr, flush=True)
    if username == "timeout":
        time.sleep(10)
    elif username == "malformed":
        sys.stdout.write(f'not-json:{password}\n')
        sys.stdout.flush()
    elif username == "bad":
        emit(
            {
                "type": "error",
                "ok": False,
                "code": "bad_credentials",
                "message": "Instagram rejected the username or password.",
            }
        )
    elif username == "throttle":
        emit(
            {
                "type": "error",
                "ok": False,
                "code": "throttled",
                "message": "Instagram asked Gramclaw to stop and wait before trying again.",
            }
        )
    else:
        emit({"type": "state", "state": "signing_in"})
        prompt_kind = {
            "twofactor": "two_factor",
            "challenge": "challenge_code",
            "manual": "manual_approval",
        }.get(username)
        if prompt_kind:
            prompt_id = "fixture-prompt"
            emit(
                {
                    "type": "prompt",
                    "id": prompt_id,
                    "kind": prompt_kind,
                    "channel": "email" if prompt_kind == "challenge_code" else "authenticator",
                    "maskedDestination": "e***@example.com" if prompt_kind == "challenge_code" else None,
                    "instruction": "raw fixture instruction" if prompt_kind == "manual_approval" else None,
                }
            )
            response = read()
            if response.get("op") == "cancel":
                emit(
                    {
                        "type": "error",
                        "ok": False,
                        "code": "cancelled",
                        "message": "Sign-in was cancelled.",
                    }
                )
                raise SystemExit(1)
            if (
                response.get("op") != "respond"
                or response.get("promptId") != prompt_id
            ):
                emit(
                    {
                        "type": "error",
                        "ok": False,
                        "code": "protocol_error",
                        "message": "The secure sign-in protocol failed.",
                    }
                )
                raise SystemExit(1)
            print(f"discard-this-code:{response.get('value')}", file=sys.stderr, flush=True)
        result()
else:
    emit(
        {
            "type": "error",
            "ok": False,
            "code": "protocol_error",
            "message": "The secure sign-in protocol failed.",
        }
    )
    raise SystemExit(1)
