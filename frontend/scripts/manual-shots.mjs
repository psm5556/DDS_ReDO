// 사용 매뉴얼(docs/USER_MANUAL.md) 그림을 다시 찍는 스크립트.
// 준비: 깨끗한 데모 DB로 백엔드·프론트엔드를 띄운다 (개발 DB를 건드리지 않도록 별도 포트).
//   cd backend;  $env:REDO_DATABASE_URL="sqlite:///./manual.db"; python -m app.seed --reset; python -m uvicorn app.main:app --port 8021
//   cd frontend; $env:REDO_API_TARGET="http://localhost:8021"; npx vite --port 5191 --strictPort
//   node scripts/manual-shots.mjs            (MANUAL_BASE 로 주소 변경 가능)
// 그림 위의 주황색 번호는 매뉴얼 본문의 번호와 맞춘다.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MANUAL_BASE ?? "http://localhost:5191";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/manual/img");
mkdirSync(OUT, { recursive: true });
const H = { "X-Requested-With": "ReDO" };
const W = 1440, HGT = 900;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
const ctx = await browser.newContext({ viewport: { width: W, height: HGT }, locale: "ko-KR", deviceScaleFactor: 1 });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  PAGEERROR", e.message));

const wait = (ms) => page.waitForTimeout(ms);
const login = async (key = "E1001", p = page) => {
  const r = await p.request.post(`${BASE}/api/auth/mock-login`, { headers: H, data: { user_key: key } });
  if (!r.ok()) throw new Error("login failed");
};
const pasteInto = async (locator, text) => {
  await locator.focus();
  await locator.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
};
const pasteOnPage = (text) => page.evaluate((t) => {
  document.activeElement?.blur?.();
  const dt = new DataTransfer();
  dt.setData("text/plain", t);
  document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);

/** 주황색 테두리 + 번호 표시. items: [[locator, 번호, 여백?]] — 좌표는 문서 기준이라 스크롤과 상관없다 */
async function mark(items) {
  for (const [loc, n, pad = 4] of items) {
    const el = loc.first();
    if (!(await el.count())) { console.log(`  (표시 대상 없음: ${n})`); continue; }
    const r = await el.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; });
    await drawBox(r, n, pad);
  }
}
async function drawBox(r, n, pad = 4) {
  await page.evaluate(({ b, n, pad }) => {
    const box = document.createElement("div");
    box.className = "mn-mark";
    Object.assign(box.style, {
      position: "absolute", left: `${b.x - pad}px`, top: `${b.y - pad}px`, width: `${b.width + pad * 2}px`, height: `${b.height + pad * 2}px`,
      border: "2.5px solid #f97316", borderRadius: "10px", zIndex: 99999, pointerEvents: "none", boxShadow: "0 0 0 3px rgba(249,115,22,.15)",
    });
    const tag = document.createElement("div");
    tag.className = "mn-mark";
    tag.textContent = String(n);
    Object.assign(tag.style, {
      position: "absolute", left: `${Math.max(2, b.x - pad - 13)}px`, top: `${Math.max(2, b.y - pad - 13)}px`,
      width: "26px", height: "26px", borderRadius: "50%", background: "#f97316", color: "#fff", font: "700 14px/26px sans-serif",
      textAlign: "center", zIndex: 100000, pointerEvents: "none", boxShadow: "0 2px 6px rgba(0,0,0,.25)",
    });
    document.body.append(box, tag);
  }, { b: r, n, pad });
}
/** 두 요소를 감싸는 하나의 상자 (표의 여러 칸 범위 표시) */
async function markRange(a, b, n) {
  const ra = await a.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, r: b.right + scrollX, btm: b.bottom + scrollY }; });
  const rb = await b.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, r: b.right + scrollX, btm: b.bottom + scrollY }; });
  await drawBox({ x: ra.x, y: ra.y, width: rb.r - ra.x, height: rb.btm - ra.y }, n, 3);
}
/** 화면 높이를 잠시 늘려 긴 화면을 한 장에 (전체 페이지 캡처는 고정 막대·사이드바가 어긋남) */
async function tall(h, fn) {
  await page.setViewportSize({ width: W, height: h });
  await wait(400);
  try { await fn(); } finally { await page.setViewportSize({ width: W, height: HGT }); }
}
/** 요소 하나만 찍기 (표시는 문서에 그려져 있어 함께 찍힌다) */
async function shotEl(name, loc) {
  await loc.screenshot({ path: `${OUT}/${name}.png` });
  await clear();
  console.log(`✓ ${name}`);
}
const clear = () => page.evaluate(() => document.querySelectorAll(".mn-mark").forEach((e) => e.remove()));
async function shot(name, { full = false, clip, top = true } = {}) {
  if (top && !full && !clip) await page.evaluate(() => scrollTo(0, 0));
  await wait(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full, clip });
  await clear();
  console.log(`✓ ${name}`);
}
async function step(name, fn) {
  try { await fn(); } catch (e) { console.log(`✗ ${name}: ${e.message.split("\n")[0]}`); await clear().catch(() => {}); }
}

