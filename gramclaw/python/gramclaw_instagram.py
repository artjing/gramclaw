#!/usr/bin/env python3
"""Secure NDJSON bridge between Gramclaw and instagrapi.

Protocol messages use the original stdout handle. All third-party output is
discarded so login/challenge secrets cannot corrupt or escape the protocol.
"""

from __future__ import annotations

import contextlib
import importlib.metadata
import io
import json
import secrets
import sys
from dataclasses import dataclass
from typing import Any, Callable

PROTOCOL_VERSION = 1
SERVICE_NAME = "gramclaw.instagram.session.v1"
COOKIE_ALLOWLIST = (
    "sessionid",
    "csrftoken",
    "ds_user_id",
    "mid",
    "ig_did",
    "rur",
    "datr",
    "dpr",
)
EXPECTED_VERSIONS = {
    "instagrapi": "2.18.12",
    "keyring": "25.7.0",
}
PROTOCOL_STDOUT = sys.stdout


class ProtocolFailure(Exception):
    pass


class LoginCancelled(Exception):
    pass


class KeyringUnavailable(Exception):
    pass


class _Discard(io.TextIOBase):
    def write(self, value: str) -> int:
        return len(value)


@contextlib.contextmanager
def isolate_dependency_output():
    sink = _Discard()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        yield


def emit(message: dict[str, Any]) -> None:
    envelope = {"v": PROTOCOL_VERSION, **message}
    PROTOCOL_STDOUT.write(json.dumps(envelope, separators=(",", ":")) + "\n")
    PROTOCOL_STDOUT.flush()


def read_message() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise ProtocolFailure("Protocol input ended unexpectedly.")
    try:
        message = json.loads(line)
    except (TypeError, ValueError) as error:
        raise ProtocolFailure("Malformed protocol input.") from error
    if not isinstance(message, dict) or message.get("v") != PROTOCOL_VERSION:
        raise ProtocolFailure("Unsupported protocol input.")
    return message


def error_envelope(code: str, message: str) -> dict[str, Any]:
    return {"type": "error", "ok": False, "code": code, "message": message}


def classify_exception(error: BaseException) -> tuple[str, str]:
    name = type(error).__name__
    if name in {"BadPassword", "BadCredentials", "LoginRequired"}:
        return "bad_credentials", "Instagram rejected the username or password."
    if name == "TwoFactorRequired":
        return "two_factor_required", "Instagram requires a two-factor code."
    if name in {
        "PleaseWaitFewMinutes",
        "ClientThrottledError",
        "FeedbackRequired",
        "RateLimitError",
    }:
        return "throttled", "Instagram asked Gramclaw to stop and wait before trying again."
    if name in {"SentryBlock", "ChallengeRequired", "ChallengeRedirection"}:
        return (
            "manual_verification_required",
            "Finish the Instagram checkpoint in the official app or website, then reconnect.",
        )
    if name in {
        "UnknownError",
        "ClientUnknownError",
        "ClientBadRequestError",
        "ClientForbiddenError",
        "ClientUnauthorizedError",
        "GenericRequestError",
    }:
        return (
            "unsupported_login_response",
            "Instagram returned a private sign-in response that this Gramclaw build cannot complete.",
        )
    if name in {
        "ChallengeUnknownStep",
        "ChallengeSelfieCaptcha",
        "ChallengeUnknownStep",
        "CaptchaRequired",
        "RecaptchaChallengeForm",
        "ChangePasswordRequired",
        "ConsentRequired",
    }:
        return (
            "manual_verification_required",
            "Instagram requires a verification step that Gramclaw does not automate. Finish it in the official app or website.",
        )
    if isinstance(error, KeyringUnavailable):
        return (
            "keyring_unavailable",
            "A secure system credential store is unavailable. Configure an OS keyring or use another sign-in method.",
        )
    if isinstance(error, LoginCancelled):
        return "cancelled", "Sign-in was cancelled."
    if isinstance(error, ProtocolFailure):
        return "protocol_error", "The secure sign-in protocol failed."
    return "protocol_error", "Secure sign-in failed without exposing Instagram response details."


def safe_identity(value: Any, fallback_user_id: str = "") -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        value = value.model_dump()
    elif hasattr(value, "dict"):
        value = value.dict()
    if not isinstance(value, dict):
        value = {}
    username = str(value.get("username") or "").lstrip("@")
    return {
        "username": username,
        "userId": str(value.get("pk") or value.get("id") or fallback_user_id or ""),
        "displayName": str(value.get("full_name") or value.get("name") or username),
        "avatarUrl": value.get("profile_pic_url_hd") or value.get("profile_pic_url"),
    }


