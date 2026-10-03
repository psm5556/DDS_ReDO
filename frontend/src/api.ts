export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function messageFrom(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
    if (Array.isArray(detail)) {
      // Pydantic 검증 오류
      const first = detail[0] as { msg?: string; loc?: unknown[] } | undefined;
      if (first?.msg) return first.msg.replace(/^Value error, /, "");
    }
  }
  if (status === 401) return "로그인이 필요합니다.";
  if (status >= 500) return "서버에서 문제가 발생했습니다. 잠시 후 다시 시도하세요.";
  return "요청을 처리하지 못했습니다.";
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "ReDO" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, credentials: "include" });
  } catch {
    throw new ApiError(0, "서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.", null);
  }
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = (await res.json()).detail;
    } catch { /* 본문 없음 */ }
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      const back = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?return_to=${back}`);
    }
    throw new ApiError(res.status, messageFrom(detail, res.status), detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, body?: unknown) => api<T>(p, { method: "POST", body: body ?? {} });
export const patch = <T,>(p: string, body: unknown) => api<T>(p, { method: "PATCH", body });
export const del = <T,>(p: string) => api<T>(p, { method: "DELETE" });
