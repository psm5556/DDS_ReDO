import { expect, test } from "@playwright/test";
import { createProject, login } from "./helpers";

// 사용 매뉴얼(HTML): 앱에서 새 창으로 열리고, 오른쪽 목차가 따라다니며 현재 위치를 강조한다

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("사이드바의 '사용 매뉴얼'을 누르면 새 창에 매뉴얼이 열리고, 목차가 따라다닌다", async ({ page }) => {
  await page.goto("/");
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator(".side-me").getByRole("button", { name: "사용 매뉴얼" }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(/\/manual\/index\.html$/);
  await expect(popup.getByRole("heading", { level: 1 })).toContainText("사용 매뉴얼");
  const toc = popup.getByRole("navigation", { name: "목차" });
  await expect(toc.locator("a[data-id]")).toHaveCount(29);
  // 그림이 실제로 불러와진다
  const img = popup.locator("main figure img").first();
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
  // 목차를 누르면 그 절로 이동하고, 목차는 화면에 붙어 있으며 그 항목이 강조된다
  await toc.getByRole("link", { name: "6. 능동학습 결과" }).click();
  await expect(toc.locator("a.on")).toHaveText("6. 능동학습 결과");
  expect(await toc.evaluate((e) => e.getBoundingClientRect().top)).toBeLessThan(120); // 따라다님 (sticky)
  await expect(popup.locator('[id="6-능동학습-결과"]')).toBeInViewport();
  // 목차 검색
  await toc.getByRole("searchbox", { name: "목차 검색" }).fill("다크");
  await expect(toc.locator("a[data-id]:visible")).toHaveText(["9. 화면 꾸미기: 사이드바·다크 모드", "다크 모드"]);
});

test("DOE 화면의 '도움말'은 지금 탭에 맞는 매뉴얼 절을 연다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E 도움말");
  await page.goto(`/projects/${pid}/step/1`);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "도움말", exact: true }).click()]);
  await popup.waitForLoadState();
  expect(decodeURIComponent(popup.url())).toContain("#5-실험-데이터-입력");
  await expect(popup.getByRole("navigation", { name: "목차" }).locator("a.on")).toHaveText("5. 실험 데이터 입력");
});
