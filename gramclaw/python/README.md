# Instagram authentication sidecar

`gramclaw_instagram.py` is a short-lived NDJSON subprocess. Node sends the
password and challenge answers only over the child's stdin. Protocol messages
use stdout; all output produced by `instagrapi` is isolated and discarded.

The sidecar stores `Client.get_settings()` only in the operating-system
credential store under `gramclaw.instagram.session.v1`. It never writes a
session file. Public operations return sanitized identity/status. The
`credentials` operation is internal to Gramclaw's Node process.

Dependencies are exact and hash-locked. Validate the lock with:

```sh
python3 python/verify_lock.py
python3 -m pip install --require-hashes -r python/requirements.lock
```

Refresh the lock deliberately after verifying every selected release satisfies
the repository's dependency-age policy.
