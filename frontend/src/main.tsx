import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";
import { ToastProvider } from "./toast";
// 한글 Pretendard(OFL, 앱에 포함 — 외부 CDN 없음). 글자 범위별로 필요한 조각만 내려받는다
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles.css";
import { applyTheme, initialTheme } from "./theme";
import "./layout.css";

applyTheme(initialTheme()); // 그리기 전에 적용 (밝은 화면이 잠깐 보이는 깜빡임 방지)

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
