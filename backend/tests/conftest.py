import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["REDO_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["REDO_ENV"] = "test"
os.environ["REDO_CANDIDATE_POOL_SIZE"] = "800"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.seed import seed  # noqa: E402

H = {"X-Requested-With": "ReDO"}


@pytest.fixture(scope="session")
def seeded():
    seed(reset=True)
    return True


def login(client: TestClient, user_key: str) -> TestClient:
    r = client.post("/api/auth/mock-login", json={"user_key": user_key}, headers=H)
    assert r.status_code == 200, r.text
    return client


@pytest.fixture
def client_for(seeded):
    clients = []

    def make(user_key: str) -> TestClient:
        c = TestClient(app, headers=H)
        c.__enter__()
        clients.append(c)
        return login(c, user_key)

    yield make
    for c in clients:
        c.__exit__(None, None, None)
