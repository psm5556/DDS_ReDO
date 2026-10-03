import { FlaskConical, MousePointerClick, MoreHorizontal, Plus } from "lucide-react";
import { Link } from "react-router-dom";

/** 첫 화면: 왼쪽 DOE 목록 사용법만 짧게 안내한다 (작업은 모두 DOE 안의 단계에서). */
export default function DashboardPage() {
  return (
    <div className="page">
      <div className="welcome">
        <div className="welcome-icon"><FlaskConical size={26} /></div>
        <h1>왼쪽 목록에서 DOE를 고르세요</h1>
        <p>DOE마다 <b>할 일</b> 표시가 붙은 단계부터 진행하면 됩니다.</p>
        <ol className="welcome-steps">
          <li><MousePointerClick size={16} /><span><b>DOE 이름</b> — 인자·응답·목표 설정</span></li>
          <li><span className="n">1</span><span><b>실험 데이터 입력</b> — 시트 인쇄, 결과 입력 (엑셀에서 복사·붙여넣기)</span></li>
          <li><span className="n">2</span><span><b>능동학습 결과</b> — 추천 레시피 확인, 다음 실험 확정 → 다시 1로</span></li>
          <li><MoreHorizontal size={16} /><span>DOE 옆 <b>⋯</b> 또는 <b>우클릭</b> — 멤버·공유, 즐겨찾기, 복제, 삭제</span></li>
        </ol>
        <Link className="btn primary big" to="/new"><Plus size={16} />새 DOE 만들기</Link>
      </div>
    </div>
  );
}
