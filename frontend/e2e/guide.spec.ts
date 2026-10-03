import { expect, test } from "@playwright/test";
import { createProject, login, paste, runs } from "./helpers";

// 사이클: ① 실험 데이터 입력(첫 DOE 생성 포함) → ② 능동학습 결과(다목적 레시피 최적화 + 추가 DOE 제안·확정) → 다음 차수 ①
// ① 표의 입력 칸 순서: 조건(temp, time) → 응답(yield) → 메모
const G = { yield: 2, note: 3 };

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("첫 DOE 생성 → ① 결과 입력 → ② 능동학습 결과·추가 DOE 확정 → 다음 차수 ①", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 사이클", false);
  await page.goto(`/projects/${pid}/step/1`);
  await expect(page.getByRole("heading", { name: "첫 DOE를 생성하세요" })).toBeVisible();
  await page.getByRole("button", { name: "첫 DOE 생성 →" }).click();

  // ① 실험 데이터 입력: 인쇄와 결과 입력이 한 화면
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/step/1$`));
  await expect(page.getByRole("heading", { name: /실험 \d+건의 결과를 입력하세요/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "실험 시트 인쇄 (QR)" })).toBeVisible();
  const first = await runs(page.request, pid);
  const lines = first.map((_, i) => `${(50 + 7 * Math.sin(i) + i).toFixed(1)}\t`).join("\n");
  await paste(page, 0, G.yield, lines);
  await expect(page.getByRole("heading", { name: "모든 결과가 입력되었습니다" })).toBeVisible({ timeout: 20_000 });

  // ② 능동학습 결과: 레시피 최적화와 추가 DOE 제안이 한 페이지
  await page.getByRole("button", { name: "다음: 능동학습 →" }).click();
  await expect(page).toHaveURL(new RegExp(`/step/2$`));
  await expect(page.locator(".score-badge")).toContainText("목표 달성", { timeout: 30_000 });
  await expect(page.locator(".plain-resp")).toHaveCount(1); // 응답마다 쉬운 말 한 줄
  await expect(page.getByRole("heading", { name: /다음에 할 실험/ })).toBeVisible();
  const confirm = page.getByRole("button", { name: /다음 실험 \d+건 확정/ });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "1행 삭제" }).last().click();
  await page.getByRole("button", { name: "다음 실험 2건 확정 → 실험 데이터 입력" }).click();
  await expect(page).toHaveURL(new RegExp(`/step/1$`));
  await expect(page.getByRole("heading", { name: "2차 실험 2건의 결과를 입력하세요" })).toBeVisible();
  expect((await runs(page.request, pid)).length).toBe(first.length + 2);
});

test("② 추천 레시피의 확인 실험을 다음 실험에 넣는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 확인 실험");
  const rs = await runs(page.request, pid);
  await page.request.post(`/api/projects/${pid}/results`, { headers: { "X-Requested-With": "ReDO" },
    data: { rows: rs.map((r, i) => ({ run_id: r.id, values: { yield: 55 + 4 * Math.cos(i) } })) } });
  await page.goto(`/projects/${pid}/step/2`);
  await expect(page.getByRole("button", { name: /다음 실험 \d+건 확정/ })).toBeEnabled({ timeout: 30_000 });
  const before = Number((await page.getByRole("button", { name: /다음 실험 \d+건 확정/ }).textContent())!.match(/(\d+)건/)![1]);
  await page.getByRole("button", { name: "추천 레시피 확인 실험 3회" }).click();
  await expect(page.getByRole("button", { name: `다음 실험 ${before + 3}건 확정 → 실험 데이터 입력` })).toBeVisible();
  await expect.poll(() => page.locator('input[aria-label^="이유 "]').evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).value === "확인 실험").length)).toBe(3);
  // 대안·신뢰도·그래프는 '자세히 보기' 안에만 있다
  await expect(page.getByText("다른 선택지")).toHaveCount(0);
  await page.getByText("자세히 보기").click();
  await expect(page.getByRole("heading", { name: /모델 신뢰도/ })).toBeVisible();
});

test("결과가 일부만 들어와도 확인을 거쳐 ②로 갈 수 있다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 부분 완료");
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: "다음: 능동학습 →" }).click();
  const dlg = page.getByRole("dialog", { name: "아직 결과가 없는 실험이 있습니다" });
  await expect(dlg).toContainText("6건");
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(page).toHaveURL(new RegExp(`/step/1$`));
  await page.getByRole("button", { name: "다음: 능동학습 →" }).click();
  await page.getByRole("button", { name: "그래도 다음으로" }).click();
  await expect(page).toHaveURL(new RegExp(`/step/2$`));
  await expect(page.locator(".stepper li").first()).toHaveClass(/partial/);
  await expect(page.locator(".stepper li").first()).toContainText("결과 6건 남음");
});

test("사이드바: DOE 이름 = 설정, 펼치면 두 단계, 표식·검색·즐겨찾기(⋯ 메뉴·우클릭)", async ({ page }) => {
  const name = `E2E 사이드바 ${Date.now()}`;
  const pid = await createProject(page.request, name);
  await page.goto("/");
  const side = page.locator(".sidebar");
  await side.getByRole("searchbox", { name: "DOE 검색" }).fill(name);
  const item = () => side.locator(".side-item", { hasText: name });
  await expect(item()).toHaveCount(1);
  await expect(item().locator(".mark.role-owner")).toHaveText("소유자");
  await expect(item().locator(".side-next")).toContainText("결과 입력 · 6건 남음");

  await item().locator(".side-name").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}$`));
  await expect(page.getByRole("heading", { name: "DOE 설정" })).toBeVisible();

  const steps = item().locator(".side-steps");
  await expect(steps.locator("li")).toHaveText([/실험 데이터 입력/, /능동학습 결과/]);
  await expect(steps.locator("li.todo")).toContainText("실험 데이터 입력");
  await steps.getByRole("link", { name: /능동학습 결과/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/step/2$`));
  await expect(steps.getByRole("link", { name: /능동학습 결과/ })).toHaveAttribute("aria-current", "page");

  await item().getByRole("button", { name: `${name} 메뉴` }).click();
  await page.getByRole("menuitem", { name: "즐겨찾기 추가" }).click();
  await expect(side.locator(".side-group", { hasText: "즐겨찾기" }).locator(".side-item", { hasText: name })).toBeVisible();
  await page.reload();
  await side.getByRole("searchbox", { name: "DOE 검색" }).fill(name);
  await expect(item().getByLabel("즐겨찾기", { exact: true })).toBeVisible();
  await side.getByRole("tab", { name: "즐겨찾기" }).click();
  await expect(item()).toBeVisible();

  await item().click({ button: "right" });
  await expect(page.getByRole("menu", { name: `${name} 메뉴` })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "멤버·공유" })).toBeVisible();
});

test("열람자는 ① 입력을 못 하고 ②에서 추가 DOE 제안이 보이지 않는다", async ({ page }) => {
  await login(page, "E1003"); // 데모 프로젝트의 열람자
  const list = await (await page.request.get("/api/projects?scope=member")).json() as { id: number; name: string }[];
  const demo = list.find((p) => p.name.includes("데모"))!;
  await page.goto(`/projects/${demo.id}/step/1`);
  await expect(page.locator(".stepper li").first().getByRole("button")).toBeDisabled();
  await expect(page.locator(".stepper li.now")).toContainText("능동학습 결과");
  await expect(page.locator(".score-badge")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /다음에 할 실험/ })).toHaveCount(0);
});

test("중복 화면 없음, 예전 주소는 해당 화면으로", async ({ page }) => {
  const pid = await createProject(page.request, `E2E 중복 없음 ${Date.now()}`);
  for (const path of ["/", `/projects/${pid}`, `/projects/${pid}/step/1`]) {
    await page.goto(path);
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.getByText(/전체 기록|할 일 모아 보기|모든 DOE 표|휴지통/)).toHaveCount(0);
  }
  for (const [from, to] of [["experiments", "/step/1"], ["step/3", "/step/2"], ["recipe", "/step/2"], ["overview", ""]] as const) {
    await page.goto(`/projects/${pid}/${from}`);
    await expect(page).toHaveURL(new RegExp(`/projects/${pid}${to}$`));
  }
});

test("전문가 모드 스위치가 없고, 두 번째 예제 DOE(CMP, 응답 3개)가 있다", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".mode-toggle")).toHaveCount(0);
  await expect(page.getByText(/전문가 모드/)).toHaveCount(0);
  const cmp = page.locator(".sidebar .side-item", { hasText: "CMP 슬러리 배합 최적화 (데모)" });
  await expect(cmp).toBeVisible();
  await cmp.locator(".side-name").click();
  await cmp.getByRole("link", { name: /능동학습 결과/ }).click();
  await expect(page.locator(".plain-resp")).toHaveCount(3, { timeout: 30_000 });
});

test("② 다음 실험 표는 그리드: 외부 표를 붙여넣으면 행이 추가되고, 범위 밖 값은 빨갛게", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 다음 실험 그리드");
  const rs = await runs(page.request, pid);
  await page.request.post(`/api/projects/${pid}/results`, { headers: { "X-Requested-With": "ReDO" },
    data: { rows: rs.map((r, i) => ({ run_id: r.id, values: { yield: 55 + 4 * Math.cos(i) } })) } });
  await page.goto(`/projects/${pid}/step/2`);
  const confirm = page.getByRole("button", { name: /다음 실험 \d+건 확정/ });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  const before = Number((await confirm.textContent())!.match(/(\d+)건/)![1]);
  await page.getByRole("button", { name: "조건 추가" }).click();
  const row = before + 1;
  const cell = page.getByLabel(`온도 ${row}행`, { exact: true });
  await cell.focus();
  await cell.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "온도\t시간\n150\t30\n160\t35\n999\t20\n");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  // 머리글 행이 있으면 첫 행부터 열 이름으로 맞추므로, 위 3줄이 1~3행을 덮어쓴다
  await expect(page.getByLabel("온도 1행", { exact: true })).toHaveValue("150");
  await expect(page.getByLabel("시간 2행", { exact: true })).toHaveValue("35");
  await expect(page.getByLabel("온도 3행", { exact: true }).locator("..")).toHaveClass(/\bbad\b/); // 999는 범위 밖
  await expect(confirm).toBeDisabled();
  await page.getByLabel("온도 3행", { exact: true }).fill("170");
  await page.getByLabel(`온도 ${row}행`, { exact: true }).fill("120");
  await page.getByLabel(`시간 ${row}행`, { exact: true }).fill("40");
  await expect(page.getByRole("button", { name: `다음 실험 ${row}건 확정 → 실험 데이터 입력` })).toBeEnabled();
});

test("② 자세히 보기: 안쪽 항목을 닫아도 내용이 사라지지 않고, 시뮬레이션은 모든 응답을 함께 예측", async ({ page }) => {
  await page.goto("/");
  const ps = await (await page.request.get("/api/projects?scope=mine")).json() as { id: number; name: string }[];
  const cmp = ps.find((p) => p.name.includes("CMP"))!;
  await page.goto(`/projects/${cmp.id}/step/2`);
  await expect(page.locator(".score-badge")).toBeVisible({ timeout: 30_000 });
  await page.getByText("자세히 보기").click();
  await page.getByText("조건 시뮬레이션").click();
  const sim = page.locator(".sim");
  await expect(sim.locator("tbody tr")).toHaveCount(3, { timeout: 30_000 }); // 제거율·디싱·결함 수
  await expect(sim.locator(".score-badge")).toContainText("목표 달성");
  await page.getByText("조건 시뮬레이션").click(); // 닫기
  await page.getByText(/그래프 \(평균/).click();
  await expect(page.getByRole("heading", { name: "평균과 산포 지도" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /모델 신뢰도/ })).toBeVisible();
});
