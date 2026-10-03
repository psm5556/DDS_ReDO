import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// 사이드바: 오른쪽 가장자리를 끌어 너비 조절, 접기/펼치기(버튼·Ctrl+B), 새로고침해도 유지

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("사이드바 너비를 드래그로 바꾸고, 두 번 누르면 기본 너비로 돌아간다", async ({ page }) => {
  await page.goto("/");
  const side = page.locator(".sidebar");
  await expect(side).toBeVisible();
  const w0 = (await side.boundingBox())!.width;
  const h = (await page.getByRole("separator", { name: "사이드바 너비 조절" }).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 120, h.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(w0 + 120));
  await page.reload();
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(w0 + 120)); // 기억
  // 너무 넓게는 못 늘림
  const h2 = (await page.getByRole("separator", { name: "사이드바 너비 조절" }).boundingBox())!;
  await page.mouse.move(h2.x + 4, h2.y + 200);
  await page.mouse.down();
  await page.mouse.move(h2.x + 900, h2.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(480);
  await page.getByRole("separator", { name: "사이드바 너비 조절" }).dblclick();
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(w0));
});

test("사이드바를 접으면 아이콘만 남고, 버튼·Ctrl+B로 다시 펼친다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "사이드바 접기" }).click();
  const rail = page.locator(".sidebar.rail");
  await expect(rail).toBeVisible();
  expect(Math.round((await rail.boundingBox())!.width)).toBe(56);
  await expect(page.getByRole("searchbox", { name: "DOE 검색" })).toHaveCount(0);
  await expect(rail.getByRole("link", { name: "새 DOE 만들기" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".sidebar.rail")).toBeVisible(); // 기억
  await page.getByRole("button", { name: "사이드바 펼치기" }).click();
  await expect(page.getByRole("searchbox", { name: "DOE 검색" })).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar.rail")).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("searchbox", { name: "DOE 검색" })).toBeVisible();
});

test("어두운 화면으로 바꾸면 기억되고, 주 버튼 색은 그대로", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  const btn = page.locator(".side-me").getByRole("button", { name: /화면으로/ });
  if (before === "dark") await btn.click(); // 시작을 밝은 화면으로 맞춤
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.locator(".side-me").getByRole("button", { name: "어두운 화면으로" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(14, 14, 16)");
  await expect(page.locator(".side-new")).toHaveCSS("background-color", "rgb(37, 99, 235)"); // 기존 파랑 유지
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.locator(".side-me").getByRole("button", { name: "밝은 화면으로" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
});
