"""Background worker.

Phase 1 deliberately mocks the expensive stages so the upload/status UI can be
validated end to end. The Basic Pitch step plugs into `transcribe()` later.
"""

from __future__ import annotations

import argparse
import logging
import time

from . import config, db, security

log = logging.getLogger("tabforge.worker")

PLACEHOLDER_TAB = """# Auto-generated draft — Phase 1 placeholder
# Basic Pitch is not connected yet, so this is a safe placeholder.
# The next phase replaces this body with notes detected from the upload.

e|----------------|----------------|
B|----------------|----------------|
G|----------------|----------------|
D|----------------|----------------|
A|----------------|----------------|
E|----------------|----------------|
"""


def claim_next() -> dict | None:
    """Atomically move one queued job to running."""
    with db.db() as conn:
        row = conn.execute(
            "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        changed = conn.execute(
            """
            UPDATE jobs
            SET status = 'running', stage = 'converting', progress = 5,
                started_at = ?, attempts = attempts + 1
            WHERE id = ? AND status = 'queued'
            """,
            (security.iso(), row["id"]),
        )
        if changed.rowcount != 1:
            return None
        return dict(conn.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone())


def update_job(job_id: str, **fields) -> None:
    allowed = {"status", "stage", "progress", "error", "started_at", "finished_at"}
    values = {key: value for key, value in fields.items() if key in allowed}
    if not values:
        return
    assignments = ", ".join(f"{key} = ?" for key in values)
    with db.db() as conn:
        conn.execute(f"UPDATE jobs SET {assignments} WHERE id = ?", (*values.values(), job_id))


def complete_song(job: dict) -> None:
    now = security.iso()
    with db.db() as conn:
        conn.execute(
            """
            UPDATE songs
            SET status = 'draft', draft = 1, body = ?, confidence = 0, updated_at = ?
            WHERE id = ?
            """,
            (PLACEHOLDER_TAB, now, job["song_id"]),
        )


def fail_song(job: dict, message: str) -> None:
    now = security.iso()
    with db.db() as conn:
        conn.execute(
            "UPDATE songs SET status = 'failed', updated_at = ? WHERE id = ?",
            (now, job["song_id"]),
        )


def process(job: dict) -> None:
    delay = max(0.0, config.MOCK_STAGE_SECONDS)
    try:
        update_job(job["id"], stage="converting", progress=10)
        time.sleep(delay)

        update_job(job["id"], stage="detecting", progress=40)
        time.sleep(delay)

        update_job(job["id"], stage="mapping", progress=80)
        time.sleep(delay)

        complete_song(job)
        update_job(
            job["id"],
            status="done",
            stage="done",
            progress=100,
            finished_at=security.iso(),
        )
        log.info("job %s completed (song %s)", job["id"], job["song_id"])
    except Exception as exc:  # noqa: BLE001 - the DB records the failure
        log.exception("job %s failed", job["id"])
        fail_song(job, str(exc))
        update_job(
            job["id"],
            status="failed",
            stage="failed",
            error=str(exc)[:500],
            finished_at=security.iso(),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="TabForge background worker")
    parser.add_argument("--once", action="store_true", help="process one job and exit")
    parser.add_argument("--poll", type=float, default=1.0, help="seconds between polls")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db.init_db()
    # A single worker owns the queue. On restart, a job left in `running` is
    # stale, so put it back in the queue.
    with db.db() as conn:
        stale = conn.execute("SELECT id, song_id FROM jobs WHERE status = 'running'").fetchall()
        for row in stale:
            conn.execute(
                """
                UPDATE jobs
                SET status = 'queued', stage = 'queued', progress = 0,
                    error = 'Worker restarted before finishing'
                WHERE id = ?
                """,
                (row["id"],),
            )
            conn.execute(
                "UPDATE songs SET status = 'queued', updated_at = ? WHERE id = ?",
                (security.iso(), row["song_id"]),
            )
    log.info("worker started (mock stage %.1fs)", config.MOCK_STAGE_SECONDS)
    while True:
        job = claim_next()
        if job:
            process(job)
            if args.once:
                break
            continue
        if args.once:
            log.info("no queued jobs")
            break
        time.sleep(max(0.2, args.poll))


if __name__ == "__main__":
    main()
