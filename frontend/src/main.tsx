import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";
import { PrefsProvider } from "./prefs";
import { ToastProvider } from "./toast";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <PrefsProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </PrefsProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