// ---------- 0. 한눈에 보는 사용 흐름 (그림) ----------
await step("00-cycle", async () => {
  await page.setContent(`<html><body style="margin:0;font-family:'Malgun Gothic',sans-serif;background:#f7f7f8">
  <div style="display:flex;align-items:center;justify-content:center;gap:14px;padding:36px 24px;width:1200px;box-sizing:border-box">
  ${[["1", "DOE 만들기", "인자·응답·목표를 표로 입력<br>(엑셀에서 붙여넣기)", "#18181b"],
    ["2", "첫 실험 계획", "앱이 첫 실험 조건을 제안<br>또는 기존 데이터 가져오기", "#18181b"],
    ["①", "실험 데이터 입력", "시트를 인쇄해 실험하고<br>결과를 표에 입력", "#2563eb"],
    ["②", "능동학습 결과", "추천 레시피 확인<br>다음 실험 확정", "#2563eb"]].map(([n, t, d, c], i) => `
    ${i ? '<div style="font-size:28px;color:#a1a1aa">→</div>' : ""}
    <div style="background:#fff;border:1px solid #ececef;border-radius:16px;padding:20px 22px;width:230px;text-align:center">
      <div style="width:40px;height:40px;border-radius:50%;background:${c};color:#fff;font-weight:700;font-size:18px;line-height:40px;margin:0 auto 10px">${n}</div>
      <div style="font-weight:700;font-size:17px;color:#18181b">${t}</div>
      <div style="font-size:13px;color:#71717a;margin-top:6px;line-height:1.6">${d}</div></div>`).join("")}
  </div>
  <div style="text-align:center;color:#2563eb;font-size:15px;font-weight:600;margin-top:-14px;padding-bottom:30px">
    ① → ② → ① → ② … 목표를 만족할 때까지 반복 (한 바퀴 = 1차, 2차 …)</div></body></html>`);
  await page.screenshot({ path: `${OUT}/00-cycle.png`, clip: { x: 0, y: 0, width: 1200, height: 280 } });
  console.log("✓ 00-cycle");
});

// ---------- 1. 로그인 ----------
await step("01-login", async () => {
  await page.goto(`${BASE}/login`);
  await page.locator(".user-pick button").first().waitFor();
  await mark([[page.locator(".user-pick"), 1, 6]]);
  await shot("01-login");
});

await login();

// ---------- 2. 첫 화면 ----------
await step("02-home", async () => {
  await page.goto(`${BASE}/`);
  await page.locator(".doe-card").first().waitFor();
  await wait(600);
  await mark([
    [page.locator(".sidebar .side-body"), 1, 2],
    [page.locator(".doe-card").first(), 3],
    [page.locator(".home-head .btn.primary"), 4],
    [page.locator(".home-head .btn").first(), 5],
  ]);
  await markRange(page.locator(".todo-pills span").first(), page.locator(".todo-pills span").last(), 2);
  await shot("02-home");
});

