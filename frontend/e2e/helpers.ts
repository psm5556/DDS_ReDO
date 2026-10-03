import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const H = { "X-Requested-With": "ReDO" };

export interface RunLite { id: number; code: string; status: string; run_order: number; batch_id: number; values: Record<string, number | null> }

export async function login(page: Page, userKey = "E1001") {
  const r = await page.request.post("/api/auth/mock-login", { headers: H, data: { user_key: userKey } });
  expect(r.ok()).toBeTruthy();
}

/** 인자 2개(온도·시간), 응답 1개(수율) 프로젝트. initial=true면 초기 설계 6회(반복 없음)까지 만든다. */
export async function createProject(api: APIRequestContext, name: string, initial = true): Promise<number> {
  const r = await api.post("/api/projects", {
    headers: H,
    data: {
      name,
      config: {
        factors: [
          { key: "temp", name: "온도", unit: "°C", low: 100, high: 200, step: 1 },
          { key: "time", name: "시간", unit: "min", low: 10, high: 60, step: 5 },
        ],
        responses: [{ key: "yield", name: "수율", unit: "%", goal: "maximize", input_min: 0, input_max: 100, decimals: 1 }],
        settings: { batch_size: 3, budget_runs: 30, initial_points: 6, replicate_fraction: 0.34, replicates_per_point: 2 },
      },
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const pid = (await r.json()).id as number;
  if (initial) {
    const d = await api.post(`/api/projects/${pid}/design/initial`, { headers: H, data: { n_points: 6, replicate_fraction: 0 } });
    expect(d.ok(), await d.text()).toBeTruthy();
  }
  return pid;
}

export async function runs(api: APIRequestContext, pid: number): Promise<RunLite[]> {
  const r = await api.get(`/api/projects/${pid}/runs`);
  return ((await r.json()) as RunLite[]).sort((a, b) => a.batch_id - b.batch_id || a.run_order - b.run_order);
}

export const cell = (page: Page, row: number, col: number) => page.locator(`#cell-${row}-${col}`);

/** 엑셀에서 복사한 것처럼 붙여넣기 이벤트를 보낸다 */
export async function paste(page: Page, row: number, col: number, text: string) {
  await cell(page, row, col).focus();
  await cell(page, row, col).evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}
