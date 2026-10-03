import { expect, test } from "@playwright/test";
import { createProject, login } from "./helpers";

// DOE 설정의 저장 막대: 평소에는 [설정 저장]만. 실험 데이터가 있는 DOE의 설정을 바꿀 때만 '변경 사유'가 나온다.
// DOE 상태(완료·보관)는 사이드바 ⋯ 메뉴에서 바꾼다.

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("변경 사유는 실험 데이터가 있는 DOE의 설정을 바꿀 때만 보인다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 변경 사유");
  await page.goto(`/projects/${pid}`);
  const foot = page.locator(".form-foot");
  await expect(foot.getByRole("button", { name: "설정 저장" })).toBeVisible();
  await expect(foot.getByRole("combobox", { name: "DOE 상태" })).toHaveCount(0);
  await expect(foot.getByRole("textbox", { name: "변경 사유" })).toHaveCount(0);
  // 이름만 바꾸면 묻지 않는다
  await page.getByLabel("DOE 이름").fill("E2E 변경 사유 (이름만)");
  await expect(foot.getByRole("textbox", { name: "변경 사유" })).toHaveCount(0);
  // 실험 계획을 바꾸면 나온다, 되돌리면 사라진다
  const batch = page.getByRole("textbox", { name: "한 번에 제안" });
  await batch.fill("5");
  await expect(foot.getByRole("textbox", { name: "변경 사유" })).toBeVisible();
  await batch.fill("3");
  await expect(foot.getByRole("textbox", { name: "변경 사유" })).toHaveCount(0);
  await batch.fill("5");
  await foot.getByRole("textbox", { name: "변경 사유" }).fill("한 번에 더 많이 실험 가능");
  await foot.getByRole("button", { name: "설정 저장" }).click();
  await expect(page.getByText("설정을 저장했습니다.")).toBeVisible();
  await expect(foot.getByRole("textbox", { name: "변경 사유" })).toHaveCount(0); // 저장하면 새 기준
  const audit = await (await page.request.get(`/api/projects/${pid}/audit`)).json();
  expect(JSON.stringify(audit)).toContain("한 번에 더 많이 실험 가능");
});

test("새 DOE(실험 데이터 없음)는 설정을 바꿔도 변경 사유를 묻지 않는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 변경 사유 없음", false);
  await page.goto(`/projects/${pid}`);
  await page.getByRole("textbox", { name: "한 번에 제안" }).fill("5");
  await expect(page.locator(".form-foot").getByRole("textbox", { name: "변경 사유" })).toHaveCount(0);
});

test("DOE 상태는 사이드바 ⋯ 메뉴에서: 완료로 표시 → 되돌리기, 보관 → 보관 해제", async ({ page }) => {
  const name = `E2E 상태 ${Date.now()}`;
  const pid = await createProject(page.request, name);
  await page.goto(`/projects/${pid}`);
  const item = page.locator(".sidebar .side-item", { hasText: name });
  const menu = async () => {
    await item.locator(".side-row").hover();
    await item.getByRole("button", { name: `${name} 메뉴` }).click();
    return page.getByRole("menu", { name: `${name} 메뉴` });
  };
  const status = async () => (await (await page.request.get(`/api/projects/${pid}`)).json()).status;

  await (await menu()).getByRole("menuitem", { name: "완료로 표시" }).click();
  await expect.poll(status).toBe("completed");
  await expect(page.locator(".proj-sub")).toContainText("완료"); // 머리글에 바로 표시
  await (await menu()).getByRole("menuitem", { name: "진행 중으로 되돌리기" }).click();
  await expect.poll(status).toBe("active");

  await (await menu()).getByRole("menuitem", { name: "보관" }).click();
  await expect.poll(status).toBe("archived");
  await expect(item).toHaveClass(/dim/);
  await (await menu()).getByRole("menuitem", { name: "보관 해제" }).click();
  await expect.poll(status).toBe("active");
});

test("실험자·보기 권한에게는 상태 메뉴가 없다", async ({ page, browser }) => {
  const name = `E2E 상태 권한 ${Date.now()}`;
  const pid = await createProject(page.request, name);
  const users = await (await page.request.get("/api/users/search?q=E2001")).json();
  const add = await page.request.post(`/api/projects/${pid}/members`, { headers: { "X-Requested-With": "ReDO" }, data: { user_id: users[0].id, role: "runner" } });
  expect(add.ok(), await add.text()).toBeTruthy();
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await login(p2, "E2001");
  await p2.goto(`/projects/${pid}/step/1`);
  const item = p2.locator(".sidebar .side-item", { hasText: name });
  await item.locator(".side-row").hover();
  await item.getByRole("button", { name: `${name} 메뉴` }).click();
  const m = p2.getByRole("menu", { name: `${name} 메뉴` });
  await expect(m.getByRole("menuitem", { name: "새 DOE로 복제" })).toBeVisible();
  await expect(m.getByRole("menuitem", { name: /완료로 표시|보관/ })).toHaveCount(0);
  await ctx.close();
});
