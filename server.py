#!/usr/bin/env python3
"""Ofer's School of Rock Pro — local server.

Serves the static app and a small JSON API for real accounts:

  POST /api/auth/signup   {name, email, password}
  POST /api/auth/login    {email, password}
  POST /api/auth/logout
  GET  /api/auth/me
  GET  /api/state
  PUT  /api/state         {saved, imported, playlists, practice}

Passwords are hashed with scrypt and a per-user salt; sessions are random
tokens in an httpOnly, SameSite=Lax cookie, and only their SHA-256 is stored.
No third-party packages: standard library only.

    python3 server.py            # http://127.0.0.1:4173
    PORT=8080 python3 server.py
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import ssl
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "osr.db")
PORT = int(os.environ.get("PORT", "4173"))
HOST = os.environ.get("HOST", "127.0.0.1")

SESSION_COOKIE = "osr_session"
SESSION_DAYS = 30
MAX_BODY = 2 * 1024 * 1024  # 2 MiB of app state per account
MIN_PASSWORD = 10

# Paths the static server must never hand out.
BLOCKED_PREFIXES = ("/data", "/.git", "/server.py", "/songsterr-agent-env")

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$")

db_lock = threading.Lock()
rate_lock = threading.Lock()
rate_hits: dict[str, list[float]] = {}


# --- database -----------------------------------------------------------


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db():
    """One short-lived connection per request; always closed."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
    conn = connect()
    try:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                salt          TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at    TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_state (
                user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                payload    TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS comments (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id    TEXT NOT NULL,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body       TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS comments_song ON comments(song_id, created_at);
            """
        )
        conn.commit()
    finally:
        conn.close()


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.replace(microsecond=0).isoformat()


def hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
        maxmem=64 * 1024 * 1024,
    )
    return digest.hex()


def new_salt() -> str:
    return secrets.token_hex(16)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --- rate limiting ------------------------------------------------------


def rate_limited(key: str, limit: int, window_seconds: int) -> bool:
    """True when this key has used up its allowance in the window."""
    cutoff = time.monotonic() - window_seconds
    with rate_lock:
        hits = [stamp for stamp in rate_hits.get(key, []) if stamp > cutoff]
        if len(hits) >= limit:
            rate_hits[key] = hits
            return True
        hits.append(time.monotonic())
        rate_hits[key] = hits
        if len(rate_hits) > 5000:  # keep the table from growing without bound
            for stale in [k for k, v in rate_hits.items() if not v or v[-1] <= cutoff]:
                rate_hits.pop(stale, None)
    return False


# --- account helpers ----------------------------------------------------


def user_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "createdAt": row["created_at"],
    }


def create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    created = now()
    expires = created + timedelta(days=SESSION_DAYS)
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token_hash(token), user_id, iso(created), iso(expires)),
    )
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(created),))
    conn.commit()
    return token


def session_user(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    row = conn.execute(
        """
        SELECT users.* FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?
        """,
        (token_hash(token), iso(now())),
    ).fetchone()
    return row


def valid_state(payload: object) -> dict | None:
    """Accept only the shape the app writes, bounded in size."""
    if not isinstance(payload, dict):
        return None
    saved = payload.get("saved", [])
    imported = payload.get("imported", [])
    playlists = payload.get("playlists", [])
    practice = payload.get("practice", {})
    videos = payload.get("videos", {})
    if not isinstance(saved, list) or not all(isinstance(v, str) for v in saved):
        return None
    if not isinstance(imported, list) or not all(
        isinstance(v, dict) and isinstance(v.get("id"), str) and isinstance(v.get("body"), str)
        for v in imported
    ):
        return None
    if not isinstance(playlists, list) or not all(
        isinstance(v, dict) and isinstance(v.get("id"), str) for v in playlists
    ):
        return None
    if not isinstance(practice, dict) or not all(
        isinstance(v, dict) and isinstance(v.get("seconds"), (int, float)) for v in practice.values()
    ):
        return None
    ratings = payload.get("ratings", {})
    if not isinstance(ratings, dict) or not all(
        isinstance(k, str) and isinstance(v, int) and 1 <= v <= 5 for k, v in ratings.items()
    ):
        return None
    if not isinstance(videos, dict):
        return None
    video_id_re = re.compile(r"^[A-Za-z0-9_-]{11}$")
    for video in videos.values():
        if not isinstance(video, dict):
            return None
        if not isinstance(video.get("id"), str) or not video_id_re.match(video["id"]):
            return None
        if not isinstance(video.get("title", ""), str):
            return None
    clean = {
        "saved": saved,
        "imported": imported,
        "playlists": playlists,
        "practice": practice,
        "ratings": ratings,
        "videos": videos,
    }
    if len(json.dumps(clean)) > MAX_BODY:
        return None
    return clean


# --- HTTP handler -------------------------------------------------------


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "OSRPro/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    # -- plumbing ------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def is_https(self) -> bool:
        if isinstance(self.connection, ssl.SSLSocket):
            return True
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    def send_json(self, status: int, payload: dict | None = None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def fail(self, status: int, error: str, message: str, extra: dict | None = None) -> None:
        payload = {"error": error, "message": message}
        if extra:
            payload.update(extra)
        self.send_json(status, payload)

    def read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def origin_ok(self) -> bool:
        """Same-origin check for state-changing requests (CSRF defence)."""
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if origin:
            return urlsplit(origin).netloc == host
        referer = self.headers.get("Referer")
        if referer:
            return urlsplit(referer).netloc == host
        return False

    def session_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            jar = SimpleCookie(raw)
        except Exception:
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def set_session_cookie(self, token: str) -> None:
        attrs = [
            f"{SESSION_COOKIE}={token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={SESSION_DAYS * 24 * 3600}",
        ]
        if self.is_https():
            attrs.append("Secure")
        self.send_header("Set-Cookie", "; ".join(attrs))

    def clear_session_cookie(self) -> None:
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")

    # -- routing -------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self.api_get(path)
            return
        if self.blocked_static(path):
            self.fail(HTTPStatus.NOT_FOUND, "not_found", "Not found")
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self.fail(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "Use GET")
            return
        if self.blocked_static(path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/api/comments":
            self.create_comment()
            return
        if path not in ("/api/auth/signup", "/api/auth/login", "/api/auth/logout"):
            self.fail(HTTPStatus.NOT_FOUND, "not_found", "Unknown endpoint")
            return
        if not self.origin_ok():
            self.fail(HTTPStatus.FORBIDDEN, "bad_origin", "Cross-origin request refused")
            return
        if path == "/api/auth/signup":
            self.signup()
        elif path == "/api/auth/login":
            self.login()
        else:
            self.logout()

    def do_PUT(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path != "/api/state":
            self.fail(HTTPStatus.NOT_FOUND, "not_found", "Unknown endpoint")
            return
        if not self.origin_ok():
            self.fail(HTTPStatus.FORBIDDEN, "bad_origin", "Cross-origin request refused")
            return
        self.put_state()

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        match = re.match(r"^/api/comments/(\d{1,12})$", path)
        if not match:
            self.fail(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "Unsupported method")
            return
        if not self.origin_ok():
            self.fail(HTTPStatus.FORBIDDEN, "bad_origin", "Cross-origin request refused")
            return
        self.delete_comment(int(match.group(1)))

    # -- static --------------------------------------------------------

    def blocked_static(self, path: str) -> bool:
        decoded = unquote(path)
        if any(decoded == prefix or decoded.startswith(prefix + "/") for prefix in BLOCKED_PREFIXES):
            return True
        return any(part.startswith(".") for part in decoded.split("/") if part)

    def list_directory(self, *args, **kwargs):  # noqa: D401 - no directory listings
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    # -- API: reads ----------------------------------------------------

    def api_get(self, path: str) -> None:
        if path == "/api/auth/me":
            with db_lock, db() as conn:
                user = session_user(conn, self.session_token())
            self.send_json(HTTPStatus.OK, {"user": user_json(user) if user else None})
            return

        if path == "/api/state":
            with db_lock, db() as conn:
                user = session_user(conn, self.session_token())
                if not user:
                    self.fail(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Not logged in")
                    return
                row = conn.execute(
                    "SELECT payload FROM user_state WHERE user_id = ?", (user["id"],)
                ).fetchone()
            self.send_json(HTTPStatus.OK, {"state": json.loads(row["payload"]) if row else None})
            return

        if path == "/api/comments":
            self.get_comments()
            return

        self.fail(HTTPStatus.NOT_FOUND, "not_found", "Unknown endpoint")

    # -- API: comments --------------------------------------------------

    def get_comments(self) -> None:
        query = parse_qs(urlsplit(self.path).query)
        song = (query.get("song") or [""])[0].strip()
        if not re.match(r"^[A-Za-z0-9._-]{1,80}$", song):
            self.fail(HTTPStatus.BAD_REQUEST, "invalid_song", "Missing or invalid song id")
            return

        with db_lock, db() as conn:
            me = session_user(conn, self.session_token())
            rows = conn.execute(
                """
                SELECT c.id, c.song_id, c.user_id, c.body, c.created_at, u.name
                FROM comments c JOIN users u ON u.id = c.user_id
                WHERE c.song_id = ?
                ORDER BY c.created_at ASC, c.id ASC
                LIMIT 200
                """,
                (song,),
            ).fetchall()

        comments = [
            {
                "id": row["id"],
                "songId": row["song_id"],
                "author": row["name"],
                "body": row["body"],
                "createdAt": row["created_at"],
                "mine": bool(me and row["user_id"] == me["id"]),
            }
            for row in rows
        ]
        self.send_json(
            HTTPStatus.OK,
            {"comments": comments, "authenticated": bool(me), "count": len(comments)},
        )

    def create_comment(self) -> None:
        if not self.origin_ok():
            self.fail(HTTPStatus.FORBIDDEN, "bad_origin", "Cross-origin request refused")
            return

        with db_lock, db() as conn:
            user = session_user(conn, self.session_token())
        if not user:
            self.fail(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Log in to comment")
            return

        if rate_limited(f"comment:{user['id']}", limit=20, window_seconds=3600):
            self.fail(HTTPStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many comments, try again later")
            return

        data = self.read_json()
        if data is None:
            self.fail(HTTPStatus.BAD_REQUEST, "bad_request", "Expected a JSON body")
            return

        song = str(data.get("songId", "")).strip()
        body = str(data.get("body", "")).strip()
        if not re.match(r"^[A-Za-z0-9._-]{1,80}$", song):
            self.fail(HTTPStatus.BAD_REQUEST, "invalid_song", "Missing or invalid song id")
            return
        if not 1 <= len(body) <= 1000:
            self.fail(HTTPStatus.BAD_REQUEST, "invalid_comment", "Comment must be 1–1000 characters")
            return

        created = iso(now())
        with db_lock, db() as conn:
            cur = conn.execute(
                "INSERT INTO comments (song_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
                (song, user["id"], body, created),
            )
            comment_id = cur.lastrowid
            conn.commit()

        self.send_json(
            HTTPStatus.CREATED,
            {
                "comment": {
                    "id": comment_id,
                    "songId": song,
                    "author": user["name"],
                    "body": body,
                    "createdAt": created,
                    "mine": True,
                }
            },
        )

    def delete_comment(self, comment_id: int) -> None:
        with db_lock, db() as conn:
            user = session_user(conn, self.session_token())
            if not user:
                self.fail(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Log in first")
                return
            row = conn.execute("SELECT user_id FROM comments WHERE id = ?", (comment_id,)).fetchone()
            if not row:
                self.fail(HTTPStatus.NOT_FOUND, "not_found", "Comment not found")
                return
            if row["user_id"] != user["id"]:
                self.fail(HTTPStatus.FORBIDDEN, "forbidden", "You can only delete your own comments")
                return
            conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
            conn.commit()

        self.send_json(HTTPStatus.NO_CONTENT, None)

    # -- API: auth -----------------------------------------------------

    def signup(self) -> None:
        if rate_limited(f"signup:{self.client_ip()}", limit=10, window_seconds=3600):
            self.fail(HTTPStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many sign-ups, try again later")
            return

        data = self.read_json()
        if data is None:
            self.fail(HTTPStatus.BAD_REQUEST, "bad_request", "Expected a JSON body")
            return

        name = str(data.get("name", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))

        if not 1 <= len(name) <= 40:
            self.fail(HTTPStatus.BAD_REQUEST, "invalid_name", "Name must be 1–40 characters")
            return
        if len(email) > 254 or not EMAIL_RE.match(email):
            self.fail(HTTPStatus.BAD_REQUEST, "invalid_email", "Enter a valid email address")
            return
        if not MIN_PASSWORD <= len(password) <= 200 or password.strip() != password:
            self.fail(
                HTTPStatus.BAD_REQUEST,
                "invalid_password",
                f"Password must be {MIN_PASSWORD}–200 characters with no leading or trailing spaces",
            )
            return

        salt = new_salt()
        digest = hash_password(password, salt)
        created = iso(now())

        with db_lock, db() as conn:
            existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
            if existing:
                self.fail(HTTPStatus.CONFLICT, "email_taken", "That email already has an account")
                return
            cur = conn.execute(
                "INSERT INTO users (email, name, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (email, name, salt, digest, created),
            )
            user_id = cur.lastrowid
            token = create_session(conn, user_id)
            user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

        self.send_response(HTTPStatus.CREATED)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.set_session_cookie(token)
        body = json.dumps({"user": user_json(user)}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def login(self) -> None:
        ip = self.client_ip()
        if rate_limited(f"login-ip:{ip}", limit=30, window_seconds=900):
            self.fail(HTTPStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many attempts, try again in a few minutes")
            return

        data = self.read_json()
        if data is None:
            self.fail(HTTPStatus.BAD_REQUEST, "bad_request", "Expected a JSON body")
            return
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))

        if rate_limited(f"login-account:{email}", limit=10, window_seconds=900):
            self.fail(HTTPStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many attempts for this account")
            return

        with db_lock, db() as conn:
            user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            ok = False
            if user:
                digest = hash_password(password, user["salt"])
                ok = hmac.compare_digest(digest, user["password_hash"])
            else:
                # Spend the same scrypt work for unknown emails so timing does
                # not reveal which addresses have accounts.
                hash_password(password, "00" * 16)
            if not user or not ok:
                self.fail(HTTPStatus.UNAUTHORIZED, "invalid_credentials", "Wrong email or password")
                return
            token = create_session(conn, user["id"])
            payload = user_json(user)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.set_session_cookie(token)
        body = json.dumps({"user": payload}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def logout(self) -> None:
        token = self.session_token()
        if token:
            with db_lock, db() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
                conn.commit()
        self.send_response(HTTPStatus.NO_CONTENT)
        self.clear_session_cookie()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- API: state ----------------------------------------------------

    def put_state(self) -> None:
        with db_lock, db() as conn:
            user = session_user(conn, self.session_token())
            if not user:
                self.fail(HTTPStatus.UNAUTHORIZED, "unauthenticated", "Not logged in")
                return

        data = self.read_json()
        if data is None:
            self.fail(HTTPStatus.BAD_REQUEST, "bad_request", "Expected a JSON body")
            return
        state = valid_state(data.get("state", data))
        if state is None:
            self.fail(HTTPStatus.BAD_REQUEST, "invalid_state", "That state shape is not accepted")
            return

        payload = json.dumps(state)
        with db_lock, db() as conn:
            conn.execute(
                """
                INSERT INTO user_state (user_id, payload, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
                """,
                (user["id"], payload, iso(now())),
            )
            conn.commit()
        self.send_json(HTTPStatus.NO_CONTENT, None)


def main() -> None:
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), AppHandler)
    url = f"http://{HOST}:{PORT}"
    print(f"Ofer's School of Rock Pro — {url}")
    print(f"Accounts database: {DB_PATH}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
