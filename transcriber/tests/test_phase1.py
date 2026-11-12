from __future__ import annotations

import uuid

from app import db, security, worker


def make_invite(uses: int = 3) -> str:
    code = security.new_invite_code()
    db.init_db()
    with db.db() as conn:
        conn.execute(
            "INSERT INTO invites (code_hash, created_by, uses_left, created_at, expires_at) VALUES (?, 'test', ?, ?, NULL)",
            (security.invite_hash(code), uses, security.iso()),
        )
    return code


def signup(client, username: str, password: str = "studentpass123") -> dict:
    code = make_invite()
    response = client.post(
        "/api/auth/signup",
        json={"invite": code, "username": username, "password": password},
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_login_required(client):
    assert client.get("/api/songs").status_code == 401
    assert client.get("/api/jobs/nope").status_code == 401


def test_signup_login_and_transcription_flow(client):
    username = f"alice_{uuid.uuid4().hex[:6]}"
    user = signup(client, username)
    assert user["role"] == "student"

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["username"] == username

    audio = b"RIFF....WAVEfmt "
    response = client.post(
        "/api/transcriptions",
        files={"audio": ("practice.wav", audio, "audio/wav")},
        data={
            "title": "Practice draft",
            "artist": "Student",
            "youtube_url": "https://youtu.be/dQw4w9WgXcQ",
        },
    )
    assert response.status_code == 202, response.text
    payload = response.json()

    job = worker.claim_next()
    assert job is not None
    worker.process(job)

    status = client.get(f"/api/jobs/{payload['job_id']}")
    assert status.status_code == 200
    body = status.json()
    assert body["status"] == "done"
    assert body["progress"] == 100

    song = client.get(f"/api/songs/{payload['song_id']}")
    assert song.status_code == 200
    data = song.json()
    assert data["draft"] is True
    assert data["status"] == "draft"
    assert "auto-generated draft" in data["body"].lower()
    assert data["source_url"].startswith("https://youtu.be/")

    library = client.get("/api/songs")
    assert library.status_code == 200
    assert any(item["id"] == payload["song_id"] for item in library.json()["songs"])


def test_rejects_bad_files_and_references(client):
    signup(client, f"bob_{uuid.uuid4().hex[:6]}")

    bad_file = client.post(
        "/api/transcriptions",
        files={"audio": ("notes.txt", b"hello", "text/plain")},
    )
    assert bad_file.status_code == 400

    bad_url = client.post(
        "/api/transcriptions",
        files={"audio": ("practice.wav", b"RIFF....WAVE", "audio/wav")},
        data={"youtube_url": "https://example.com/not-youtube"},
    )
    assert bad_url.status_code == 400


def test_teacher_can_see_and_approve(client):
    student_name = f"carol_{uuid.uuid4().hex[:6]}"
    signup(client, student_name)
    response = client.post(
        "/api/transcriptions",
        files={"audio": ("practice.wav", b"RIFF....WAVE", "audio/wav")},
        data={"title": "Teacher test"},
    )
    assert response.status_code == 202
    song_id = response.json()["song_id"]
    worker.process(worker.claim_next())

    admin_name = f"teacher_{uuid.uuid4().hex[:6]}"
    db.init_db()
    with db.db() as conn:
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'teacher', ?)",
            (security.new_id("usr"), admin_name, security.hash_password("teacherpass123"), security.iso()),
        )

    client.post("/api/auth/logout")
    login = client.post(
        "/api/auth/login",
        json={"username": admin_name, "password": "teacherpass123"},
    )
    assert login.status_code == 200

    library = client.get("/api/songs")
    assert library.status_code == 200
    assert any(item["id"] == song_id for item in library.json()["songs"])

    approved = client.patch(f"/api/songs/{song_id}", json={"approve": True})
    assert approved.status_code == 200
    assert approved.json()["draft"] is False
    assert approved.json()["status"] == "approved"