def strip_passwords(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): strip_passwords(item)
            for key, item in value.items()
            if "password" not in str(key).lower()
            and "passwd" not in str(key).lower()
            and str(key).lower() != "pass"
        }
    if isinstance(value, list):
        return [strip_passwords(item) for item in value]
    return value


def secure_backend(keyring_module: Any) -> Any:
    try:
        backend = keyring_module.get_keyring()
        priority = float(getattr(backend, "priority", 0))
    except Exception as error:
        raise KeyringUnavailable() from error
    description = f"{type(backend).__module__}.{type(backend).__name__}".lower()
    if priority <= 0 or any(name in description for name in ("fail", "null", "plaintext")):
        raise KeyringUnavailable()
    return backend


@dataclass
class Dependencies:
    client_factory: Callable[[], Any]
    keyring: Any


def load_dependencies() -> Dependencies:
    from instagrapi import Client
    import keyring

    return Dependencies(client_factory=Client, keyring=keyring)


class CredentialStore:
    def __init__(self, keyring_module: Any):
        self.keyring = keyring_module

    def doctor(self) -> dict[str, Any]:
        backend = secure_backend(self.keyring)
        return {
            "available": True,
            "backend": type(backend).__name__,
        }

    def get(self, credential_id: str) -> dict[str, Any] | None:
        if not credential_id:
            return None
        secure_backend(self.keyring)
        try:
            value = self.keyring.get_password(SERVICE_NAME, credential_id)
        except Exception as error:
            raise KeyringUnavailable() from error
        if not value:
            return None
        try:
            payload = json.loads(value)
        except (TypeError, ValueError) as error:
            raise ProtocolFailure("Stored session is invalid.") from error
        if (
            not isinstance(payload, dict)
            or payload.get("schema") != 1
            or not isinstance(payload.get("settings"), dict)
        ):
            raise ProtocolFailure("Stored session is invalid.")
        return payload

    def set(self, credential_id: str, payload: dict[str, Any]) -> None:
        secure_backend(self.keyring)
        clean_payload = strip_passwords(payload)
        serialized = json.dumps(clean_payload, separators=(",", ":"))
        try:
            self.keyring.set_password(SERVICE_NAME, credential_id, serialized)
        except Exception as error:
            raise KeyringUnavailable() from error

    def delete(self, credential_id: str) -> bool:
        if not credential_id:
            return False
        secure_backend(self.keyring)
        try:
            self.keyring.delete_password(SERVICE_NAME, credential_id)
            return True
        except Exception as error:
            if type(error).__name__ in {"PasswordDeleteError", "KeyError"}:
                return False
            raise KeyringUnavailable() from error


