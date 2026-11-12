#!/usr/bin/env python3
"""Create a single-use (or multi-use) student invite code."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, security  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uses", type=int, default=1)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--by", default="cli")
    args = parser.parse_args()

    if args.uses < 1:
        raise SystemExit("--uses must be at least 1")
    db.init_db()
    code = security.new_invite_code()
    expires = security.expires_after(args.days) if args.days > 0 else None
    with db.db() as conn:
        conn.execute(
            "INSERT INTO invites (code_hash, created_by, uses_left, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (
                security.invite_hash(code),
                args.by,
                args.uses,
                security.iso(),
                expires,
            ),
        )
    print(code)
    print(f"uses: {args.uses}  expires: {expires or 'never'}")


if __name__ == "__main__":
    main()
