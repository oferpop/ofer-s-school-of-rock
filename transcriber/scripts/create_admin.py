#!/usr/bin/env python3
"""Create a teacher account (or a student) from the command line."""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, security  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("username")
    parser.add_argument("password", nargs="?")
    parser.add_argument("--role", choices=["teacher", "student"], default="teacher")
    args = parser.parse_args()

    password = args.password or getpass.getpass("Password: ")
    try:
        username = security.validate_username(args.username)
        security.validate_password(password)
    except ValueError as exc:
        raise SystemExit(str(exc))

    db.init_db()
    with db.db() as conn:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
        if existing:
            raise SystemExit(f"User {username!r} already exists.")
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                security.new_id("usr"),
                username,
                security.hash_password(password),
                args.role,
                security.iso(),
            ),
        )
    print(f"created {args.role} {username!r}")


if __name__ == "__main__":
    main()
