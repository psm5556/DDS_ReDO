import { expect, test, type Page } from "@playwright/test";
import { createProject, login, runs } from "./helpers";

// 엑셀 ↔ 웹앱은 파일 대신 클립보드로 주고받는다 (사내 보안 정책상 엑셀·CSV 파일은 업로드해도 읽을 수 없음).

/** 입력 칸이 아닌 곳에 포커스를 두고 Ctrl+V 한 것과 같은 붙여넣기 이벤트 */
async function pasteOnPage(page: Page, text: string) {
  await page.evaluate((t) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

const valueOf = async (page: Page, pid: number, code: string) =>
  (await runs(page.request, pid)).find((r) => r.code === code)?.values.yield ?? null;

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("실험 표 하나에 조건(인자별 열)과 결과가 함께 있다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 통합 표");
  await page.goto(`/projects/${pid}/step/1`);
  const head = page.locator(".grid-table thead th");
  await expect(head).toHaveText([/삭제/, /런 ID/, /순서/, /온도/, /시간/, /수율/, /반복/, /메모/, /상태/]);
  // 조건 칸은 언제든 바로 고칠 수 있다 (별도 체크 없음), 구분은 메모 바로 앞
  await expect(page.getByLabel("계획과 다르게 세팅한 값 입력")).toHaveCount(0);
  await expect(page.locator("#cell-0-0")).toBeEditable();
  // 전체 기록에서도 같은 표 하나 (실험 계획 표가 따로 없음)
  await page.goto(`/projects/${pid}/experiments`);
  await expect(page.locator("table")).toHaveCount(1);
  await expect(page.locator(".grid-table thead th").nth(3)).toContainText("온도");
});

test("머리글 행과 런 ID 열을 같이 복사해 붙여넣으면 순서가 달라도 맞는 칸에 들어간다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 머리글 붙여넣기");
  await page.goto(`/projects/${pid}/step/1`);
  await expect(page.locator(".grid-table")).toBeVisible();
  // 엑셀에서 순서를 바꿔 적은 경우 + 빈 칸은 기존 값을 지우지 않음
  await pasteOnPage(page, "런 ID\t메모\t수율 [%]\n1차-03\t세 번째\t77.5\n1차-01\t\t70\n");
  await expect(page.getByText(/2행을 붙여넣었습니다 \(머리글로 열을 맞춤, 런 ID로 행을 맞춤\)/)).toBeVisible();
  await expect.poll(() => valueOf(page, pid, "1차-03"), { timeout: 15_000 }).toBe(77.5);
  expect(await valueOf(page, pid, "1차-01")).toBe(70);
  expect(await valueOf(page, pid, "1차-02")).toBeNull();
});

test("런 ID만 앞에 붙은 값도 런 ID로 맞춰 결과 칸에 넣는다 (예전 형식 B1-02도 인식)", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 런 ID 붙여넣기");
  await page.goto(`/projects/${pid}/step/1`);
  await expect(page.locator(".grid-table")).toBeVisible();
  await pasteOnPage(page, "1차-04\t64.2\nB1-02\t61\n");
  await expect.poll(() => valueOf(page, pid, "1차-04"), { timeout: 15_000 }).toBe(64.2);
  expect(await valueOf(page, pid, "1차-02")).toBe(61);
});

test("표에 없는 런 ID는 건너뛰고 알려 준다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 없는 런 ID");
  await page.goto(`/projects/${pid}/step/1`);
  await expect(page.locator(".grid-table")).toBeVisible();
  await pasteOnPage(page, "런 ID\t수율\n9차-99\t50\n1차-01\t55\n");
  await expect(page.getByText(/1행을 붙여넣었습니다.*표에 없는 런 ID 1개는 건너뜀/)).toBeVisible();
  await expect.poll(() => valueOf(page, pid, "1차-01"), { timeout: 15_000 }).toBe(55);
});

test("표 복사 → 엑셀에서 결과 채움 → 다시 붙여넣기 왕복", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pid = await createProject(page.request, "E2E 표 복사 왕복");
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: "표 일괄 복사" }).click();
  await expect(page.getByText(/표 6행을 복사했습니다/)).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const lines = copied.split(/\r?\n/); // Windows 클립보드는 CRLF
  expect(lines[0]).toBe("런 ID\t순서\t온도 [°C]\t시간 [min]\t수율 [%]\t메모\t상태");
  expect(lines).toHaveLength(7);
  // 엑셀에서 수율 칸을 채운 것처럼 바꿔 다시 붙여넣기
  const filled = [lines[0], ...lines.slice(1).map((l, i) => { const c = l.split("\t"); c[4] = String(60 + i); return c.join("\t"); })].join("\n");
  await pasteOnPage(page, filled);
  await expect(page.getByRole("heading", { name: "모든 결과가 입력되었습니다" })).toBeVisible({ timeout: 20_000 });
  expect((await runs(page.request, pid)).map((r) => r.values.yield).sort()).toEqual([60, 61, 62, 63, 64, 65]);
});

