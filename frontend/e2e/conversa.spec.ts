import { expect, test } from "@playwright/test";
import { createProject, login, runs } from "./helpers";

// DDS Conversa: 가짜 Ollama(scripts/mock_ollama.py)로 대화 → 확인 카드 → 실행 흐름을 확인한다

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("대화로 DOE 상태를 묻고, 결과 입력은 확인 카드에서 [실행]을 눌러야 저장된다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E Conversa 결과 입력");
  const rs = await runs(page.request, pid);
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: "DDS Conversa 펼치기" }).click();
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  await expect(panel.getByText("DDS Conversa", { exact: true })).toBeVisible();
  await expect(panel.getByText("mock")).toBeVisible();
  const box = panel.getByRole("textbox", { name: "DDS Conversa에게 요청" });

  await box.fill("이 DOE 상태 알려줘");
  await box.press("Enter");
  await expect(panel.locator(".cv-msg.assistant").last()).toContainText("E2E Conversa 결과 입력");
  await expect(panel.locator(".cv-msg.assistant").last()).toContainText("온도, 시간");

  await box.fill(`${rs[0].code} 수율 77`);
  await box.press("Enter");
  const card = panel.getByRole("group", { name: /확인:/ });
  await expect(card).toContainText("77");
  expect((await runs(page.request, pid))[0].values.yield).toBeNull(); // 아직 저장 안 됨
  await card.getByRole("button", { name: "실행" }).click();
  await expect(panel.getByText(/✓ 실행했습니다/)).toBeVisible();
  expect((await runs(page.request, pid))[0].values.yield).toBe(77);
  await expect(page.locator("#cell-0-2")).toHaveValue("77"); // 열려 있던 실험 표도 바로 바뀐다
});

test("삭제처럼 되돌리기 어려운 작업은 '정말 실행할까요?'를 한 번 더 묻는다", async ({ page }) => {
  const pid = await createProject(page.request, "E2E Conversa 재확인");
  const rs = await runs(page.request, pid);
  await page.goto(`/projects/${pid}/step/1`);
  await page.getByRole("button", { name: "DDS Conversa 펼치기" }).click();
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  const box = panel.getByRole("textbox", { name: "DDS Conversa에게 요청" });

  await box.fill(`${rs[1].code} 지워줘`);
  await box.press("Enter");
  let card = panel.getByRole("group", { name: /확인:/ }).last();
  await expect(card).toHaveClass(/danger/);
  await card.getByRole("button", { name: "실행" }).click();
  await expect(card.getByText("정말 실행할까요?")).toBeVisible();
  await card.getByRole("button", { name: "아니오" }).click();
  await expect(card.getByText("취소함")).toBeVisible();
  expect(await runs(page.request, pid)).toHaveLength(rs.length);

  await box.fill(`${rs[1].code} 지워줘`);
  await box.press("Enter");
  card = panel.getByRole("group", { name: /확인:/ }).last();
  await card.getByRole("button", { name: "실행" }).click();
  await card.getByRole("button", { name: "네, 실행합니다" }).click();
  await expect(panel.getByText(/✓ 실행했습니다/)).toBeVisible();
  expect(await runs(page.request, pid)).toHaveLength(rs.length - 1);
});