// ---------- 3. 새 DOE 만들기 ----------
const NEW_NAME = "Cu 도금 조건 최적화";
await step("03-new-doe", () => tall(1180, async () => {
  await page.goto(`${BASE}/new`);
  await page.getByPlaceholder("예: Poly-Si 식각 레시피 개발").fill(NEW_NAME);
  await page.getByRole("textbox", { name: "설명" }).fill("두께 10 μm 목표, 균일도 5% 이하").catch(() => {});
  await pasteInto(page.getByLabel("인자 1행", { exact: true }),
    "인자\t하한\t상한\t세팅 정밀도\t단위\n전류 밀도\t1\t5\t0.1\tA/dm²\n도금 시간\t10\t60\t1\tmin\n첨가제 농도\t0.5\t5\t0.1\tml/L\n");
  await pasteInto(page.getByLabel("응답 1행", { exact: true }),
    "응답\t목표\t목표값\tLSL\tUSL\t단위\n두께\t망목\t10\t9.5\t10.5\tμm\n균일도\t망소\t\t\t5\t%\n");
  await wait(400);
  const sec = page.locator(".doe-form > section");
  await mark([
    [sec.nth(0), 1],
    [sec.nth(1), 2],
    [sec.nth(2), 3],
    [sec.nth(3), 4],
    [page.locator(".form-foot button.primary"), 5],
    [page.getByRole("button", { name: "기존 데이터에서 만들기" }), 6],
  ]);
  await shot("03-new-doe");
}));

// ---------- 3-1. 기존 데이터에서 만들기 ----------
await step("04-from-data", async () => {
  await page.goto(`${BASE}/new?from=data`);
  await page.getByRole("dialog").waitFor();
  await pasteOnPage([
    "No\t전류 밀도 [A/dm²]\t도금 시간 (min)\t두께 [μm]\t균일도 [%]\t비고",
    "1\t2\t20\t8.9\t4.1\t첫 로트", "2\t2\t40\t9.8\t3.6\t", "3\t3\t20\t10.2\t3.2\t", "4\t3\t40\t10.9\t3.9\t",
    "5\t4\t20\t11.0\t4.8\t", "6\t4\t40\t11.8\t5.6\t", "7\t3\t30\t10.4\t3.0\t", "8\t3\t30\t10.1\t3.3\t",
  ].join("\n"));
  await wait(500);
  const dlg = page.getByRole("dialog");
  await mark([
    [dlg.locator("tbody tr td:nth-child(2)"), 1, 2],
    [dlg.locator("tbody tr td:nth-child(3)").nth(3), 2, 2],
    [dlg.getByRole("button", { name: /로 채우기/ }), 3],
  ]);
  // 첫 번째 '구분' 열 전체를 강조하도록 표의 열 영역을 다시 잡는다
  await shot("04-from-data");
});

// ---------- 4. 새 DOE 만들고 첫 실험 계획 ----------
let NEW_ID = 0;
await step("05-start", async () => {
  await page.goto(`${BASE}/new`);
  await page.getByPlaceholder("예: Poly-Si 식각 레시피 개발").fill(NEW_NAME);
  await pasteInto(page.getByLabel("인자 1행", { exact: true }),
    "인자\t하한\t상한\t세팅 정밀도\t단위\n전류 밀도\t1\t5\t0.1\tA/dm²\n도금 시간\t10\t60\t1\tmin\n첨가제 농도\t0.5\t5\t0.1\tml/L\n");
  await pasteInto(page.getByLabel("응답 1행", { exact: true }),
    "응답\t목표\t목표값\tLSL\tUSL\t단위\n두께\t망목\t10\t9.5\t10.5\tμm\n균일도\t망소\t\t\t5\t%\n");
  await page.locator(".form-foot button.primary").click();
  await page.getByRole("heading", { name: "어떻게 시작할까요?" }).waitFor();
  NEW_ID = Number(page.url().match(/projects\/(\d+)/)[1]);
  await wait(500);
  await mark([[page.locator(".choice").nth(0), 1], [page.locator(".choice").nth(1), 2], [page.locator(".proj-tabs"), 3, 2]]);
  await shot("05-start");
});

await step("06-import", async () => {
  await page.locator(".choice").nth(1).click();
  await pasteOnPage("전류 밀도\t도금 시간\t첨가제 농도\t두께\t균일도\t로트\n2\t20\t1\t8.9\t4.1\tA\n2\t20\t1\t9.1\t4.4\tA\n3\t40\t2.5\t10.6\t3.4\tB\n4\t30\t4\t11.2\t5.2\tC\n");
  await wait(500);
  await mark([
    [page.locator(".import-data .edit-grid"), 1],
    [page.getByText(/이 DOE에 없는 열은 빼고/), 2],
    [page.getByRole("button", { name: /건 가져오기/ }), 3],
  ]);
  await shot("06-import");
  await page.getByRole("button", { name: "취소" }).click();
});

