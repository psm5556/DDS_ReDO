import { expect, test, type Page } from "@playwright/test";
import { createProject, login, runs } from "./helpers";

// 이미 해 둔 실험 데이터로 시작하기 (CLAUDE.md 5.1: 기존 실험 데이터로 시작 허용). 파일 대신 엑셀 붙여넣기.

async function pasteOnPage(page: Page, text: string) {
  await page.evaluate((t) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

// 순서가 다르고, 단위가 머리글에 붙어 있고, DOE에 없는 열(로트)이 섞인 엑셀 표
const TABLE = [
  "시간 [min]\t로트\t온도 [°C]\t수율 [%]\t비고",
  "20\tA\t120\t61.2\t작년 3월",
  "20\tA\t120\t63\t",
  "35\tB\t173.28\t70.4\t",
  "50\tB\t230\t55\t",
  "45\tC\t150\t68\t",
  "15\tC\t185\t66.5\t",
].join("\r\n");

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("새 DOE를 기존 데이터로 시작: 붙여넣기 → 범위 밖 넓히기 → 가져오기 → 바로 능동학습 결과", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 기존 데이터로 시작", false);
  await page.goto(`/projects/${pid}/step/1`);
  await expect(page.getByRole("heading", { name: "어떻게 시작할까요?" })).toBeVisible();
  await page.getByRole("button", { name: /기존 데이터로 시작/ }).click();
  await pasteOnPage(page, TABLE);

  await expect(page.getByLabel("온도 1행")).toHaveValue("120");
  await expect(page.getByLabel("시간 1행")).toHaveValue("20");
  await expect(page.getByLabel("메모 1행")).toHaveValue("작년 3월");
  await expect(page.getByLabel("반복 2행")).toHaveValue("2/2"); // 같은 조건 → 반복
  await expect(page.getByLabel("온도 3행")).toHaveValue("173.28"); // 반올림하지 않음
  await expect(page.getByText("이 DOE에 없는 열은 빼고 가져왔습니다: 로트")).toBeVisible();

  // 범위 밖(온도 230) → 가져오기 막힘, 범위 넓히기
  const go = page.getByRole("button", { name: /6건 가져오기/ });
  await expect(go).toBeDisabled();
  await page.getByRole("button", { name: /범위를 온도 100~230로 넓히기/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "설정 범위 밖" })).toHaveCount(0);
  await expect(go).toBeEnabled();
  await go.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/step/2$`));
  await expect(page.getByRole("heading", { name: /추천 레시피/ }).first()).toBeVisible({ timeout: 30_000 });
  const rs = await runs(page.request, pid);
  expect(rs.map((r) => r.code)).toEqual(["0차-01", "0차-02", "0차-03", "0차-04", "0차-05", "0차-06"]);
  expect(rs.every((r) => r.status === "done")).toBeTruthy();
  const cfg = (await (await page.request.get(`/api/projects/${pid}`)).json()).config;
  expect(cfg.factors[0].high).toBe(230);
});

test("범위 밖 행은 빼고 가져올 수도 있고, 결과가 빈 행은 ① 실험 데이터 입력에 남는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 범위 밖 빼기", false);
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: /기존 데이터로 시작/ }).click();
  await pasteOnPage(page, "온도\t시간\t수율\n120\t20\t61\n230\t50\t55\n150\t45\t\n");
  await page.getByRole("button", { name: /범위 밖 1행 빼기/ }).click();
  await page.getByRole("button", { name: /2건 가져오기/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/step/1$`));
  await expect(page.locator(".grid-table tbody tr")).toHaveCount(2);
  const rs = await runs(page.request, pid);
  expect(rs.map((r) => r.status)).toEqual(["done", "planned"]);
});

test("진행 중인 DOE에도 '기존 데이터 추가'로 예전 데이터를 더할 수 있다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 기존 데이터 추가");
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: "기존 데이터 추가", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "기존 실험 데이터 추가" });
  await expect(dlg).toBeVisible();
  await pasteOnPage(page, "온도\t시간\t수율\n110\t15\t58\n");
  await expect(dlg.getByLabel("수율 1행")).toHaveValue("58");
  await dlg.getByRole("button", { name: /1건 가져오기/ }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".grid-table tbody tr").first()).toContainText("0차-01");
  const rs = await runs(page.request, pid);
  expect(rs).toHaveLength(7);
});

test("열람자에게는 가져오기가 보이지 않는다", async ({ page }) => {
  await login(page, "E1003");
  const ps = await (await page.request.get("/api/projects?scope=member")).json();
  const demo = (ps as { id: number; my_role: string }[]).find((p) => p.my_role === "viewer");
  test.skip(!demo, "열람자 권한 예제 없음");
  await page.goto(`/projects/${demo!.id}/step/1`);
  await expect(page.getByRole("button", { name: "기존 데이터 추가", exact: true })).toHaveCount(0);
});

