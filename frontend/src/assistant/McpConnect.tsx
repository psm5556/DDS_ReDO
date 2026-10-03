import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, post } from "../api";
import { Modal } from "../components/Modal";
import { copyText } from "../paste";
import { useToast } from "../toast";
import { when } from "../format";

/** MCP 연결: 사내 MCP 클라이언트(에이전트·IDE)가 '나'로서 DDS ReDO 도구를 쓰도록 개인 토큰을 발급·폐기한다.
 *  토큰 원문은 만들 때 한 번만 보여 준다. 토큰은 내 권한 그대로 동작하므로 남과 나누지 않는다. */
interface Tok { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }

export function McpConnectModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<Tok[] | null>(null);
  const [name, setName] = useState("사내 에이전트");
  const [made, setMade] = useState<string | null>(null);
  const url = `${window.location.origin}/mcp`;
  const load = () => get<Tok[]>("/api/me/tokens").then(setList).catch(() => setList([]));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      const r = await post<{ token: string }>("/api/me/tokens", { name });
      setMade(r.token);
      void load();
    } catch (e) { toast((e as Error).message, true); }
  };
  const config = JSON.stringify({ mcpServers: { "dds-redo": { type: "http", url, headers: { Authorization: `Bearer ${made ?? "<토큰>"}` } } } }, null, 2);

  return (
    <Modal title="MCP 연결 — 사내 에이전트·IDE에서 DDS ReDO 쓰기" wide onClose={onClose}>
      <div className="stack">
        <p className="small muted">MCP를 지원하는 사내 도구에 아래 주소와 개인 토큰을 등록하면, 그 도구의 LLM이 <b>내 권한으로</b> DOE 조회·결과 입력·추천 확인 등을 할 수 있습니다.
          데이터를 바꾸는 도구는 먼저 바뀔 내용을 보여 주고, 승인을 받은 뒤에만 실행합니다(삭제·공유 등은 두 번 확인).</p>
        <label className="field"><span className="lbl">MCP 서버 주소</span>
          <div className="row" style={{ flexWrap: "nowrap" }}><input type="text" readOnly value={url} aria-label="MCP 서버 주소" />
            <button className="icon-btn" title="복사" aria-label="주소 복사" onClick={() => void copyText(url).then(() => toast("주소를 복사했습니다."))}><Copy size={15} /></button></div></label>

        {made ? (
          <div className="notice warn" style={{ display: "block" }}>
            <b>새 토큰 — 지금 한 번만 보여 드립니다.</b> 안전한 곳에 보관하고 남과 나누지 마세요.
            <div className="row" style={{ marginTop: 8, flexWrap: "nowrap" }}><input type="text" readOnly value={made} aria-label="새 토큰" />
              <button className="small" onClick={() => void copyText(made).then(() => toast("토큰을 복사했습니다."))}><Copy size={14} />복사</button></div>
          </div>
        ) : (
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field grow"><span className="lbl">토큰 이름 (어디에 쓰는지)</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <button className="primary" onClick={() => void create()} disabled={!name.trim()}><KeyRound size={15} />토큰 만들기</button>
          </div>
        )}

        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>설정 예시 (MCP 클라이언트 설정 파일)</div>
          <pre className="code-block">{config}</pre>
          <button className="small" onClick={() => void copyText(config).then(() => toast("설정을 복사했습니다."))}><Copy size={14} />설정 복사</button>
        </div>

        <div>
          <h4 style={{ marginBottom: 6 }}>내 토큰</h4>
          {list === null ? <div className="busy"><span className="spinner" /> 불러오는 중</div> : list.length === 0 ? <p className="small muted">아직 없습니다.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>이름</th><th>토큰</th><th>만든 날</th><th>마지막 사용</th><th /></tr></thead>
              <tbody>{list.map((t) => (
                <tr key={t.id}><td>{t.name}</td><td className="num">{t.prefix}</td><td>{when(t.created_at)}</td><td>{t.last_used_at ? when(t.last_used_at) : "-"}</td>
                  <td className="r"><button className="small danger" onClick={async () => {
                    try { await del(`/api/me/tokens/${t.id}`); toast("토큰을 폐기했습니다. 이 토큰으로는 더 이상 접속할 수 없습니다."); void load(); }
                    catch (e) { toast((e as Error).message, true); }
                  }}><Trash2 size={13} />폐기</button></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>
    </Modal>
  );
}