test("대화는 계정에 저장된다: 새로고침해도 이어지고, 대화 목록에서 지난 대화를 다시 열고 이름 바꾸기·삭제", async ({ page }) => {
  const tag = `E2E 기록 ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "DDS Conversa 펼치기" }).click();
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  const box = panel.getByRole("textbox", { name: "DDS Conversa에게 요청" });
  await box.fill(`${tag} 내 DOE 목록 보여줘`);
  await box.press("Enter");
  await expect(panel.locator(".cv-msg.assistant").last()).toContainText("DOE");
  await expect(panel.locator(".cv-convbar")).toContainText(tag); // 첫 질문이 대화 제목

  // 새로고침해도 같은 대화가 그대로
  await page.reload();
  await expect(panel.locator(".cv-msg.user").first()).toContainText(`${tag} 내 DOE 목록`);
  await expect(panel.locator(".cv-msg")).toHaveCount(2);

  // 새 대화 → 빈 화면, 두 번째 대화
  await panel.getByRole("button", { name: "새 대화" }).click();
  await expect(panel.getByText("무엇을 도와드릴까요?")).toBeVisible();
  await box.fill(`${tag} 둘째 결과 입력은 어떻게 해?`);
  await box.press("Enter");
  await expect(panel.locator(".cv-msg.assistant")).toHaveCount(1);

  // 대화 목록: 두 대화 모두 있고(최근 것이 위), 첫 대화를 열면 그 내용
  await panel.getByRole("button", { name: "대화 목록" }).click();
  const list = panel.getByRole("region", { name: "대화 목록" });
  await list.getByRole("searchbox", { name: "대화 찾기" }).fill(tag);
  await expect(list.locator(".cv-conv")).toHaveCount(2);
  await expect(list.locator(".cv-conv").first()).toContainText("둘째");
  await list.locator(".cv-conv-open").filter({ hasText: `${tag} 내 DOE 목록` }).click();
  await expect(panel.locator(".cv-msg.user").first()).toContainText(`${tag} 내 DOE 목록`);
  await expect(panel.locator(".cv-msg")).toHaveCount(2);

  // 이름 바꾸기
  await panel.getByRole("button", { name: "대화 목록" }).click();
  await list.getByRole("searchbox", { name: "대화 찾기" }).fill(tag);
  await list.locator(".cv-conv").filter({ hasText: "둘째" }).hover();
  await list.getByRole("button", { name: new RegExp("둘째.*이름 바꾸기") }).click();
  await list.getByRole("textbox", { name: "대화 이름" }).fill(`${tag} 사용법 질문`);
  await list.getByRole("textbox", { name: "대화 이름" }).press("Enter");
  await expect(list.locator(".cv-conv").filter({ hasText: "사용법 질문" })).toHaveCount(1);
  // 삭제는 한 번 더 눌러야 지워진다
  const row = list.locator(".cv-conv").filter({ hasText: "사용법 질문" });
  await row.hover();
  await row.getByRole("button", { name: /삭제$/ }).click();
  await row.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(list.locator(".cv-conv")).toHaveCount(1);
});

test("MCP 연결: 개인 토큰을 만들면 한 번만 보여 주고, 폐기할 수 있다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "DDS Conversa 펼치기" }).click();
  await page.getByRole("button", { name: "MCP 연결" }).click();
  const dlg = page.getByRole("dialog", { name: /MCP 연결/ });
  await expect(dlg.getByRole("textbox", { name: "MCP 서버 주소" })).toHaveValue(/\/mcp$/);
  await dlg.getByRole("button", { name: "토큰 만들기" }).click();
  const tok = dlg.getByRole("textbox", { name: "새 토큰" });
  await expect(tok).toHaveValue(/^redo_/);
  const raw = await tok.inputValue();
  await expect(dlg.locator(".code-block")).toContainText(raw);
  // 발급한 토큰으로 MCP에 접속된다
  const r = await page.request.post("/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { Authorization: `Bearer ${raw}` } });
  expect((await r.json()).result.tools.length).toBe(23);
  await dlg.getByRole("button", { name: "폐기" }).first().click();
  await expect(dlg.getByText("아직 없습니다.")).toBeVisible();
  const r2 = await page.request.post("/mcp", { data: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { Authorization: `Bearer ${raw}` } });
  expect(r2.status()).toBe(401);
});

test("DDS Conversa는 오른쪽 사이드바: 접기·펼치기(버튼·Ctrl+J), 왼쪽 가장자리 드래그로 너비 조절, 새로고침해도 유지", async ({ page }) => {
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "DDS Conversa (접힘)" });
  await expect(rail).toBeVisible(); // 처음에는 접혀 있음 (아이콘 막대)
  expect(Math.round((await rail.boundingBox())!.width)).toBe(48);
  await rail.getByRole("button", { name: "DDS Conversa 펼치기" }).click();
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  await expect(panel).toBeVisible();
  const w0 = Math.round((await panel.boundingBox())!.width);
  expect(w0).toBe(400);
  // 화면 오른쪽에 붙어 있고 본문을 덮지 않는다 (본문 영역이 그만큼 줄어듦)
  const main = (await page.locator(".app-main").boundingBox())!;
  expect(Math.round(main.x + main.width)).toBeLessThanOrEqual(Math.round((await panel.boundingBox())!.x) + 1);
  // 왼쪽 가장자리를 왼쪽으로 끌면 넓어진다
  const h = (await page.getByRole("separator", { name: "DDS Conversa 너비 조절" }).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 300);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 120, h.y + 300, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(w0 + 120);
  await page.reload();
  await expect.poll(async () => Math.round((await page.getByRole("complementary", { name: "DDS Conversa" }).boundingBox())!.width)).toBe(w0 + 120);
  await page.getByRole("separator", { name: "DDS Conversa 너비 조절" }).dblclick();
  await expect.poll(async () => Math.round((await page.getByRole("complementary", { name: "DDS Conversa" }).boundingBox())!.width)).toBe(400);
  // 접기 버튼, Ctrl+J
  await page.getByRole("button", { name: "DDS Conversa 접기" }).click();
  await expect(rail).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("complementary", { name: "DDS Conversa" })).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(rail).toBeVisible();
});