test("새 DOE 만들기에서 '기존 데이터에서 만들기': 열마다 인자/응답을 골라 설정을 채우고, 만들면 데이터까지 가져온다", async ({ page }) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "기존 데이터에서 만들기" }).click();
  const dlg = page.getByRole("dialog", { name: "기존 데이터로 인자·응답 만들기" });
  await pasteOnPage(page, [
    "No\tRF 파워 [W]\t압력 (mTorr)\t식각률 [nm/min]\t균일도 [%]\t비고",
    "1\t300\t20\t210.5\t3.1\t첫 로트",
    "2\t300\t40\t225.1\t2.8\t",
    "3\t500\t20\t280.2\t2.2\t",
    "4\t500\t40\t301.7\t2.5\t",
    "5\t700\t20\t340.9\t3.6\t",
    "6\t700\t40\t362.4\t4.1\t",
    "7\t500\t30\t295.3\t2.05\t",
    "8\t500\t30\t291.8\t2.3\t",
  ].join("\n"));
  // 처음 고른 값: 수준이 반복되는 열 = 인자, 제각각 = 응답, No = 무시, 비고 = 메모
  await expect(dlg.getByLabel("No 구분")).toHaveValue("ignore");
  await expect(dlg.getByLabel("RF 파워 [W] 구분")).toHaveValue("factor");
  await expect(dlg.getByLabel("압력 (mTorr) 구분")).toHaveValue("factor");
  await expect(dlg.getByLabel("식각률 [nm/min] 구분")).toHaveValue("response");
  await expect(dlg.getByLabel("균일도 [%] 구분")).toHaveValue("response");
  await expect(dlg.getByLabel("비고 구분")).toHaveValue("note");
  await dlg.getByLabel("균일도 [%] 목표").selectOption("minimize");
  await dlg.getByRole("button", { name: "인자 2개 · 응답 2개로 채우기" }).click();

  await expect(page.getByLabel("인자 1행", { exact: true })).toHaveValue("RF 파워");
  await expect(page.getByLabel("하한 1행", { exact: true })).toHaveValue("300");
  await expect(page.getByLabel("상한 1행", { exact: true })).toHaveValue("700");
  await expect(page.locator(".edit-grid").first().getByLabel("단위 2행", { exact: true })).toHaveValue("mTorr");
  await expect(page.getByLabel("목표 2행", { exact: true })).toHaveValue("minimize");
  // 범위를 데이터보다 좁히면 막는다
  await page.getByLabel("상한 1행", { exact: true }).fill("600");
  await expect(page.getByText("기존 데이터의 'RF 파워' 값이 범위(300~600) 밖입니다.")).toBeVisible();
  await page.getByLabel("상한 1행", { exact: true }).fill("800");

  const name = `E2E 데이터로 만든 DOE ${Date.now()}`;
  await page.getByPlaceholder("예: Poly-Si 식각 레시피 개발").fill(name);
  await page.getByRole("button", { name: "DOE 만들기 + 데이터 8건 가져오기" }).click();
  await expect(page).toHaveURL(/\/step\/2$/);
  await expect(page.getByRole("heading", { name: /추천 레시피/ }).first()).toBeVisible({ timeout: 30_000 });
  const list = await (await page.request.get("/api/projects?scope=mine")).json() as { id: number; name: string }[];
  const pid = list.find((x) => x.name === name)!.id;
  const rs = await runs(page.request, pid);
  expect(rs).toHaveLength(8);
  expect(rs.filter((r) => r.replicate_no === 2)).toHaveLength(1); // (500, 30) 두 번 → 반복
  const detail = await (await page.request.get(`/api/projects/${pid}`)).json();
  expect(detail.config.factors.map((f: { name: string; high: number }) => [f.name, f.high])).toEqual([["RF 파워", 800], ["압력", 40]]);
});

test("표 복사한 것을 그대로 다시 가져오려 하면 중복을 알려 주고 뺄 수 있다", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pid = await createProject(page.request, "E2E 중복 가져오기");
  const rs = await runs(page.request, pid);
  await page.request.post(`/api/projects/${pid}/results`, { headers: { "X-Requested-With": "ReDO" },
    data: { rows: rs.slice(0, 2).map((r, i) => ({ run_id: r.id, values: { yield: 60 + i } })) } });
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: "표 일괄 복사" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  await page.getByRole("button", { name: "기존 데이터 추가", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "기존 실험 데이터 추가" });
  await pasteOnPage(page, copied);
  // 결과가 있는 2행도, 아직 결과가 없는 4행도 이미 표에 있는 실험과 같다
  await expect(dlg.getByText(/똑같은 행이 6개/)).toBeVisible();
  // 한 행만 결과를 바꾸면 그 행은 새 데이터
  await dlg.getByLabel("수율 1행").fill("75");
  await expect(dlg.getByText(/똑같은 행이 5개/)).toBeVisible();
  await dlg.getByRole("button", { name: "중복 5행 빼기" }).click();
  await expect(dlg.getByText(/똑같은 행이/)).toHaveCount(0);
  await expect(dlg.getByRole("button", { name: /1건 가져오기/ })).toBeEnabled();
});
