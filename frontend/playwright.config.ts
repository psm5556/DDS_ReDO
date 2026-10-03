import { defineConfig } from "@playwright/test";

// E2E: 별도 SQLite DB(e2e.db)로 백엔드를 띄우고, Vite 개발 서버가 /api를 그쪽으로 프록시한다.
// Python 경로는 REDO_PYTHON 환경변수로 지정 (기본 "python"). 브라우저는 설치된 Chrome을 사용 (다운로드 불필요).
const PY = process.env.REDO_PYTHON ?? "python";
const API_PORT = 8011;
const WEB_PORT = 5181;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: process.env.PW_CHANNEL ?? "chrome",
    locale: "ko-KR",
    viewport: { width: 1360, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `"${PY}" -m app.seed --reset && "${PY}" -m uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../backend",
      env: { REDO_DATABASE_URL: "sqlite:///./e2e.db", REDO_ENV: "dev", PYTHONIOENCODING: "utf-8" },
      url: `http://localhost:${API_PORT}/api/auth/config`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      env: { REDO_API_TARGET: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