// ---------- 5. ① 실험 데이터 입력 ----------
await step("07-step1", async () => {
  await page.locator(".choice").nth(0).click();
  await page.locator("#cell-0-0").waitFor();
  await wait(500);
  await mark([
    [page.locator(".proj-tabs"), 1, 2],
    [page.locator(".grid-table thead th").filter({ hasText: "전류 밀도" }), 2, 2],
    [page.locator(".grid-table thead th").filter({ hasText: "두께" }), 3, 2],
    [page.locator(".grid-table thead th").filter({ hasText: "반복" }), 4, 2],
    [page.locator(".status-cell").first(), 5, 2],
    [page.locator(".table-tools button").nth(0), 6],
    [page.locator(".table-tools button").nth(1), 7],
    [page.locator(".table-tools button").nth(2), 8],
    [page.getByRole("link", { name: /실험 시트 인쇄/ }), 9],
  ]);
  await shot("07-step1");
});

await step("08-paste", async () => {
  await pasteInto(page.locator("#cell-0-3"), "9.6\t4.2\n10.1\t3.8\n10.4\t3.1\n9.2\t4.9\n");
  await page.getByText("4행을 붙여넣었습니다").first().waitFor();
  await page.getByRole("status").filter({ hasText: "저장됨" }).waitFor({ timeout: 15_000 });
  const td = (r, c) => page.locator(".grid-table tbody tr").nth(r).locator("td").nth(c);
  await markRange(td(0, 6), td(3, 7), 1);
  await mark([[page.locator(".save-state"), 2]]);
  await shot("08-paste", { top: false, clip: { x: 264, y: 140, width: 1176, height: 520 } });
});

