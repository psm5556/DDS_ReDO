import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 시 /api 요청은 FastAPI(기본 8000)로 프록시. E2E는 REDO_API_TARGET으로 별도 백엔드를 지정한다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.REDO_API_TARGET ?? "http://localhost:8000", changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 5000 },
});
