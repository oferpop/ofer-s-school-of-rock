"""Runtime configuration for the transcription service.

Everything lives under one data directory so Docker only needs a single volume.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.environ.get("TF_DATA_DIR", str(ROOT / "data"))).resolve()
UPLOAD_DIR = DATA_DIR / "uploads"
ASSET_DIR = DATA_DIR / "assets"
DB_PATH = Path(os.environ.get("TF_DB_PATH", str(DATA_DIR / "app.db"))).resolve()

MAX_UPLOAD_MB = int(os.environ.get("TF_MAX_UPLOAD_MB", "30"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_MIN = int(os.environ.get("TF_MAX_DURATION_MIN", "8"))
UPLOADS_PER_DAY = int(os.environ.get("TF_UPLOADS_PER_DAY", "3"))
SESSION_DAYS = int(os.environ.get("TF_SESSION_DAYS", "7"))
COOKIE_NAME = os.environ.get("TF_COOKIE_NAME", "tf_session")
COOKIE_SECURE = os.environ.get("TF_COOKIE_SECURE", "0") == "1"

# The worker sleeps between mock stages. Set to 20-30 to feel like a real
# minute-long job during UI testing.
MOCK_STAGE_SECONDS = float(os.environ.get("TF_MOCK_STAGE_SECONDS", "2"))

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}

ACTIVE_JOB_STATUSES = ("queued", "running")


def ensure_dirs() -> None:
    for path in (DATA_DIR, UPLOAD_DIR, ASSET_DIR):
        path.mkdir(parents=True, exist_ok=True)
