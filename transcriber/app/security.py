"""Passwords, session tokens and invite codes using only the standard library."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime | None = None) -> str:
    return (moment or utcnow()).isoformat(timespec="seconds")


def from_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def expires_after(days: int) -> str:
    return iso(utcnow() + timedelta(days=days))


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=32,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def validate_username(username: str) -> str:
    value = username.strip()
    if not USERNAME_RE.match(value):
        raise ValueError("Username must be 3-32 characters: letters, numbers, . _ -")
    return value


def validate_password(password: str) -> str:
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters.")
    if len(password) > 200:
        raise ValueError("Password is too long.")
    return password


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_invite(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def invite_hash(code: str) -> str:
    return hashlib.sha256(normalize_invite(code).encode("utf-8")).hexdigest()


def new_invite_code() -> str:
    raw = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(10))
    return f"TF-{raw[:5]}-{raw[5:]}"
