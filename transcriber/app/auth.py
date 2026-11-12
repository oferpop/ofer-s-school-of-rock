"""Invite-only accounts with server-side sessions."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import config, db, security
from .deps import current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignupIn(BaseModel):
    invite: str = Field(min_length=4, max_length=80)
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=200)


def public_user(row: dict) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "created_at": row["created_at"],
    }


def start_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = security.new_session_token()
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (
            security.token_hash(token),
            user_id,
            security.expires_after(config.SESSION_DAYS),
            security.iso(),
        ),
    )
    return token


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        config.COOKIE_NAME,
        token,
        max_age=config.SESSION_DAYS * 24 * 3600,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


@router.post("/signup")
def signup(payload: SignupIn, response: Response) -> dict:
    try:
        username = security.validate_username(payload.username)
        security.validate_password(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    invite_digest = security.invite_hash(payload.invite)
    now = security.iso()
    user_id = security.new_id("usr")
    with db.db() as conn:
        invite = conn.execute(
            """
            SELECT * FROM invites
            WHERE code_hash = ? AND uses_left > 0
              AND (expires_at IS NULL OR expires_at > ?)
            """,
            (invite_digest, now),
        ).fetchone()
        if invite is None:
            raise HTTPException(status_code=400, detail="Invite code is not valid.")
        try:
            conn.execute(
                "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'student', ?)",
                (user_id, username, security.hash_password(payload.password), now),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="That username is already taken.") from exc
        remaining = invite["uses_left"] - 1
        if remaining > 0:
            conn.execute("UPDATE invites SET uses_left = ? WHERE code_hash = ?", (remaining, invite_digest))
        else:
            conn.execute("DELETE FROM invites WHERE code_hash = ?", (invite_digest,))
        token = start_session(conn, user_id)
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    set_session_cookie(response, token)
    return {"user": public_user(dict(user))}


@router.post("/login")
def login(payload: LoginIn, response: Response) -> dict:
    username = payload.username.strip()
    with db.db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE AND disabled = 0",
            (username,),
        ).fetchone()
        if user is None or not security.verify_password(payload.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Wrong username or password.")
        token = start_session(conn, user["id"])
    set_session_cookie(response, token)
    return {"user": public_user(dict(user))}


@router.post("/logout")
def logout(request: Request, response: Response) -> dict:
    token = request.cookies.get(config.COOKIE_NAME)
    if token:
        with db.db() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (security.token_hash(token),))
    response.delete_cookie(config.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request) -> dict:
    user = current_user(request)
    return {"user": public_user(user)}
