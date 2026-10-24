import InboxHost from "../../inbox/InboxHost";
import { liveInboxAdapter } from "../../../data/inbox-live";
import BenchFrame from "../BenchFrame";
import { useEffect, useState } from "react";
import type { Dossier } from "../../../../packages/contracts/src/index";
import type { BenchProps } from "../WorkbenchStudio";
import { api } from "../../../data/research-live";
import AgentDock from "../AgentDock";
export default function LiveResearch({ chrome, reduced, file }: BenchProps) {
  const [files, setFiles] = useState<Dossier[]>([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    api("/v1/dossiers")
      .then((v) => {
        if (mounted) {
          setFiles(v.items);
          setSelected(v.items[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (mounted) setError("档案读取失败，请重新登录后重试。");
      });
    return () => {
      mounted = false;
    };
  }, []);
  const realChrome = {
    ...chrome,
    file: (
      <select
        aria-label="真实研究档案"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">选择档案</option>
        {files.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </select>
    ),
  };
  return (
    <BenchFrame
      code="RSCH"
      section="002"
      file={file}
      reduced={reduced}
      chrome={realChrome}
      faces={[{ id: "inbox", label: "待处理", en: "INBOX" }]}
      face="inbox"
      onFace={() => {}}
      status={<span>真实数据 · 审批与上线收件箱</span>}
    >
      <section className="rh-panel">
        <InboxHost autoOpen adapter={liveInboxAdapter} />
        <h1>{files.find((d) => d.id === selected)?.title ?? "研究档案"}</h1>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>审批卡与上线提议由收件箱读取。研究运行入口将在后续批次接入。</p>
        )}
        <AgentDock
          name="研究助手"
          target="审批与上线收件箱"
          plan={{ stages: ["查看待处理", "核对依据", "人工决定"], current: 0 }}
          suggestions={[]}
          events={[
            {
              id: "ready",
              kind: "agent",
              text: "点击上线收件箱查看真实待处理事项。",
              at: "",
            },
          ]}
          busy={false}
          onSend={() => setError("本批仅开放审批和上线收件箱。")}
          footnote="未经用户批准不会写入长期记忆"
        />
      </section>
    </BenchFrame>
  );
}
