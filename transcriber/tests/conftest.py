from __future__ import annotations

import os
import tempfile

# Configure the app before importing it.
os.environ.setdefault("TF_DATA_DIR", tempfile.mkdtemp(prefix="tabforge-test-"))
os.environ.setdefault("TF_MOCK_STAGE_SECONDS", "0")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client
