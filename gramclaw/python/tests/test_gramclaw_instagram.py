from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import unittest
from contextlib import redirect_stderr

MODULE_PATH = pathlib.Path(__file__).parents[1] / "gramclaw_instagram.py"
SPEC = importlib.util.spec_from_file_location("gramclaw_instagram", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

PASSWORD = "password-canary-7788"
CODE = "code-canary-9911"
SESSION = "session-canary-4411"
CSRF = "csrf-canary-2244"


class MemoryBackend:
    priority = 10


class MemoryKeyring:
    def __init__(self):
        self.values = {}
        self.backend = MemoryBackend()

    def get_keyring(self):
        return self.backend

    def get_password(self, service, account):
        return self.values.get((service, account))

    def set_password(self, service, account, value):
        self.values[(service, account)] = value

    def delete_password(self, service, account):
        if (service, account) not in self.values:
            raise KeyError(account)
        del self.values[(service, account)]


class CookieJar:
    def __init__(self, values=None):
        self.values = dict(values or {})

    def set(self, name, value, **_kwargs):
        self.values[name] = value

    def get_dict(self):
        return dict(self.values)


class FakePublic:
    def __init__(self, cookies):
        self.cookies = CookieJar(cookies)

    def get(self, _url):
        print(f"dependency-public-output:{SESSION}")
        return type("Response", (), {"cookies": self.cookies})()


def named_error(name):
    return type(name, (Exception,), {})


class FakeClient:
    mode = "success"

    def __init__(self):
        self.user_id = "123"
        self.login_calls = 0
        self.challenge_code_handler = None
        self.private = type(
            "Private",
            (),
            {"cookies": CookieJar({"sessionid": SESSION, "csrftoken": CSRF, "ds_user_id": "123"})},
        )()
        self.public = FakePublic({})

    @property
    def cookie_dict(self):
        return self.private.cookies.get_dict()

    def set_settings(self, settings):
        self.private.cookies = CookieJar(settings.get("cookies", {}))
        self.user_id = settings.get("user_id", "123")

    def get_settings(self):
        return {
            "cookies": self.cookie_dict,
            "authorization_data": {"token": "authorization-canary"},
            "user_id": self.user_id,
            "password": PASSWORD,
        }

    def login(self, _username, password, *, verification_code="", **_kwargs):
        self.login_calls += 1
        print(f"dependency-login-output:{password}")
        print(f"dependency-login-error:{password}", file=sys.stderr)
        if self.mode == "bad_password":
            raise named_error("BadPassword")()
        if self.mode == "throttled":
            raise named_error("PleaseWaitFewMinutes")()
        if self.mode == "two_factor" and not verification_code:
            raise named_error("TwoFactorRequired")()
        if self.mode == "two_factor" and verification_code != CODE:
            raise named_error("TwoFactorRequired")()
        if self.mode == "challenge":
            received = self.challenge_code_handler("example", 1)
            print(f"upstream-would-print-code:{received}")
            if received != CODE:
                raise named_error("ChallengeUnknownStep")()
        if self.mode == "manual" and self.login_calls == 1:
            raise named_error("ChallengeRequired")()
        return True

    def challenge_bloks_redirect_dismiss(self):
        print(f"dependency-dismiss-output:{CODE}")

    def account_info(self):
        print(f"dependency-account-output:{SESSION}")
        return {
            "pk": 123,
            "username": "example",
            "full_name": "Example User",
            "profile_pic_url": "https://example.invalid/avatar.jpg",
        }


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.original_stdout = MODULE.PROTOCOL_STDOUT
        self.original_stdin = MODULE.sys.stdin
        self.original_token = MODULE.secrets.token_urlsafe
        MODULE.secrets.token_urlsafe = lambda _size: "fixed-prompt-id"

    def tearDown(self):
        MODULE.PROTOCOL_STDOUT = self.original_stdout
        MODULE.sys.stdin = self.original_stdin
        MODULE.secrets.token_urlsafe = self.original_token

    def run_login(self, mode, responses=""):
        FakeClient.mode = mode
        keyring = MemoryKeyring()
        output = io.StringIO()
        errors = io.StringIO()
        MODULE.PROTOCOL_STDOUT = output
        MODULE.sys.stdin = io.StringIO(responses)
        sidecar = MODULE.InstagramSidecar(
            MODULE.Dependencies(client_factory=FakeClient, keyring=keyring)
        )
        request = {
            "v": 1,
            "op": "login",
            "username": "example",
            "password": PASSWORD,
        }
        with redirect_stderr(errors):
            try:
                result = sidecar.dispatch(request)
            except BaseException as error:
                code, message = MODULE.classify_exception(error)
                result = MODULE.error_envelope(code, message)
            MODULE.emit(result)
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        return messages, output.getvalue(), errors.getvalue(), keyring

    def assert_no_transcript_secrets(self, stdout, stderr):
        for secret in (PASSWORD, CODE, SESSION, CSRF, "authorization-canary"):
            self.assertNotIn(secret, stdout)
            self.assertNotIn(secret, stderr)

    def test_success_is_sanitized_and_keyring_never_stores_password(self):
        messages, stdout, stderr, keyring = self.run_login("success")
        self.assertEqual(messages[-1]["type"], "result")
        self.assertTrue(messages[-1]["ok"])
        self.assertEqual(messages[-1]["credentialId"], "ig:123")
        self.assert_no_transcript_secrets(stdout, stderr)
        stored = next(iter(keyring.values.values()))
        self.assertIn(SESSION, stored)
        self.assertIn("authorization-canary", stored)
        self.assertNotIn(PASSWORD, stored)
        self.assertNotIn('"password"', stored)

    def test_two_factor_prompt_resumes_in_same_process_without_leaking_code(self):
        response = json.dumps(
            {
                "v": 1,
                "op": "respond",
                "promptId": "fixed-prompt-id",
                "value": CODE,
            }
        ) + "\n"
        messages, stdout, stderr, _keyring = self.run_login("two_factor", response)
        self.assertEqual([item["type"] for item in messages], ["state", "prompt", "result"])
        self.assertEqual(messages[1]["kind"], "two_factor")
        self.assertTrue(messages[-1]["ok"])
        self.assert_no_transcript_secrets(stdout, stderr)

    def test_legacy_email_challenge_callback_isolated_from_stdout(self):
        response = json.dumps(
            {
                "v": 1,
                "op": "respond",
                "promptId": "fixed-prompt-id",
                "value": CODE,
            }
        ) + "\n"
        messages, stdout, stderr, _keyring = self.run_login("challenge", response)
        self.assertEqual(messages[1]["kind"], "challenge_code")
        self.assertEqual(messages[1]["channel"], "email")
        self.assertTrue(messages[-1]["ok"])
        self.assert_no_transcript_secrets(stdout, stderr)

    def test_official_app_approval_resumes_once(self):
        response = json.dumps(
            {
                "v": 1,
                "op": "respond",
                "promptId": "fixed-prompt-id",
                "value": "continue",
            }
        ) + "\n"
        messages, stdout, stderr, _keyring = self.run_login("manual", response)
        self.assertEqual(messages[1]["kind"], "manual_approval")
        self.assertTrue(messages[-1]["ok"])
        self.assert_no_transcript_secrets(stdout, stderr)

    def test_bad_password_and_throttle_map_to_stable_errors(self):
        for mode, expected in (
            ("bad_password", "bad_credentials"),
            ("throttled", "throttled"),
        ):
            with self.subTest(mode=mode):
                messages, stdout, stderr, _keyring = self.run_login(mode)
                self.assertEqual(messages[-1]["code"], expected)
                self.assert_no_transcript_secrets(stdout, stderr)

    def test_cancel_and_mismatched_prompt_are_protocol_safe(self):
        for response, expected in (
            ({"v": 1, "op": "cancel"}, "cancelled"),
            (
                {
                    "v": 1,
                    "op": "respond",
                    "promptId": "guessed-id",
                    "value": CODE,
                },
                "protocol_error",
            ),
        ):
            with self.subTest(expected=expected):
                messages, stdout, stderr, _keyring = self.run_login(
                    "two_factor", json.dumps(response) + "\n"
                )
                self.assertEqual(messages[-1]["code"], expected)
                self.assert_no_transcript_secrets(stdout, stderr)

    def test_insecure_keyring_fails_closed(self):
        keyring = MemoryKeyring()
        keyring.backend.priority = 0
        store = MODULE.CredentialStore(keyring)
        with self.assertRaises(MODULE.KeyringUnavailable):
            store.doctor()
        self.assertEqual(keyring.values, {})

    def test_malformed_input_never_echoes_raw_line_or_secret(self):
        malformed = '{"v":1,"op":"login","password":"malformed-secret"\n'
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH)],
            input=malformed,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["code"], "protocol_error")
        self.assertNotIn("malformed-secret", result.stdout)
        self.assertNotIn("malformed-secret", result.stderr)


if __name__ == "__main__":
    unittest.main()
