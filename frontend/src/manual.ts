/** 사용 매뉴얼(public/manual/index.html, docs/USER_MANUAL.md에서 생성)을 새 창으로 연다.
 *  같은 이름의 창을 다시 쓰므로 여러 번 눌러도 창이 늘어나지 않는다. section: 매뉴얼 제목 앵커(예: "5-실험-데이터-입력") */
export const MANUAL_URL = "/manual/index.html";

export function openManual(section?: string) {
  const url = section ? `${MANUAL_URL}#${encodeURIComponent(section)}` : MANUAL_URL;
  const w = window.open(url, "redo-manual", "width=1280,height=900");
  if (w) w.focus();
  else window.location.assign(url); // 팝업이 막혀 있으면 지금 창에서
}