class InstagramSidecar:
    def __init__(self, dependencies: Dependencies):
        self.dependencies = dependencies
        self.store = CredentialStore(dependencies.keyring)
        self._prompt_count = 0

    def prompt(
        self,
        kind: str,
        *,
        channel: str | None = None,
        masked_destination: str | None = None,
        instruction: str | None = None,
    ) -> str:
        if self._prompt_count >= 3:
            raise ProtocolFailure("Too many interactive prompts.")
        self._prompt_count += 1
        prompt_id = secrets.token_urlsafe(18)
        payload: dict[str, Any] = {
            "type": "prompt",
            "id": prompt_id,
            "kind": kind,
            "channel": channel,
            "maskedDestination": masked_destination,
        }
        if instruction:
            payload["instruction"] = instruction
        emit(payload)
        response = read_message()
        if response.get("op") == "cancel":
            raise LoginCancelled()
        if response.get("op") != "respond" or response.get("promptId") != prompt_id:
            raise ProtocolFailure("Prompt response did not match.")
        value = response.get("value")
        if not isinstance(value, str):
            raise ProtocolFailure("Prompt response was invalid.")
        return value

    def challenge_code_handler(self, _username: str, choice: Any) -> str:
        channel = {
            0: "sms",
            1: "email",
            "0": "sms",
            "1": "email",
        }.get(choice, str(choice or "unknown").lower())
        return self.prompt("challenge_code", channel=channel)

    def _new_client(self, credential_id: str = "") -> tuple[Any, dict[str, Any] | None]:
        stored = self.store.get(credential_id) if credential_id else None
        client = self.dependencies.client_factory()
        client.challenge_code_handler = self.challenge_code_handler
        if stored:
            with isolate_dependency_output():
                client.set_settings(stored["settings"])
        return client, stored

    def _identity(self, client: Any) -> dict[str, Any]:
        user_id = str(getattr(client, "user_id", "") or "")
        username = str(getattr(client, "username", "") or "").lstrip("@")
        try:
            with isolate_dependency_output():
                account = client.account_info()
            identity = safe_identity(account, user_id)
            if identity["userId"] and identity["username"]:
                return identity
        except Exception:
            # A private login can succeed even when the optional follow-up profile
            # request is throttled or its response shape has changed. Preserve the
            # authenticated session using the identity established by login.
            pass
        if not user_id or not username:
            raise ProtocolFailure("Instagram identity was missing after sign-in.")
        return {
            "username": username,
            "userId": user_id,
            "displayName": username,
            "avatarUrl": None,
        }

    def _cookie_map(self, client: Any) -> dict[str, str]:
        with isolate_dependency_output():
            raw = dict(getattr(client, "cookie_dict", {}) or {})
        return {
            name: str(raw[name])
            for name in COOKIE_ALLOWLIST
            if raw.get(name) is not None and str(raw[name])
        }

    def _hydrate_web_cookies(self, client: Any) -> dict[str, str]:
        cookies = self._cookie_map(client)
        if cookies.get("csrftoken"):
            return cookies
        try:
            with isolate_dependency_output():
                response = client.public.get("https://www.instagram.com/")
                sources = [
                    getattr(response, "cookies", None),
                    getattr(getattr(client, "public", None), "cookies", None),
                ]
                private_jar = getattr(getattr(client, "private", None), "cookies", None)
                for source in sources:
                    if source is None:
                        continue
                    source_values = source.get_dict() if hasattr(source, "get_dict") else dict(source)
                    for name in COOKIE_ALLOWLIST:
                        if source_values.get(name) and private_jar is not None:
                            private_jar.set(name, source_values[name], domain=".instagram.com")
        except Exception:
            return cookies
        return self._cookie_map(client)

    def _store_client(self, client: Any, identity: dict[str, Any]) -> tuple[str, dict[str, str]]:
        cookies = self._hydrate_web_cookies(client)
        with isolate_dependency_output():
            settings = strip_passwords(client.get_settings())
        user_id = identity["userId"] or str(getattr(client, "user_id", "") or "")
        if not user_id:
            raise ProtocolFailure("Instagram identity was missing.")
        identity["userId"] = user_id
        credential_id = f"ig:{user_id}"
        self.store.set(
            credential_id,
            {
                "schema": 1,
                "username": identity["username"],
                "userId": user_id,
                "settings": settings,
            },
        )
        return credential_id, cookies

    def login(self, request: dict[str, Any]) -> dict[str, Any]:
        username = str(request.get("username") or "").strip().lstrip("@")
        password = request.get("password")
        if not username or not isinstance(password, str) or not password:
            raise ProtocolFailure("Username and password are required.")
        credential_id = str(request.get("credentialId") or "")
        client, _stored = self._new_client(credential_id)
        emit({"type": "state", "state": "signing_in"})
        two_factor_attempts = 0
        manual_attempted = False
        verification_code = ""
        while True:
            try:
                with isolate_dependency_output():
                    logged_in = client.login(
                        username,
                        password,
                        relogin=False,
                        verification_code=verification_code,
                    )
                if not logged_in:
                    raise ProtocolFailure("Instagram login did not complete.")
                break
            except Exception as error:
                name = type(error).__name__
                if name == "TwoFactorRequired" and two_factor_attempts < 2:
                    two_factor_attempts += 1
                    verification_code = self.prompt(
                        "two_factor",
                        channel="authenticator",
                    )
                    continue
                if name in {"ChallengeRequired", "ChallengeRedirection", "SentryBlock"} and not manual_attempted:
                    manual_attempted = True
                    self.prompt(
                        "manual_approval",
                        instruction="Approve this login in the official Instagram app, then continue.",
                    )
                    try:
                        dismiss = getattr(client, "challenge_bloks_redirect_dismiss", None)
                        if callable(dismiss):
                            with isolate_dependency_output():
                                dismiss()
                    except Exception:
                        pass
                    continue
                raise
        identity = self._identity(client)
        stored_id, cookies = self._store_client(client, identity)
        return {
            "type": "result",
            "ok": True,
            "identity": identity,
            "credentialId": stored_id,
            "bridgeAvailable": bool(cookies.get("sessionid") and cookies.get("csrftoken")),
        }

    def doctor(self) -> dict[str, Any]:
        versions = {}
        for package, expected in EXPECTED_VERSIONS.items():
            actual = importlib.metadata.version(package)
            if actual != expected:
                raise ProtocolFailure("Packaged dependency version mismatch.")
            versions[package] = actual
        keyring_status = self.store.doctor()
        return {
            "type": "result",
            "ok": True,
            "runtime": {"python": ".".join(map(str, sys.version_info[:3])), "packages": versions},
            "keyring": keyring_status,
        }

    def status(self, request: dict[str, Any]) -> dict[str, Any]:
        credential_id = str(request.get("credentialId") or "")
        stored = self.store.get(credential_id)
        return {
            "type": "result",
            "ok": True,
            "available": bool(stored),
            "username": stored.get("username") if stored else None,
            "userId": stored.get("userId") if stored else None,
        }

    def credentials(self, request: dict[str, Any]) -> dict[str, Any]:
        credential_id = str(request.get("credentialId") or "")
        client, stored = self._new_client(credential_id)
        if not stored:
            return error_envelope("session_expired", "The saved Instagram session is unavailable.")
        cookies = self._cookie_map(client)
        if not cookies.get("sessionid") or not cookies.get("csrftoken"):
            return error_envelope(
                "web_cookie_bridge_unavailable",
                "The saved session is missing cookies required by Gramclaw's web transport.",
            )
        return {
            "type": "result",
            "ok": True,
            "credentials": {
                "cookies": cookies,
                "userId": str(getattr(client, "user_id", "") or stored.get("userId") or ""),
            },
        }

    def verify(self, request: dict[str, Any]) -> dict[str, Any]:
        credential_id = str(request.get("credentialId") or "")
        client, stored = self._new_client(credential_id)
        if not stored:
            return error_envelope("session_expired", "The saved Instagram session is unavailable.")
        identity = self._identity(client)
        stored_id, cookies = self._store_client(client, identity)
        return {
            "type": "result",
            "ok": True,
            "identity": identity,
            "credentialId": stored_id,
            "bridgeAvailable": bool(cookies.get("sessionid") and cookies.get("csrftoken")),
        }

    def merge_cookies(self, request: dict[str, Any]) -> dict[str, Any]:
        credential_id = str(request.get("credentialId") or "")
        client, stored = self._new_client(credential_id)
        if not stored:
            return error_envelope("session_expired", "The saved Instagram session is unavailable.")
        supplied = request.get("cookies")
        if not isinstance(supplied, dict):
            raise ProtocolFailure("Cookie update was invalid.")
        jar = getattr(getattr(client, "private", None), "cookies", None)
        if jar is None:
            raise ProtocolFailure("Stored session cookie jar is unavailable.")
        with isolate_dependency_output():
            for name in COOKIE_ALLOWLIST:
                value = supplied.get(name)
                if isinstance(value, str) and value:
                    jar.set(name, value, domain=".instagram.com")
            settings = strip_passwords(client.get_settings())
        stored["settings"] = settings
        self.store.set(credential_id, stored)
        return {"type": "result", "ok": True, "updated": True}

    def delete(self, request: dict[str, Any]) -> dict[str, Any]:
        deleted = self.store.delete(str(request.get("credentialId") or ""))
        return {"type": "result", "ok": True, "deleted": deleted}

    def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        operation = request.get("op")
        if operation == "login":
            return self.login(request)
        if operation == "doctor":
            return self.doctor()
        if operation == "status":
            return self.status(request)
        if operation == "credentials":
            return self.credentials(request)
        if operation == "verify":
            return self.verify(request)
        if operation == "merge-cookies":
            return self.merge_cookies(request)
        if operation == "delete":
            return self.delete(request)
        raise ProtocolFailure("Unknown protocol operation.")


def main() -> int:
    try:
        request = read_message()
        dependencies = load_dependencies()
        result = InstagramSidecar(dependencies).dispatch(request)
        emit(result)
        return 0 if result.get("ok") else 1
    except BaseException as error:
        code, message = classify_exception(error)
        emit(error_envelope(code, message))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
