"""Upload, job status and the private song library."""

from __future__ import annotations

import shutil
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from . import config, db, security
from .deps import current_user

router = APIRouter(prefix="/api", tags=["transcriptions"])


def _reference_url(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in config.YOUTUBE_HOSTS:
        raise HTTPException(
            status_code=400,
            detail="Reference links must be YouTube URLs. Audio is never downloaded from them.",
        )
    return text


def _owned_song(conn, song_id: str, user: dict) -> dict:
    row = conn.execute("SELECT * FROM songs WHERE id = ?", (song_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Song not found.")
    if row["owner_id"] != user["id"] and user["role"] != "teacher":
        raise HTTPException(status_code=404, detail="Song not found.")
    return dict(row)


@router.post("/transcriptions", status_code=status.HTTP_202_ACCEPTED)
async def create_transcription(
    audio: UploadFile = File(...),
    title: str = Form(""),
    artist: str = Form(""),
    youtube_url: str = Form(""),
    user: dict = Depends(current_user),
) -> dict:
    reference = _reference_url(youtube_url)
    original = Path(audio.filename or "audio")
    extension = original.suffix.lower()
    if extension not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Upload an audio file (mp3, wav, m4a, aac, flac, ogg or opus).",
        )

    now = security.iso()
    cutoff = security.iso(security.utcnow() - timedelta(days=1))
    with db.db() as conn:
        recent = conn.execute(
            "SELECT COUNT(*) AS n FROM songs WHERE owner_id = ? AND created_at > ?",
            (user["id"], cutoff),
        ).fetchone()["n"]
        if recent >= config.UPLOADS_PER_DAY:
            raise HTTPException(status_code=429, detail="Daily upload limit reached.")
        active = conn.execute(
            "SELECT COUNT(*) AS n FROM jobs WHERE owner_id = ? AND status IN (?, ?)",
            (user["id"], *config.ACTIVE_JOB_STATUSES),
        ).fetchone()["n"]
        if active:
            raise HTTPException(status_code=409, detail="A transcription is already processing.")

    song_id = security.new_id("song")
    job_id = security.new_id("job")
    song_dir = config.UPLOAD_DIR / song_id
    song_dir.mkdir(parents=True, exist_ok=True)
    destination = song_dir / f"source{extension}"
    total = 0
    try:
        with destination.open("wb") as handle:
            while True:
                chunk = await audio.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Audio must be smaller than {config.MAX_UPLOAD_MB} MB.",
                    )
                handle.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="The uploaded file is empty.")

        clean_title = (title.strip() or original.stem or "Untitled")[:160]
        clean_artist = artist.strip()[:160]
        with db.db() as conn:
            conn.execute(
                """
                INSERT INTO songs
                    (id, owner_id, title, artist, source_url, source_kind, status, draft, body,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'upload', 'queued', 1, '', ?, ?)
                """,
                (song_id, user["id"], clean_title, clean_artist, reference, now, now),
            )
            conn.execute(
                """
                INSERT INTO jobs
                    (id, song_id, owner_id, status, stage, progress, created_at)
                VALUES (?, ?, ?, 'queued', 'queued', 0, ?)
                """,
                (job_id, song_id, user["id"], now),
            )
            conn.execute(
                "INSERT INTO assets (id, song_id, kind, path, bytes, created_at) VALUES (?, ?, 'audio', ?, ?, ?)",
                (
                    security.new_id("asset"),
                    song_id,
                    str(destination.relative_to(config.DATA_DIR)),
                    total,
                    now,
                ),
            )
    except Exception:
        shutil.rmtree(song_dir, ignore_errors=True)
        raise

    return {"job_id": job_id, "song_id": song_id}


@router.get("/jobs/active")
def active_job(user: dict = Depends(current_user)) -> dict:
    with db.db() as conn:
        job = conn.execute(
            """
            SELECT * FROM jobs
            WHERE owner_id = ? AND status IN (?, ?)
            ORDER BY created_at DESC LIMIT 1
            """,
            (user["id"], *config.ACTIVE_JOB_STATUSES),
        ).fetchone()
    if job is None:
        return {"job": None}
    return {
        "job": {
            "id": job["id"],
            "song_id": job["song_id"],
            "status": job["status"],
            "stage": job["stage"],
            "progress": job["progress"],
            "error": job["error"],
            "attempts": job["attempts"],
        }
    }


