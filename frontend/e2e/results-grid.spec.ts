import { expect, test, type Page } from "@playwright/test";
import { cell, createProject, login, paste, runs } from "./helpers";

// 결과 입력 그리드 E2E (CLAUDE.md 10장): 붙여넣기, 키보드 이동, 검증 메시지, 자동 저장.
// 각 테스트는 자기 프로젝트를 새로 만들어 서로 영향을 주지 않는다.

// 그리드 열 순서: 인자 실제값(temp, time) → 응답(yield) → 메모
const COL = { temp: 0, time: 1, yield: 2, note: 3 };

/** ① 실험 데이터 입력의 실험 표. 입력 칸 순서: 조건(온도·시간, 언제든 수정) → 결과 → 메모 */
async function openGrid(page: Page, pid: number) {
  await page.goto(`/projects/${pid}/step/1`);
  await expect(cell(page, 0, 0)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Enter / Shift+Enter / 화살표로 칸을 이동한다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 키보드 이동");
  await openGrid(page, pid);
  await cell(page, 0, COL.yield).click();
  await page.keyboard.press("Enter");
  await expect(cell(page, 1, COL.yield)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cell(page, 2, COL.yield)).toBeFocused();
  await page.keyboard.press("Shift+Enter");
  await expect(cell(page, 1, COL.yield)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(cell(page, 0, COL.yield)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cell(page, 1, COL.yield)).toBeFocused();
});

test("실제 세팅값은 계획값으로 미리 채워져 있다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 미리 채움");
  const rs = await runs(page.request, pid);
  const planned = (await (await page.request.get(`/api/projects/${pid}/runs/${rs[0].id}`)).json()).planned;
  await openGrid(page, pid);
  await expect(cell(page, 0, COL.temp)).toHaveValue(String(planned.temp));
  await expect(cell(page, 0, COL.time)).toHaveValue(String(planned.time));
  await expect(cell(page, 0, COL.yield)).toHaveValue("");
});

test("엑셀에서 여러 행·열을 붙여넣으면 자동 저장되고, 저장 후에도 행이 그대로 남는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 붙여넣기");
  await openGrid(page, pid);
  const before = await runs(page.request, pid);
  // 응답 + 메모 2열 × 3행 (엑셀 복사 형식: 탭 구분, CRLF 줄바꿈, 끝 줄바꿈)
  await paste(page, 0, COL.yield, "81.5\t첫째\r\n82\t둘째\r\n83.25\t셋째\r\n");
  await expect(page.getByText("3행을 붙여넣었습니다.")).toBeVisible();
  await expect(cell(page, 1, COL.yield)).toHaveValue("82");
  await expect(cell(page, 2, COL.note)).toHaveValue("셋째");

  await expect(page.getByRole("status").filter({ hasText: "저장됨" })).toBeVisible({ timeout: 15_000 });
  const after = await runs(page.request, pid);
  expect(after.slice(0, 3).map((r) => r.values.yield)).toEqual([81.5, 82, 83.25]);
  expect(after.slice(0, 3).every((r) => r.status === "done")).toBeTruthy();
  expect(after.slice(3).every((r) => r.values.yield == null)).toBeTruthy();

  // '남은 실험만' 필터가 켜져 있어도, 방금 입력한 행이 저장 후 사라지거나 순서가 밀리면 안 된다
  await expect(cell(page, 0, COL.yield)).toHaveValue("81.5");
  await expect(cell(page, 2, COL.yield)).toHaveValue("83.25");
  await expect(page.locator(".grid-table tbody tr").first().locator("td").nth(1)).toContainText(before[0].code); // 0번 칸은 삭제 버튼
});

test("한 칸씩 입력하고 Enter로 내려가는 동안 자동 저장이 끼어들어도 입력 위치가 바뀌지 않는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 연속 입력");
  await openGrid(page, pid);
  await cell(page, 0, COL.yield).click();
  await page.keyboard.type("70");
  await page.keyboard.press("Enter");
  // 자동 저장(1.5초)이 끝날 때까지 기다린 뒤 다음 칸 입력
  await expect(page.getByRole("status").filter({ hasText: "저장됨" })).toBeVisible({ timeout: 15_000 });
  const codes = (await runs(page.request, pid)).map((r) => r.code);
  await expect(page.locator("input:focus")).toHaveAttribute("aria-label", `${codes[1]} 수율`);
  await page.keyboard.type("71");
  await page.keyboard.press("Enter");
  await expect(page.locator("input:focus")).toHaveAttribute("aria-label", `${codes[2]} 수율`);
  await expect(page.getByRole("status").filter({ hasText: "저장됨" })).toBeVisible({ timeout: 15_000 });
  // 저장된 행도 화면에 남아 있어야 함
  await expect(cell(page, 0, COL.yield)).toHaveValue("70");
  await expect.poll(async () => (await runs(page.request, pid)).slice(0, 3).map((r) => r.values.yield), { timeout: 15_000 })
    .toEqual([70, 71, null]);
});

test("숫자가 아닌 값은 빨간 칸으로 표시하고 저장하지 않는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 형식 오류");
  await openGrid(page, pid);
  await cell(page, 0, COL.yield).fill("8a");
  await expect(cell(page, 0, COL.yield).locator("..")).toHaveClass(/\bbad\b/);
  await page.waitForTimeout(2500); // 자동 저장 주기 이후에도
  expect((await runs(page.request, pid))[0].values.yield).toBeNull();

  await cell(page, 0, COL.yield).fill("80");
  await expect(cell(page, 0, COL.yield).locator("..")).not.toHaveClass(/\bbad\b/);
  await expect.poll(async () => (await runs(page.request, pid))[0].values.yield, { timeout: 15_000 }).toBe(80);
});

test("허용 범위 밖 값은 차단하지 않고 경고를 띄운다 (단위 오타 의심)", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 범위 경고");
  await openGrid(page, pid);
  await cell(page, 0, COL.yield).fill("820"); // 82%를 820으로 잘못 친 경우
  await expect(cell(page, 0, COL.yield).locator("..")).toHaveClass(/\bsoft\b/);
  const alert = page.getByRole("alert").filter({ hasText: "확인이 필요한 입력" });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("입력 허용 범위를 벗어났습니다");
  expect((await runs(page.request, pid))[0].values.yield).toBe(820);
});

test("계획과 다른 실제 세팅값은 강조 표시된다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 계획 차이");
  await openGrid(page, pid);
  const planned = await cell(page, 0, COL.temp).inputValue();
  const changed = String(Number(planned) === 200 ? 199 : Number(planned) + 1);
  await cell(page, 0, COL.temp).fill(changed);
  await expect(cell(page, 0, COL.temp).locator("..")).toHaveClass(/\bdev\b/);
});

test("상태는 자동(대기·완료), 못 한 실험은 '못 함'으로 실패·실행불가 표시 후 되돌리기", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 못 함");
  await openGrid(page, pid);
  const status = page.getByLabel(`${(await runs(page.request, pid))[0].code} 상태`);
  await expect(status).toContainText("대기");
  await expect(page.locator(".grid-table select")).toHaveCount(0); // 상태 선택 상자 없음
  await status.getByRole("button", { name: "못 함" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("radio", { name: /실행 불가/ }).click();
  await dlg.getByRole("button", { name: "표시" }).click();
  await expect(status).toContainText("실행불가");
  expect((await runs(page.request, pid))[0].status).toBe("infeasible");
  await status.getByRole("button", { name: "되돌리기" }).click();
  await expect(status).toContainText("대기");
  await cell(page, 0, COL.yield).fill("77");
  await expect(status).toContainText("완료", { timeout: 15_000 });
});
