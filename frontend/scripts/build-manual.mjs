// 사용 매뉴얼 HTML 만들기: docs/USER_MANUAL.md(원본) → public/manual/index.html
// 웹앱에서 새 창으로 여는 매뉴얼. 오른쪽에 따라다니는 목차(현재 위치 강조·검색), 그림 크게 보기, 다크 모드(앱과 같은 설정).
// 색·글꼴은 앱 디자인 토큰(src/design/tokens.css)을 그대로 넣는다. 외부 리소스 없음(사내망).
//   node scripts/build-manual.mjs     (npm run manual:html, 빌드 전에 자동 실행)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../docs/USER_MANUAL.md");
const OUT = resolve(here, "../public/manual/index.html");
const TOKENS = readFileSync(resolve(here, "../src/design/tokens.css"), "utf8");

/** GitHub와 같은 제목 앵커 (문서 안 링크 #1-시작하기 가 그대로 동작하도록) */
const slug = (t) => t.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
/** PNG 크기(IHDR)를 읽어 width·height를 넣는다 → 그림이 늦게 불러와져도 화면이 밀리지 않아 목차 이동 위치가 정확하다 */
function pngSize(rel) {
  const f = resolve(here, "../public/manual", rel);
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  return b.toString("ascii", 12, 16) === "IHDR" ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const toc = [];
const marked = new Marked({
  gfm: true,
  walkTokens(t) {
    // 원본 마크다운의 그림 경로(../frontend/public/manual/img/...)를 매뉴얼 기준 상대 경로로
    if (t.type === "image") t.href = t.href.replace(/^.*\/manual\/img\//, "img/");
  },
  renderer: {
    heading({ tokens, depth, text }) {
      const html = this.parser.parseInline(tokens);
      const id = slug(text);
      if (depth === 2 || depth === 3) toc.push({ depth, id, text: html.replace(/<[^>]+>/g, "") });
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
    },
    image({ href, text }) {
      const sz = pngSize(href);
      const dims = sz ? ` width="${sz.w}" height="${sz.h}"` : "";
      return `<figure><img src="${href}" alt="${esc(text)}"${dims} loading="lazy" data-zoom>${text ? `<figcaption>${esc(text)}</figcaption>` : ""}</figure>`;
    },
  },
  hooks: {
    // 표는 가로로 넘치면 스크롤되도록 감싼다
    postprocess: (html) => html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>'),
  },
});

let md = readFileSync(SRC, "utf8");
// 문서 맨 위 제목(h1)과 문서 안의 목차 목록은 오른쪽 목차로 대신한다
const title = (md.match(/^# (.+)$/m) ?? [, "사용 매뉴얼"])[1];
md = md.replace(/^# .+\n/m, "").replace(/## 목차\n[\s\S]*?\n---\n/, "");
const body = marked.parse(md);

const tocHtml = toc.map((t) => `<a href="#${t.id}" class="l${t.depth}" data-id="${t.id}">${esc(t.text)}</a>`).join("\n");
const built = new Date().toISOString().slice(0, 10);

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>
  // 화면 모드: 앱과 같은 설정(localStorage 'redo.theme')을 따른다
  try { document.documentElement.dataset.theme = localStorage.getItem("redo.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch (e) {}
</script>
<style>
${TOKENS}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; }
body { margin: 0; font-family: var(--font); font-size: 15px; line-height: 1.75; color: var(--ink); background: var(--paper); -webkit-font-smoothing: antialiased; }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
/* 머리 막대 */
.top { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 24px; background: var(--glass); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.top .logo { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--brand-500), var(--brand-hover)); color: #fff; font-size: 11px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; }
.top b { font-size: 15px; }
.top .sub { color: var(--ink-4); font-size: 13px; }
.top .grow { flex: 1; }
.top button { font: inherit; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: var(--radius-s); border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; }
.top button:hover { background: var(--panel-3); color: var(--ink); }
.toc-btn { display: none !important; }
/* 본문 + 오른쪽 목차 */
.wrap { display: grid; grid-template-columns: minmax(0, 860px) 260px; gap: 48px; justify-content: center; padding: 32px 24px 120px; }
main { min-width: 0; }
.intro h1 { font-size: 30px; letter-spacing: -0.02em; margin: 0 0 8px; line-height: 1.3; }
.intro p { color: var(--ink-3); margin: 0; }
h2 { font-size: 24px; letter-spacing: -0.02em; margin: 56px 0 16px; padding-top: 8px; line-height: 1.35; }
h3 { font-size: 18px; margin: 36px 0 12px; line-height: 1.4; }
h2 .anchor, h3 .anchor { opacity: 0; margin-left: -22px; width: 22px; display: inline-block; color: var(--ink-4); font-weight: 400; text-decoration: none; }
h2:hover .anchor, h3:hover .anchor { opacity: 1; }
p, ul, ol { margin: 0 0 14px; }
li { margin: 3px 0; }
hr { border: none; border-top: 1px solid var(--line); margin: 40px 0; }
strong { font-weight: 650; }
code { font-size: 0.88em; background: var(--panel-3); border-radius: 5px; padding: 1px 6px; }
blockquote { margin: 16px 0; padding: 12px 16px; border-radius: var(--radius-m); background: var(--brand-soft); border: 1px solid var(--brand-100); color: var(--ink-2); }
blockquote p:last-child { margin-bottom: 0; }
figure { margin: 18px 0 22px; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--radius-l); background: var(--panel); cursor: zoom-in; box-shadow: var(--shadow-card-md); }
figcaption { font-size: 12.5px; color: var(--ink-4); margin-top: 8px; text-align: center; }
.table-wrap { overflow-x: auto; margin: 14px 0 20px; border: 1px solid var(--line); border-radius: var(--radius-m); background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { padding: 9px 14px; text-align: left; border-bottom: 1px solid var(--line-2); vertical-align: top; }
th { font-size: 12.5px; font-weight: 600; color: var(--ink-3); background: var(--panel-2); border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: none; }
sub { color: var(--ink-4); }
/* 오른쪽 목차: 따라다니며 현재 위치 강조 */
nav.toc { position: sticky; top: 80px; align-self: start; max-height: calc(100vh - 100px); overflow-y: auto; font-size: 13.5px; padding-left: 14px; border-left: 1px solid var(--line); }
nav.toc .h { font-size: 12px; font-weight: 600; color: var(--ink-4); letter-spacing: 0.04em; margin-bottom: 8px; }
nav.toc input { width: 100%; font: inherit; font-size: 13px; height: 32px; padding: 0 10px; margin-bottom: 10px; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--panel); color: var(--ink); }
nav.toc input:focus { outline: none; border-color: var(--brand-500); }
nav.toc a { display: block; padding: 4px 8px; margin-left: -15px; border-left: 2px solid transparent; color: var(--ink-3); line-height: 1.45; text-decoration: none; }
nav.toc a.l3 { padding-left: 22px; font-size: 13px; color: var(--ink-4); }
nav.toc a:hover { color: var(--ink); }
nav.toc a.on { color: var(--brand); border-left-color: var(--brand); font-weight: 600; }
nav.toc a[hidden], nav.toc .none[hidden] { display: none; }
nav.toc .none { color: var(--ink-4); font-size: 12.5px; padding: 4px 0; }
.to-top { position: fixed; right: 24px; bottom: 24px; width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); font-size: 18px; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .2s; box-shadow: var(--shadow-card-md); }
.to-top.show { opacity: 1; pointer-events: auto; }
/* 그림 크게 보기 */
.zoom { position: fixed; inset: 0; z-index: 50; background: rgb(0 0 0 / 0.75); display: none; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out; }
.zoom.open { display: flex; }
.zoom img { max-width: 100%; max-height: 100%; border-radius: var(--radius-m); background: #fff; }
/* 좁은 화면: 목차는 위에서 펼쳐 보기 */
@media (max-width: 1100px) {
  .wrap { grid-template-columns: minmax(0, 1fr); padding: 20px 16px 100px; }
  nav.toc { display: none; position: fixed; top: 56px; right: 0; left: 0; max-height: 70vh; z-index: 30; background: var(--panel); border: none; border-bottom: 1px solid var(--line); padding: 16px 20px; box-shadow: var(--shadow-modal); }
  nav.toc.open { display: block; }
  nav.toc a { margin-left: 0; }
  .toc-btn { display: inline-flex !important; }
  .top .sub { display: none; }
}
@media print {
  .top, nav.toc, .to-top { display: none !important; }
  .wrap { display: block; padding: 0; }
  figure img { box-shadow: none; }
}
</style>
</head>
<body>
<header class="top">
  <span class="logo">Re</span><b>DDS ReDO 사용 매뉴얼</b><span class="sub">· ${built} 기준</span>
  <span class="grow"></span>
  <button class="toc-btn" type="button" onclick="document.querySelector('nav.toc').classList.toggle('open')">☰ 목차</button>
  <button type="button" onclick="toggleTheme()" title="밝은/어두운 화면">◐ 화면</button>
  <button type="button" onclick="print()" title="인쇄 또는 PDF로 저장">⎙ 인쇄</button>
</header>
<div class="wrap">
  <main>
    <div class="intro"><h1>${esc(title)}</h1></div>
${body}
  </main>
  <nav class="toc" aria-label="목차">
    <div class="h">목차</div>
    <input type="search" placeholder="목차 검색" aria-label="목차 검색" oninput="filterToc(this.value)">
${tocHtml}
    <div class="none" hidden>찾는 항목이 없습니다</div>
  </nav>
</div>
<button class="to-top" type="button" aria-label="맨 위로" onclick="scrollTo({ top: 0 })">↑</button>
<div class="zoom" onclick="this.classList.remove('open')"><img alt=""></div>
<script>
  function toggleTheme() {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("redo.theme", t); } catch (e) {}
  }
  // 목차: 지금 읽고 있는 절을 강조하고, 목차 안에서도 보이게 스크롤
  const links = [...document.querySelectorAll("nav.toc a[data-id]")];
  const byId = new Map(links.map((a) => [a.dataset.id, a]));
  const heads = links.map((a) => document.getElementById(a.dataset.id)).filter(Boolean);
  let current = null;
  function mark() {
    const y = 90;
    let h = heads[0];
    for (const el of heads) { if (el.getBoundingClientRect().top - y <= 0) h = el; else break; }
    if (h && h.id !== current) {
      current = h.id;
      links.forEach((a) => a.classList.toggle("on", a.dataset.id === current));
      const a = byId.get(current);
      const nav = document.querySelector("nav.toc");
      if (a && nav.scrollHeight > nav.clientHeight) {
        const top = a.offsetTop - nav.clientHeight / 2;
        nav.scrollTo({ top: Math.max(0, top) });
      }
    }
    document.querySelector(".to-top").classList.toggle("show", scrollY > 600);
  }
  addEventListener("scroll", mark, { passive: true });
  addEventListener("load", mark);
  mark();
  // 좁은 화면에서 목차 항목을 누르면 목차를 닫는다
  links.forEach((a) => a.addEventListener("click", () => document.querySelector("nav.toc").classList.remove("open")));
  // 목차 검색
  function filterToc(q) {
    q = q.trim().toLowerCase();
    let n = 0;
    links.forEach((a) => { const ok = !q || a.textContent.toLowerCase().includes(q); a.hidden = !ok; if (ok) n++; });
    document.querySelector("nav.toc .none").hidden = n > 0;
  }
  // 그림 크게 보기 (Esc로 닫기)
  const zoom = document.querySelector(".zoom");
  document.querySelectorAll("img[data-zoom]").forEach((img) => img.addEventListener("click", () => { zoom.querySelector("img").src = img.src; zoom.classList.add("open"); }));
  addEventListener("keydown", (e) => { if (e.key === "Escape") zoom.classList.remove("open"); });
</script>
</body>
</html>
`;
writeFileSync(OUT, html);
console.log(`manual: ${OUT} (목차 ${toc.length}개)`);