@router.get("/jobs/{job_id}")
def job_status(job_id: str, user: dict = Depends(current_user)) -> dict:
    with db.db() as conn:
        job = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        if job["owner_id"] != user["id"] and user["role"] != "teacher":
            raise HTTPException(status_code=404, detail="Job not found.")
        return {
            "id": job["id"],
            "song_id": job["song_id"],
            "status": job["status"],
            "stage": job["stage"],
            "progress": job["progress"],
            "error": job["error"],
            "attempts": job["attempts"],
        }


@router.post("/jobs/{job_id}/retry", status_code=status.HTTP_202_ACCEPTED)
def retry_job(job_id: str, user: dict = Depends(current_user)) -> dict:
    with db.db() as conn:
        job = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        if job["owner_id"] != user["id"] and user["role"] != "teacher":
            raise HTTPException(status_code=404, detail="Job not found.")
        if job["status"] != "failed":
            raise HTTPException(status_code=409, detail="Only failed jobs can be retried.")
        conn.execute(
            """
            UPDATE jobs
            SET status = 'queued', stage = 'queued', progress = 0,
                error = NULL, started_at = NULL, finished_at = NULL
            WHERE id = ?
            """,
            (job_id,),
        )
        conn.execute(
            "UPDATE songs SET status = 'queued', updated_at = ? WHERE id = ?",
            (security.iso(), job["song_id"]),
        )
    return {"job_id": job_id, "status": "queued"}


@router.get("/songs")
def list_songs(user: dict = Depends(current_user)) -> dict:
    with db.db() as conn:
        if user["role"] == "teacher":
            rows = conn.execute(
                """
                SELECT s.*, u.username AS owner_name FROM songs s
                JOIN users u ON u.id = s.owner_id
                ORDER BY s.created_at DESC
                """
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT s.*, u.username AS owner_name FROM songs s
                JOIN users u ON u.id = s.owner_id
                WHERE s.owner_id = ?
                ORDER BY s.created_at DESC
                """,
                (user["id"],),
            ).fetchall()
    return {
        "songs": [
            {
                "id": row["id"],
                "title": row["title"],
                "artist": row["artist"],
                "status": row["status"],
                "draft": bool(row["draft"]),
                "owner_name": row["owner_name"],
                "source_url": row["source_url"],
                "created_at": row["created_at"],
                "confidence": row["confidence"],
            }
            for row in rows
        ]
    }


@router.get("/songs/{song_id}")
def get_song(song_id: str, user: dict = Depends(current_user)) -> dict:
    with db.db() as conn:
        song = _owned_song(conn, song_id, user)
    return {
        "id": song["id"],
        "title": song["title"],
        "artist": song["artist"],
        "status": song["status"],
        "draft": bool(song["draft"]),
        "body": song["body"],
        "source_url": song["source_url"],
        "created_at": song["created_at"],
        "confidence": song["confidence"],
    }


@router.patch("/songs/{song_id}")
async def update_song(
    song_id: str,
    payload: dict,
    user: dict = Depends(current_user),
) -> dict:
    with db.db() as conn:
        song = _owned_song(conn, song_id, user)
        title = str(payload.get("title", song["title"])).strip()[:160] or song["title"]
        artist = str(payload.get("artist", song["artist"])).strip()[:160]
        body = payload.get("body", song["body"])
        if not isinstance(body, str):
            raise HTTPException(status_code=400, detail="body must be text.")
        draft = song["draft"]
        song_status = song["status"]
        reviewed_at = song["reviewed_at"]
        if user["role"] == "teacher" and payload.get("approve") is True:
            draft = 0
            song_status = "approved"
            reviewed_at = security.iso()
        conn.execute(
            """
            UPDATE songs SET title = ?, artist = ?, body = ?, draft = ?, status = ?,
                reviewed_at = ?, updated_at = ? WHERE id = ?
            """,
            (title, artist, body, draft, song_status, reviewed_at, security.iso(), song_id),
        )
    return {"ok": True, "id": song_id, "draft": bool(draft), "status": song_status}


@router.delete("/songs/{song_id}")
def delete_song(song_id: str, user: dict = Depends(current_user)) -> dict:
    with db.db() as conn:
        _owned_song(conn, song_id, user)
        conn.execute("DELETE FROM songs WHERE id = ?", (song_id,))
    shutil.rmtree(config.UPLOAD_DIR / song_id, ignore_errors=True)
    shutil.rmtree(config.ASSET_DIR / song_id, ignore_errors=True)
    return {"ok": True}
