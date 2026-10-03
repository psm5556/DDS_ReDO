import { expect, test, type Page } from "@playwright/test";
import { createProject, H, login } from "./helpers";

// DOE 만들기·설정 한 페이지: 인자·응답을 그리드로, 외부 표를 한 번에 붙여넣기, 필수 칸 표시, 데이터가 있어도 인자 추가

async function pasteInto(page: Page, label: string, text: string) {
  const cell = page.getByLabel(label, { exact: true });
  await cell.focus();
  await cell.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("외부 표(머리글 포함)를 인자·응답 그리드에 한 번에 붙여넣어 DOE를 만든다", async ({ page }) => {
  await page.goto("/new");
  const name = `E2E 붙여넣기 DOE ${Date.now()}`;
  await page.getByPlaceholder("예: Poly-Si 식각 레시피 개발").fill(name);
  // 열 순서가 달라도, 행이 모자라도 된다
  await pasteInto(page, "인자 1행", "인자\t하한\t상한\t단위\t세팅 정밀도\nRF 파워\t200\t800\tW\t10\n압력\t10\t80\tmTorr\t1\nCl2 유량\t20\t120\tsccm\t5\n");
  await expect(page.getByLabel("인자 3행", { exact: true })).toHaveValue("Cl2 유량");
  await expect(page.getByLabel("상한 2행", { exact: true })).toHaveValue("80");
  await expect(page.locator(".edit-grid").first().getByLabel("단위 1행", { exact: true })).toHaveValue("W");
  // 응답: 목표·기준 같은 선택 칸도 글자로 붙여넣기 (망목 / 규격 만족 확률 / 망소)
  await pasteInto(page, "응답 1행", "응답\t단위\t목표\t목표값\tLSL\tUSL\t최적화 기준\t가중치\n식각률\tnm/min\t망목\t320\t300\t340\t규격 만족 확률\t2\n균일도\t%\t망소\t\t\t4.5\t자동\t1\n");
  await expect(page.getByLabel("목표 1행", { exact: true })).toHaveValue("target");
  await expect(page.getByLabel("최적화 기준 1행", { exact: true })).toHaveValue("spec_prob");
  await expect(page.getByLabel("목표 2행", { exact: true })).toHaveValue("minimize");
  await expect(page.getByLabel("가중치 1행", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "DOE 만들기" }).click();
  await expect(page.getByRole("heading", { name: "어떻게 시작할까요?" })).toBeVisible();
  const list = await (await page.request.get("/api/projects?scope=mine")).json() as { id: number; name: string }[];
  const p = await (await page.request.get(`/api/projects/${list.find((x) => x.name === name)!.id}`)).json();
  expect(p.config.factors.map((f: { name: string }) => f.name)).toEqual(["RF 파워", "압력", "Cl2 유량"]);
  expect(p.config.responses[0]).toMatchObject({ name: "식각률", goal: "target", target: 320, lsl: 300, usl: 340, criterion: "spec_prob", weight: 2 });
  expect(p.config.responses[1]).toMatchObject({ name: "균일도", goal: "minimize", usl: 4.5, criterion: "auto" });
});

test("필수 칸은 * 로 표시되고, 비어 있으면 저장할 때 빨갛게 강조된다", async ({ page }) => {
  await page.goto("/new");
  const factorHead = page.locator(".edit-grid").first().locator("thead th");
  for (const label of ["인자", "하한", "상한", "세팅 정밀도"]) await expect(factorHead.filter({ hasText: label }).locator(".req-mark")).toHaveCount(1);
  for (const label of ["단위", "스케일"]) await expect(factorHead.filter({ hasText: label }).locator(".req-mark")).toHaveCount(0);
  await page.getByRole("button", { name: "DOE 만들기" }).click();
  await expect(page.getByLabel("인자 1행", { exact: true }).locator("..")).toHaveClass(/\bbad\b/);
  await expect(page.locator(".edit-grid").first().getByLabel("단위 1행", { exact: true }).locator("..")).not.toHaveClass(/\bbad\b/);
  await expect(page).toHaveURL(/\/new$/); // 저장되지 않음
});

test("실험 데이터가 있는 DOE에도 인자를 추가할 수 있다 (기존 실험 값 입력)", async ({ page }) => {
  const pid = await createProject(page.request, `E2E 인자 추가 ${Date.now()}`);
  const rs = await (await page.request.get(`/api/projects/${pid}/runs`)).json() as { id: number }[];
  await page.request.post(`/api/projects/${pid}/results`, { headers: H, data: { rows: [{ run_id: rs[0].id, values: { yield: 50 } }] } });
  await page.goto(`/projects/${pid}`);
  await page.getByRole("button", { name: "인자 추가", exact: true }).click();
  await page.getByLabel("인자 3행", { exact: true }).fill("압력");
  await page.getByLabel("하한 3행", { exact: true }).fill("1");
  await page.getByLabel("상한 3행", { exact: true }).fill("5");
  await page.getByRole("button", { name: "설정 저장" }).click();
  await expect(page.getByLabel("기존 실험 값 3행", { exact: true }).locator("..")).toHaveClass(/\bbad\b/); // 기존 실험 값 필수
  await page.getByLabel("기존 실험 값 3행", { exact: true }).fill("2");
  await page.getByRole("button", { name: "설정 저장" }).click();
  await expect(page.getByText("설정을 저장했습니다.")).toBeVisible();
  const runs = await (await page.request.get(`/api/projects/${pid}/runs`)).json() as { planned: Record<string, number> }[];
  expect(runs.every((r) => Object.values(r.planned).length === 3 && Object.values(r.planned).includes(2))).toBeTruthy();
});

test("표 열 순서: 삭제 버튼이 # 앞, 단위는 맨 끝", async ({ page }) => {
  await page.goto("/new");
  for (const grid of [page.locator(".edit-grid").nth(0), page.locator(".edit-grid").nth(1)]) {
    const heads = await grid.locator("thead th").allTextContents();
    expect(heads[0]).toContain("삭제");
    expect(heads[1]).toBe("#");
    expect(heads[heads.length - 1]).toBe("단위");
    await expect(grid.locator("tbody tr").first().locator("td").first().getByRole("button", { name: "1행 삭제" })).toBeVisible();
  }
});
