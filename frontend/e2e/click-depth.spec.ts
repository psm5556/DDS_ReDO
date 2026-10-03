import { expect, test, type Locator, type Page } from "@playwright/test";
import { createProject, H, login } from "./helpers";

// 모든 작업은 첫 화면(로그인 직후)에서 클릭 5번 이하로 끝나야 한다. 글자 입력은 클릭으로 세지 않는다.
const MAX = 5;

function counter() {
  let n = 0;
  return {
    click: async (l: Locator, opts?: Parameters<Locator["click"]>[0]) => { n++; await l.click(opts); },
    get count() { return n; },
  };
}

async function home(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "왼쪽 목록에서 DOE를 고르세요" })).toBeVisible();
}
const sideItem = (page: Page, name: string) => page.locator(".sidebar .side-item", { hasText: name });

async function withResults(page: Page, name: string, n = 6) {
  const pid = await createProject(page.request, name);
  const rs = await (await page.request.get(`/api/projects/${pid}/runs`)).json() as { id: number }[];
  await page.request.post(`/api/projects/${pid}/results`, { headers: H, data: { rows: rs.slice(0, n).map((r, i) => ({ run_id: r.id, values: { yield: 50 + i * 3 } })) } });
  return pid;
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("새 DOE 만들기(한 페이지): 클릭 5번 이하", async ({ page }) => {
  await home(page);
  const c = counter();
  await c.click(page.locator(".sidebar").getByRole("link", { name: "새 DOE 만들기" }));
  await page.getByPlaceholder("예: Poly-Si 식각 레시피 개발").fill(`클릭 깊이 ${Date.now()}`);
  await page.getByLabel("인자 1행", { exact: true }).fill("온도");
  await page.getByLabel("하한 1행", { exact: true }).fill("100");
  await page.getByLabel("상한 1행", { exact: true }).fill("200");
  await page.getByLabel("응답 1행", { exact: true }).fill("수율");
  await c.click(page.getByRole("button", { name: "DOE 만들기" }));
  await expect(page.getByRole("heading", { name: "첫 DOE를 생성하세요" })).toBeVisible();
  expect(c.count).toBeLessThanOrEqual(MAX);
});

test("예측 공유(⋯ → 멤버·공유 → 새로 공유 모달): 클릭 5번 이하", async ({ page }) => {
  const name = `클릭 공유 ${Date.now()}`;
  await withResults(page, name);
  await home(page);
  const c = counter();
  await c.click(sideItem(page, name).getByRole("button", { name: `${name} 메뉴` }));
  await c.click(page.getByRole("menuitem", { name: "멤버·공유" }));
  await c.click(page.getByRole("button", { name: "+ 새로 공유" }));
  const dlg = page.getByRole("dialog", { name: "최적화 예측 페이지 공유" });
  await dlg.getByRole("searchbox").fill("최유나");
  await c.click(dlg.getByRole("row", { name: /최유나/ }).first());
  await c.click(dlg.getByRole("button", { name: "공유하기" }));
  await expect(page.getByRole("cell", { name: /최유나/ })).toBeVisible({ timeout: 30_000 });
  expect(c.count).toBeLessThanOrEqual(MAX);
});

test("멤버 추가(우클릭 → 멤버·공유 → 멤버 추가 모달): 클릭 5번 이하", async ({ page }) => {
  const name = `클릭 멤버 ${Date.now()}`;
  await createProject(page.request, name);
  await home(page);
  const c = counter();
  await c.click(sideItem(page, name), { button: "right" });
  await c.click(page.getByRole("menuitem", { name: "멤버·공유" }));
  await c.click(page.getByRole("button", { name: "+ 멤버 추가" }));
  const dlg = page.getByRole("dialog", { name: "멤버 추가" });
  await dlg.getByRole("searchbox").fill("이도윤");
  await c.click(dlg.getByRole("row", { name: /이도윤/ }).first());
  await c.click(dlg.getByRole("button", { name: "추가" }));
  await expect(page.getByRole("dialog", { name: /멤버·공유/ }).getByRole("cell", { name: "이도윤" })).toBeVisible();
  expect(c.count).toBeLessThanOrEqual(MAX);
});

test("런 삭제(맨 앞 삭제 버튼): 클릭 5번 이하", async ({ page }) => {
  const name = `클릭 삭제 ${Date.now()}`;
  const pid = await withResults(page, name, 1);
  await home(page);
  const c = counter();
  await c.click(sideItem(page, name).locator(".side-name"));
  await c.click(sideItem(page, name).getByRole("link", { name: /실험 데이터 입력/ }));
  const first = page.locator(".grid-table tbody tr").first();
  await expect(first.locator("td").first().getByRole("button", { name: /삭제/ })).toBeVisible(); // 맨 앞 열
  await c.click(first.getByRole("button", { name: /삭제/ }));
  await c.click(page.getByRole("dialog").getByRole("button", { name: "삭제" }));
  await expect(page.getByText(/삭제했습니다/)).toBeVisible();
  const runs = await (await page.request.get(`/api/projects/${pid}/runs`)).json() as unknown[];
  expect(runs.length).toBe(5);
  await expect(page.getByRole("button", { name: "제외…" })).toHaveCount(0);
  expect(c.count).toBeLessThanOrEqual(MAX);
});

test("설정 수정 후 저장(DOE 이름 클릭): 클릭 5번 이하", async ({ page }) => {
  const name = `클릭 설정 ${Date.now()}`;
  await createProject(page.request, name);
  await home(page);
  const c = counter();
  await c.click(sideItem(page, name).locator(".side-name"));
  await page.getByLabel("가중치 1행", { exact: true }).fill("3");
  await c.click(page.getByRole("button", { name: "설정 저장" }));
  await expect(page.getByText("설정을 저장했습니다.")).toBeVisible();
  expect(c.count).toBeLessThanOrEqual(MAX);
});

test("추천 레시피 확인 실험 → 다음 실험 확정: 클릭 5번 이하", async ({ page }) => {
  const name = `클릭 레시피 ${Date.now()}`;
  await withResults(page, name);
  await home(page);
  const c = counter();
  await c.click(sideItem(page, name).locator(".side-name"));
  await c.click(sideItem(page, name).getByRole("link", { name: /능동학습 결과/ }));
  await expect(page.getByRole("button", { name: /다음 실험 \d+건 확정/ })).toBeEnabled({ timeout: 30_000 });
  await c.click(page.getByRole("button", { name: "추천 레시피 확인 실험 3회" }));
  await c.click(page.getByRole("button", { name: /다음 실험 \d+건 확정/ }));
  await expect(page.getByText(/다음 실험 \d+건을 확정했습니다/)).toBeVisible({ timeout: 30_000 });
  expect(c.count).toBeLessThanOrEqual(MAX);
});

test("그래프(자세히 보기 안): 클릭 5번 이하", async ({ page }) => {
  const name = `클릭 그래프 ${Date.now()}`;
  await withResults(page, name);
  await home(page);
  const c = counter();
  await c.click(sideItem(page, name).locator(".side-name"));
  await c.click(sideItem(page, name).getByRole("link", { name: /능동학습 결과/ }));
  await expect(page.locator(".score-badge")).toBeVisible({ timeout: 30_000 });
  await c.click(page.getByText("자세히 보기"));
  await c.click(page.getByText(/그래프 \(평균·산포 지도/));
  await expect(page.getByRole("heading", { name: "평균과 산포 지도" })).toBeVisible({ timeout: 30_000 });
  expect(c.count).toBeLessThanOrEqual(MAX);
});
