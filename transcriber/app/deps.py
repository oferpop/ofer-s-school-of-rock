"""Request dependencies: resolve the session cookie to a user row."""

from __future__ import annotations

from fastapi import HTTPException, Request

from . import config, db, security


def current_user(request: Request) -> dict:
    token = request.cookies.get(config.COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    hashed = security.token_hash(token)
    with db.db() as conn:
        row = conn.execute(
            """
            SELECT u.*, s.expires_at AS session_expires
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND u.disabled = 0
            """,
            (hashed,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    expiry = security.from_iso(row["session_expires"])
    if expiry is None or expiry <= security.utcnow():
        raise HTTPException(status_code=401, detail="Session expired")
    user = {
        key: row[key]
        for key in row.keys()
        if key not in {"session_expires", "password_hash"}
    }
    return user


def require_teacher(request: Request) -> dict:
    user = current_user(request)
    if user.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="Teacher access required")
    return user
