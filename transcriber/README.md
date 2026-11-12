# TabForge (Phase 1)

An invite-only, local-first service that turns an audio recording into an
**auto-generated draft** guitar tab.

This is the Phase 1 skeleton: accounts, upload, background job status and a
private library. The transcription stages are mocked; Basic Pitch is connected
in the next phase.

## Input policy (important)

- Upload **audio you own or have permission to transcribe**.
- A YouTube URL is accepted only as a **reference** (title/attribution) and is
  never downloaded. The service does not use `yt-dlp` and does not ingest
  YouTube or Spotify audio.
- Drafts are private by default and intended for a class, not public
  distribution.

## What works now

- Invite-only signup, login, logout, server-side sessions
- Audio upload with limits (30 MB, 8 minutes configured, 3 uploads/day, one
  active job)
- SQLite-backed job queue and a separate worker process
- Status stages: queued → preparing → detecting → writing → ready
- Draft saved to a private library with an **Auto-generated draft** badge
- Teacher accounts see every student's drafts and can approve them
- Responsive blue-gray UI served by the same FastAPI origin

## Run locally

```bash
cd transcriber
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# optional local settings
cp .env.example .env

python -m app.db
python scripts/create_admin.py teacher          # prompts for a password
python scripts/create_invite.py --uses 5
```

Start the web app and the worker in two terminals:

```bash
# terminal 1
uvicorn app.main:app --reload --port 8000

# terminal 2
python -m app.worker
```

Open <http://127.0.0.1:8000>. Create a student with the invite code, upload an
audio file, and watch the status card. The worker process must be running.

Useful env vars:

| Variable | Default | Purpose |
|---|---|---|
| `TF_DATA_DIR` | `./data` | SQLite, uploads and assets |
| `TF_MAX_UPLOAD_MB` | `30` | hard upload limit |
| `TF_MAX_DURATION_MIN` | `8` | reserved for the ffmpeg phase |
| `TF_UPLOADS_PER_DAY` | `3` | per student |
| `TF_SESSION_DAYS` | `7` | session lifetime |
| `TF_COOKIE_SECURE` | `0` | set to `1` behind HTTPS |
| `TF_MOCK_STAGE_SECONDS` | `2` | per mock stage; use 20–30 to feel real |

## Docker

```bash
cd transcriber
docker compose up --build
docker compose exec web python scripts/create_admin.py teacher
docker compose exec web python scripts/create_invite.py --uses 5
```

The UI is at <http://127.0.0.1:8000>. The `tabforge-data` volume holds SQLite,
uploads and generated assets. Back it up regularly.

For a real deployment, put Caddy (see `Caddyfile`) in front of the `web`
service, enable HTTPS, and set `TF_COOKIE_SECURE=1`. Serve the UI and API from
one origin so session cookies and CSRF assumptions stay simple.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

The tests cover signup/login, upload, the mock worker, job status, draft
creation, invalid files/URLs and teacher approval.

## API

```text
GET    /api/health
POST   /api/auth/signup        {invite, username, password}
POST   /api/auth/login         {username, password}
POST   /api/auth/logout
GET    /api/auth/me

POST   /api/transcriptions     multipart: audio, title, artist, youtube_url
GET    /api/jobs/{id}
POST   /api/jobs/{id}/retry

GET    /api/songs
GET    /api/songs/{id}
PATCH  /api/songs/{id}         {title?, artist?, body?, approve?}
DELETE /api/songs/{id}
```

## Project layout

```text
transcriber/
  app/
    main.py            FastAPI app + static UI
    config.py          env and limits
    db.py              SQLite schema/access
    security.py        scrypt, sessions, invites
    deps.py            session → user dependency
    auth.py            signup/login/logout/me
    transcriptions.py  upload, jobs, library
    worker.py          mock background worker
  web/                 vanilla HTML/CSS/JS UI
  scripts/             create_admin, create_invite
  tests/               API + worker tests
  Dockerfile
  docker-compose.yml
  Caddyfile
```

## Next phase (not in this commit)

1. ffprobe validation + ffmpeg mono conversion
2. Basic Pitch inference and note events
3. Tempo/quantise and fretboard mapping
4. Real ASCII tab / MusicXML output, confidence and warnings
5. Optional Demucs separation, draft editor and teacher review workflow