await step("09-failed", async () => {
  const row = page.locator(".grid-table tbody tr").nth(5);
  await row.getByRole("button", { name: "못 함" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByRole("radio", { name: /실행 불가/ }).click();
  await mark([[page.getByRole("dialog").locator(".seg"), 1], [page.getByRole("dialog").locator("select").first(), 2]]);
  await shot("09-failed", { top: false });
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
});

await step("10-drag-copy", async () => {
  const td = (r, c) => page.locator(".grid-table tbody tr").nth(r).locator("td").nth(c);
  const a = await td(0, 1).boundingBox(), b = await td(3, 7).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Control+C");
  await page.getByText(/행 × \d+열을 복사했습니다/).waitFor();
  await mark([[page.locator(".toast").last(), 1]]);
  await shot("10-drag-copy", { top: false, clip: { x: 264, y: 260, width: 1176, height: 640 } });
  await page.keyboard.press("Escape");
});

await step("11-print", async () => {
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/projects/${NEW_ID}/print`);
  await p2.locator(".print-sheet").waitFor();
  await p2.waitForTimeout(1500);
  await p2.screenshot({ path: `${OUT}/11-print.png`, clip: { x: 0, y: 0, width: W, height: HGT } });
  await p2.close();
  console.log("✓ 11-print");
});

// ---------- 6. ② 능동학습 결과 (데모: CMP 슬러리, 응답 3개) ----------
const list = await (await page.request.get(`${BASE}/api/projects?scope=mine`)).json();
const CMP = list.find((p) => p.name.startsWith("CMP"));
const ETCH = list.find((p) => p.name.startsWith("Poly-Si"));

await step("12-step2", () => tall(1060, async () => {
  await page.goto(`${BASE}/projects/${CMP.id}/step/2`);
  await page.locator(".gauge").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /다음 실험 \d+건 확정/ }).waitFor({ timeout: 60_000 });
  await wait(800);
  await mark([
    [page.locator(".cond-big"), 1],
    [page.locator(".plain-resps"), 2],
    [page.locator(".gauge"), 3],
    [page.locator(".block").nth(1).locator(".edit-grid"), 4],
    [page.getByRole("button", { name: /추천 레시피 확인 실험/ }), 5],
    [page.getByRole("button", { name: /다음 실험 \d+건 확정/ }), 6],
    [page.locator("details.more-all > summary"), 7],
  ]);
  await shot("12-step2");
}));

await step("13-details", async () => {
  await page.locator("details.more-all > summary").click();
  await page.getByRole("heading", { name: /모델 신뢰도/ }).waitFor();
  await wait(500);
  const sections = page.locator("details.more-all section");
  await mark([[sections.nth(0), 1], [sections.nth(1), 2], [sections.nth(2), 3]]);
  await shotEl("13-details", page.locator("details.more-all"));
});

await step("14-graphs", async () => {
  await page.locator("details.more > summary", { hasText: "그래프" }).click();
  await page.getByRole("heading", { name: "평균과 산포 지도" }).waitFor({ timeout: 60_000 });
  await wait(3500);
  await mark([[page.locator(".twin").first(), 1], [page.getByRole("heading", { name: "인자별 영향" }).locator("xpath=ancestor::*[contains(@class,'panel')][1]"), 2]]);
  await shotEl("14-graphs", page.locator("details.more", { hasText: "그래프" }));
  await page.locator("details.more > summary", { hasText: "그래프" }).click();
});

await step("15-sim", async () => {
  await page.locator("details.more > summary", { hasText: "조건 시뮬레이션" }).click();
  await page.locator(".sim").waitFor();
  await wait(2500);
  await mark([[page.locator(".sim-inputs"), 1], [page.locator(".sim-out"), 2]]);
  await shotEl("15-sim", page.locator("details.more", { hasText: "조건 시뮬레이션" }));
});

// ---------- 7. 멤버·공유 (데모: Poly-Si) ----------
await step("16-members", async () => {
  await page.goto(`${BASE}/projects/${ETCH.id}/step/1`);
  await page.getByRole("button", { name: "멤버·공유" }).click();
  await page.getByRole("dialog").waitFor();
  await wait(800);
  const d = page.getByRole("dialog");
  await mark([
    [d.getByRole("button", { name: /멤버 추가/ }), 1],
    [d.locator("select").first(), 2],
    [d.getByRole("button", { name: /새로 공유/ }), 3],
    [d.getByRole("button", { name: "링크 복사" }), 4],
  ]);
  await shot("16-members", { top: false });
});

await step("17-share", async () => {
  await page.getByRole("dialog").getByRole("button", { name: /새로 공유/ }).click();
  await page.getByRole("dialog", { name: "최적화 예측 페이지 공유" }).waitFor();
  await wait(500);
  await shot("17-share", { top: false });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

await step("18-menu", async () => {
  await page.goto(`${BASE}/`);
  const item = page.locator(".sidebar .side-item", { hasText: ETCH.name });
  await item.locator(".side-row").hover();
  await item.getByRole("button", { name: `${ETCH.name} 메뉴` }).click();
  await page.getByRole("menu").waitFor();
  await mark([[page.getByRole("menu"), 1]]);
  await shot("18-menu", { top: false, clip: { x: 0, y: 0, width: 760, height: 680 } });
  await page.keyboard.press("Escape");
});

await step("20-sidebar", async () => {
  await page.goto(`${BASE}/`);
  await page.locator(".doe-card").first().waitFor();
  await page.locator(".side-resizer").hover();
  await mark([[page.getByRole("button", { name: "사이드바 접기" }), 1], [page.locator(".side-resizer"), 2, 2]]);
  await shot("20-sidebar", { clip: { x: 0, y: 0, width: 720, height: 420 } });
  await page.getByRole("button", { name: "사이드바 접기" }).click();
  await page.locator(".sidebar.rail").waitFor();
  await wait(300);
  await mark([[page.locator(".sidebar.rail"), 1, 2]]);
  await shot("21-sidebar-rail", { clip: { x: 0, y: 0, width: 720, height: 420 } });
  await page.getByRole("button", { name: "사이드바 펼치기" }).click();
});

await step("22-dark", async () => {
  await page.goto(`${BASE}/projects/${CMP.id}/step/2`);
  await page.locator(".gauge").waitFor({ timeout: 60_000 });
  await page.locator(".side-me").getByRole("button", { name: "어두운 화면으로" }).click();
  await wait(600);
  await mark([[page.locator(".side-me").getByRole("button", { name: "밝은 화면으로" }), 1]]);
  await shot("22-dark");
  await page.locator(".side-me").getByRole("button", { name: "밝은 화면으로" }).click();
});

// ---------- DDS Conversa (가짜 LLM: scripts/mock_ollama.py 를 켜 두고, 백엔드에 REDO_LLM_BASE_URL·REDO_LLM_MODEL 지정) ----------
await step("23-conversa", async () => {
  await page.goto(`${BASE}/projects/${NEW_ID}/step/1`);
  await page.locator("#cell-0-0").waitFor();
  await page.getByRole("button", { name: "DDS Conversa 펼치기" }).click();
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  const box = panel.getByRole("textbox", { name: "DDS Conversa에게 요청" });
  await box.fill("이 DOE 상태 알려줘");
  await box.press("Enter");
  await panel.locator(".cv-msg.assistant").first().waitFor();
  await box.fill("1차-05 두께 10.2");
  await box.press("Enter");
  await panel.getByRole("group", { name: /확인:/ }).waitFor();
  await wait(400);
  await mark([
    [panel.locator(".cv-logo"), 1],
    [panel.locator(".cv-msg.assistant").first(), 2],
    [panel.getByRole("group", { name: /확인:/ }), 3],
    [panel.locator(".cv-input"), 4],
    [panel.getByRole("button", { name: "MCP 연결" }), 5],
    [panel.getByRole("button", { name: "대화 목록" }), 6],
    [panel.getByRole("button", { name: "새 대화" }), 7],
    [panel.getByRole("button", { name: "DDS Conversa 접기" }), 8],
    [page.getByRole("separator", { name: "DDS Conversa 너비 조절" }), 9, 2],
  ]);
  await shot("23-conversa", { top: false });
});

await step("24-conversa-danger", async () => {
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  const box = panel.getByRole("textbox", { name: "DDS Conversa에게 요청" });
  await panel.getByRole("group", { name: /확인:/ }).last().getByRole("button", { name: "취소" }).click();
  await box.fill("1차-06 지워줘");
  await box.press("Enter");
  const card = panel.getByRole("group", { name: /확인:/ }).last();
  await card.waitFor();
  await card.getByRole("button", { name: "실행" }).click();
  await card.getByText("정말 실행할까요?").waitFor();
  await mark([[card, 1]]);
  await shotEl("24-conversa-danger", panel);
  await card.getByRole("button", { name: "아니오" }).click();
});

await step("25-mcp", async () => {
  await page.getByRole("complementary", { name: "DDS Conversa" }).getByRole("button", { name: "MCP 연결" }).click();
  const dlg = page.getByRole("dialog", { name: /MCP 연결/ });
  await dlg.waitFor();
  await mark([[dlg.getByRole("textbox", { name: "MCP 서버 주소" }), 1], [dlg.getByRole("button", { name: "토큰 만들기" }), 2], [dlg.locator(".code-block"), 3]]);
  await shot("25-mcp", { top: false });
  await page.keyboard.press("Escape");
});

await step("26-conversa-history", async () => {
  const panel = page.getByRole("complementary", { name: "DDS Conversa" });
  const box = panel.getByRole("textbox", { name: "DDS Conversa에게 요청" });
  // 대화를 하나 더 만든 뒤 목록을 연다 (앞의 대화는 저장되어 있다)
  await panel.getByRole("button", { name: "새 대화" }).click();
  await box.fill("결과를 엑셀에서 한꺼번에 붙여넣는 방법은?");
  await box.press("Enter");
  await panel.locator(".cv-msg.assistant").first().waitFor();
  await panel.getByRole("button", { name: "대화 목록" }).click();
  const list = panel.getByRole("region", { name: "대화 목록" });
  await list.locator(".cv-conv").nth(1).waitFor();
  const second = list.locator(".cv-conv").nth(1);
  await second.hover();
  await wait(300);
  await mark([
    [panel.getByRole("button", { name: "대화 목록" }), 1],
    [list.getByRole("searchbox", { name: "대화 찾기" }), 2],
    [second.locator(".cv-conv-open"), 3],
    [second.locator(".cv-conv-acts"), 4],
    [list.getByRole("button", { name: "새 대화" }), 5],
  ]);
  await shotEl("26-conversa-history", panel);
  await panel.getByRole("button", { name: "대화 목록" }).click();
  await page.keyboard.press("Escape");
});

// ---------- 8. 공유받은 예측 페이지 (박지호) ----------
await step("19-shared", async () => {
  const c2 = await browser.newContext({ viewport: { width: W, height: HGT }, locale: "ko-KR" });
  const p2 = await c2.newPage();
  await login("E1003", p2);
  const shares = await (await p2.request.get(`${BASE}/api/shares/received`)).json();
  await p2.goto(`${BASE}/shared/${shares[0].token}`);
  await p2.waitForTimeout(6000);
  await p2.screenshot({ path: `${OUT}/19-shared.png` });
  await c2.close();
  console.log("✓ 19-shared");
});

await browser.close();