test("엑셀 파일 업로드는 없다 (보안 정책상 읽을 수 없음)", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 파일 버튼 없음");
  for (const path of [`/projects/${pid}/step/1`, `/projects/${pid}/experiments`]) {
    await page.goto(path);
    await expect(page.locator(".grid-table")).toBeVisible();
    await expect(page.getByText(/엑셀로 결과 올리기|엑셀 양식/)).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  }
});

test("툴바: 기존 데이터 추가가 맨 왼쪽, 표 일괄 복사는 아이콘, 엑셀 파일 다운로드", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 엑셀 다운로드");
  await page.goto(`/projects/${pid}/step/1`);
  const tools = page.locator(".table-tools button");
  await expect(tools.first()).toHaveText("기존 데이터 추가");
  const copy = page.getByRole("button", { name: "표 일괄 복사" });
  await expect(copy).toHaveAttribute("title", "표 일괄 복사");
  await expect(copy).toHaveText(""); // 아이콘만
  // 입력하자마자 받아도 방금 입력한 값이 파일에 들어간다 (저장 후 다운로드)
  await page.locator("#cell-0-2").fill("77.5");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "엑셀 파일로 다운로드" }).click()]);
  expect(dl.suggestedFilename()).toBe("E2E 엑셀 다운로드_실험데이터.xlsx");
  expect((await runs(page.request, pid))[0].values.yield).toBe(77.5);
});

/** 마우스로 칸 a를 누른 채 칸 b까지 끌기 */
async function dragCells(page: Page, a: import("@playwright/test").Locator, b: import("@playwright/test").Locator) {
  const ba = (await a.boundingBox())!;
  const bb = (await b.boundingBox())!;
  await page.mouse.move(ba.x + ba.width / 2, ba.y + ba.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 5 });
  await page.mouse.up();
}

test("표에서 여러 행·열을 드래그해 Ctrl+C → 고른 칸만 엑셀 형식으로 복사", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pid = await createProject(page.request, "E2E 범위 복사");
  await page.goto(`/projects/${pid}/step/1`);
  const rows = page.locator(".grid-table tbody tr");
  await expect(rows).toHaveCount(6);
  const rs = await runs(page.request, pid);
  const td = (r: number, c: number) => rows.nth(r).locator("td").nth(c); // 0 삭제, 1 런 ID, 2 순서, 3 온도, 4 시간, 5 수율

  // 런 ID ~ 시간, 3행
  await dragCells(page, td(0, 1), td(2, 4));
  await expect(page.locator(".grid-table td[data-sel]")).toHaveCount(12);
  await page.keyboard.press("Control+C");
  await expect(page.getByText("3행 × 4열을 복사했습니다", { exact: false })).toBeVisible();
  const lines = (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/);
  expect(lines).toHaveLength(3);
  const temps = await Promise.all([0, 1, 2].map((i) => page.locator(`#cell-${i}-0`).inputValue()));
  const times = await Promise.all([0, 1, 2].map((i) => page.locator(`#cell-${i}-1`).inputValue()));
  expect(lines).toEqual([0, 1, 2].map((i) => [rs[i].code, String(rs[i].run_order), temps[i], times[i]].join("\t")));

  // Esc로 해제, 머리글을 누르면 그 열 전체(삭제 버튼 열은 복사하지 않음)
  await page.keyboard.press("Escape");
  await expect(page.locator(".grid-table td[data-sel]")).toHaveCount(0);
  await page.locator(".grid-table thead th").filter({ hasText: "온도" }).click();
  await expect(page.locator(".grid-table td[data-sel]")).toHaveCount(6);
  await page.keyboard.press("Control+C");
  const col = (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/);
  expect(col).toHaveLength(6);
  expect(col[0]).toBe(temps[0]);
});

test("범위를 고른 채 Ctrl+V 하면 그 범위의 왼쪽 위 칸부터 붙여넣는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 범위 붙여넣기");
  await page.goto(`/projects/${pid}/step/1`);
  const rows = page.locator(".grid-table tbody tr");
  await expect(rows).toHaveCount(6);
  const rs = await runs(page.request, pid);
  await dragCells(page, rows.nth(3).locator("td").nth(5), rows.nth(4).locator("td").nth(5)); // 4·5행 수율
  await pasteOnPage(page, "71\n72\n");
  await expect.poll(async () => (await runs(page.request, pid)).filter((r) => r.values.yield != null).map((r) => [r.code, r.values.yield]), { timeout: 15_000 })
    .toEqual([[rs[3].code, 71], [rs[4].code, 72]]);
});

test("설정 표(인자)에서도 드래그해 복사할 수 있다", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pid = await createProject(page.request, "E2E 설정 표 복사");
  await page.goto(`/projects/${pid}`);
  const grid = page.locator(".edit-grid").first();
  const td = (r: number, c: number) => grid.locator("tbody tr").nth(r).locator("td").nth(c); // 0 삭제, 1 #, 2 인자, 3 하한, 4 상한
  await dragCells(page, td(0, 2), td(1, 4));
  await page.keyboard.press("Control+C");
  const lines = (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/);
  expect(lines).toEqual(["온도\t100\t200", "시간\t10\t60"]);
});
