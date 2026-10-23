import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  InboxApproval,
  InboxPromotion,
  PromotionDecision,
  PromotionItem,
  JsonValue,
} from "../../../../packages/contracts/src/index";
import AgentDock, { type DockEvent } from "../AgentDock";
import LoginGate from "../../cinematic/LoginGate";
import {
  inbox,
  decide,
  loggedIn,
  liveBackend,
  logout,
  sessionGeneration,
  api,
} from "../../../data/research-live";
function visible(v: JsonValue) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
type EditableItem = {
  key: string;
  value: string;
  structured: boolean;
  evidence: string;
  supersedes?: string;
};
type Evidence = {
  ref: string;
  event: {
    kind: string;
    action: string | null;
    payload: JsonValue;
    at: string;
  };
};
function editableItems(items: JsonValue): EditableItem[] {
  if (!Array.isArray(items))
    return [{ key: "", value: "", structured: false, evidence: "" }];
  return items.map((item) => {
    const value =
      item && typeof item === "object" && !Array.isArray(item) ? item : {};
    return {
      key: typeof value.key === "string" ? value.key : "",
      value: visible(value.value ?? null),
      structured: typeof value.value !== "string",
      evidence: Array.isArray(value.evidence)
        ? value.evidence
            .filter((r): r is string => typeof r === "string")
            .join("\n")
        : "",
      ...(typeof value.supersedes === "string"
        ? { supersedes: value.supersedes }
        : {}),
    };
  });
}
function Promotion({
  item,
  onDecide,
  busy,
}: {
  item: InboxPromotion;
  onDecide: (body: PromotionDecision) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [entries, setEntries] = useState(() => editableItems(item.items)),
    [invalid, setInvalid] = useState(""),
    [evidence, setEvidence] = useState<Evidence[]>([]),
    [nextAfter, setNextAfter] = useState<number | null>(null),
    [activeItem, setActiveItem] = useState(0);
  function patch(index: number, change: Partial<EditableItem>) {
    setEntries((old) =>
      old.map((v, i) => (i === index ? { ...v, ...change } : v)),
    );
  }
  async function source(ref?: string, after = 0) {
    const expected = sessionGeneration();
    try {
      if (ref) {
        if (!/^event:[1-9][0-9]{0,15}$/.test(ref)) throw Error();
        const value = await api(
          "/v1/promotions/" + item.id + "/evidence/" + ref.slice(6),
        );
        if (expected !== sessionGeneration()) return;
        setEvidence([value]);
        setNextAfter(null);
      } else {
        const value = await api(
          "/v1/promotions/" + item.id + "/evidence?after=" + after,
        );
        if (expected !== sessionGeneration()) return;
        setEvidence((old) => (after ? [...old, ...value.items] : value.items));
        setNextAfter(value.nextAfter);
      }
      setInvalid("");
    } catch {
      if (expected === sessionGeneration())
        setInvalid(
          "依据读取失败或不属于此提议的来源，请查看来源对话重新选择。",
        );
    }
  }
  function submitEdit() {
    try {
      const items: PromotionItem[] = entries.map((e) => ({
        key: e.key,
        value: e.structured ? JSON.parse(e.value) : e.value,
        evidence: e.evidence
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean),
        ...(e.supersedes ? { supersedes: e.supersedes } : {}),
      }));
      if (
        !items.length ||
        items.some((e) => !e.key.trim() || !e.evidence.length)
      )
        throw Error();
      setInvalid("");
      onDecide({ decision: "edit", items });
    } catch {
      setInvalid("请填写条目名、内容和来源依据；结构化内容须保持有效格式。");
    }
  }
  const impact =
    item.target === "L4.knowledge"
      ? "批准后加入知识库，供以后的研究检索。"
      : item.target === "L3.profile"
        ? "批准后更新个人侧写，影响以后的助手建议。"
        : item.target === "L3.preference"
          ? "批准后更新个人偏好，影响以后的助手回答。"
          : "批准后更新例程，供以后的任务采用。";
  return (
    <div className="rh-approval">
      <span className="rh-micro">
        {item.source.bench} · 上线时待批准 · {item.target}
      </span>
      <strong>{item.reason}</strong>
      <p>
        {item.source.dossierTitle} · {item.source.roleId}
      </p>
      <p>{impact}</p>
      {entries.map((entry, i) => (
        <section key={i}>
          <strong>{entry.key || "未命名条目"}</strong>
          <pre>{entry.value}</pre>
          <span>依据：</span>
          {entry.evidence
            .split("\n")
            .filter(Boolean)
            .map((ref, j) => (
              <button
                key={j}
                className="rh-btn is-ghost"
                onClick={() => {
                  setActiveItem(i);
                  void source(ref);
                }}
              >
                {ref}
              </button>
            ))}
          {editing && (
            <>
              <label>
                条目名
                <input
                  aria-label={"条目名 " + (i + 1)}
                  value={entry.key}
                  onChange={(e) => patch(i, { key: e.target.value })}
                />
              </label>
              <label>
                {entry.structured ? "内容（结构化数据）" : "内容"}
                <textarea
                  aria-label={"上线内容 " + (i + 1)}
                  value={entry.value}
                  onChange={(e) => patch(i, { value: e.target.value })}
                />
              </label>
              <label>
                依据事件引用（每行一条）
                <textarea
                  aria-label={"上线依据 " + (i + 1)}
                  value={entry.evidence}
                  onFocus={() => setActiveItem(i)}
                  onChange={(e) => patch(i, { evidence: e.target.value })}
                />
              </label>
            </>
          )}
        </section>
      ))}
      <button className="rh-btn" onClick={() => void source()}>
        查看来源对话
      </button>
      {evidence.length > 0 && (
        <section aria-label="来源对话依据">
          {evidence.map((e) => (
            <details key={e.ref} open>
              <summary>
                {e.ref} · {e.event.kind} · {e.event.action}
              </summary>
              <pre>{visible(e.event.payload)}</pre>
              <button
                className="rh-btn"
                onClick={() => {
                  setEditing(true);
                  setEntries((old) =>
                    old.map((v, i) =>
                      i === activeItem
                        ? {
                            ...v,
                            evidence: [
                              ...new Set([
                                ...v.evidence
                                  .split("\n")
                                  .filter((v) => /^event:[1-9][0-9]*$/.test(v)),
                                e.ref,
                              ]),
                            ].join("\n"),
                          }
                        : v,
                    ),
                  );
                }}
              >
                用作第 {activeItem + 1} 条依据
              </button>
            </details>
          ))}
          {nextAfter !== null && (
            <button
              className="rh-btn"
              onClick={() => void source(undefined, nextAfter)}
            >
              更多来源记录
            </button>
          )}
        </section>
      )}
      <p>有效至 {item.expiresAt}</p>
      {invalid && <p role="alert">{invalid}</p>}
      <div className="ad-approval-act">
        <button
          disabled={busy}
          className="rh-btn is-solid"
          onClick={() => onDecide({ decision: "approve" })}
        >
          批准上线
        </button>
        <button
          disabled={busy}
          className="rh-btn"
          onClick={() => {
            if (!editing) setEditing(true);
            else submitEdit();
          }}
        >
          {editing ? "提交修改并批准" : "修改后批准"}
        </button>
        <button
          disabled={busy}
          className="rh-btn"
          onClick={() => onDecide({ decision: "reject" })}
        >
          驳回
        </button>
        <button
          disabled={busy}
          className="rh-btn"
          onClick={() => onDecide({ decision: "keep_local" })}
        >
          仅存本档案
        </button>
      </div>
    </div>
  );
}
function Approval({
  item,
  busy,
  onDecide,
}: {
  item: InboxApproval;
  busy: boolean;
  onDecide: (decision: "approve" | "reject", answers?: string[][]) => void;
}) {
  const effects = Array.isArray(item.effects) ? item.effects : [],
    questions = effects.flatMap((e) =>
      e &&
      typeof e === "object" &&
      !Array.isArray(e) &&
      Array.isArray(e.questions)
        ? e.questions
        : e &&
            typeof e === "object" &&
            !Array.isArray(e) &&
            e.properties &&
            typeof e.properties === "object" &&
            !Array.isArray(e.properties) &&
            Array.isArray(e.properties.questions)
          ? e.properties.questions
          : [],
    ) as {
      question?: string;
      options?: { label: string; description: string }[];
      multiple?: boolean;
      custom?: boolean;
    }[];
  const [answers, setAnswers] = useState<string[][]>([]);
  return (
    <div className="rh-approval">
      <span className="rh-micro">
        {item.source.bench} ·{" "}
        {item.risk === "danger"
          ? "危险"
          : item.risk === "write"
            ? "写入"
            : "只读"}{" "}
        · 仅本次
      </span>
      <strong>{item.title}</strong>
      <p>
        {item.source.dossierTitle} · {item.source.roleId}
      </p>
      <pre>{visible(item.effects)}</pre>
      {questions.map((q, i) => (
        <fieldset key={i}>
          <legend>{q.question}</legend>
          {q.options?.map((o) => (
            <label key={o.label}>
              <input
                type={q.multiple ? "checkbox" : "radio"}
                name={item.id + "-" + i}
                checked={answers[i]?.includes(o.label) ?? false}
                onChange={(e) =>
                  setAnswers((old) => {
                    const next = [...old];
                    next[i] = q.multiple
                      ? e.target.checked
                        ? [...(next[i] ?? []), o.label]
                        : (next[i] ?? []).filter((v) => v !== o.label)
                      : [o.label];
                    return next;
                  })
                }
              />
              {o.label} · {o.description}
            </label>
          ))}
          {q.custom && (
            <input
              aria-label={"自定义回答 " + (i + 1)}
              onChange={(e) =>
                setAnswers((old) => {
                  const next = [...old];
                  next[i] = e.target.value.trim() ? [e.target.value] : [];
                  return next;
                })
              }
            />
          )}
        </fieldset>
      ))}
      {item.state === "indeterminate" ? (
        <p role="status">决定已发送，结果未知。等待对账，不会再次发送。</p>
      ) : (
        <div className="ad-approval-act">
          <button
            className="rh-btn is-solid"
            disabled={
              busy ||
              (item.kind === "question" &&
                (!questions.length ||
                  questions.some((_, i) => !answers[i]?.length)))
            }
            onClick={() =>
              onDecide(
                "approve",
                item.kind === "question" ? answers : undefined,
              )
            }
          >
            {item.kind === "question" ? "提交回答" : "批准"}
          </button>
          <button
            disabled={busy}
            className="rh-btn"
            onClick={() => onDecide("reject")}
          >
            驳回
          </button>
        </div>
      )}
    </div>
  );
}
export default function LiveInboxBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const [ready, setReady] = useState(loggedIn),
    [data, setData] = useState<{
      promotions: InboxPromotion[];
      approvals: InboxApproval[];
    }>({ promotions: [], approvals: [] }),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    lastRefresh = useRef(0);
  const refresh = useCallback(async () => {
    if (!loggedIn()) return;
    const expected = sessionGeneration();
    try {
      const value = await inbox();
      if (expected !== sessionGeneration()) return;
      setData(value);
      lastRefresh.current = Date.now();
      setError("");
      if (value.promotions.length || value.approvals.length)
        dialog.current?.showModal();
    } catch {
      if (expected !== sessionGeneration()) return;
      setError("待处理事项读取失败，请重试。");
      dialog.current?.showModal();
    }
  }, []);
  useEffect(() => {
    if (!ready) return;
    void refresh();
    const on = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastRefresh.current >= 300000
      )
        void refresh();
    }, 30000);
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", on);
    };
  }, [ready, refresh]);
  async function act(
    kind: "promotion" | "approval",
    id: string,
    body:
      | PromotionDecision
      | { decision: "approve" | "reject"; scope: "once"; answers?: string[][] },
  ) {
    if (busy) return;
    const expected = sessionGeneration();
    setBusy(true);
    try {
      await decide(kind, id, body);
      if (expected !== sessionGeneration()) return;
      setStatus("决定已收据确认。");
      await refresh();
    } catch {
      if (expected !== sessionGeneration()) return;
      setError("决定尚未确认，请刷新；再次提交相同决定会使用原幂等键。");
    } finally {
      if (expected === sessionGeneration()) setBusy(false);
    }
  }
  if (!liveBackend) return children;
  if (!ready)
    return (
      <LoginGate
        reduced
        music={false}
        onMusicChange={() => {}}
        onLogin={() => setReady(true)}
      />
    );
  const groups = [
      ...new Set(
        [...data.promotions, ...data.approvals].map((v) => v.source.bench),
      ),
    ].sort(),
    events: DockEvent[] = groups.flatMap((bench) => [
      {
        id: "bench:" + bench,
        kind: "card",
        body: <h2>{bench} · 待处理</h2>,
      } as DockEvent,
      ...data.promotions
        .filter((v) => v.source.bench === bench)
        .map((v) => ({
          id: v.id,
          kind: "card" as const,
          body: (
            <Promotion
              item={v}
              busy={busy}
              onDecide={(b) => void act("promotion", v.id, b)}
            />
          ),
        })),
      ...data.approvals
        .filter((v) => v.source.bench === bench)
        .map((v) => ({
          id: v.id,
          kind: "card" as const,
          body: (
            <Approval
              item={v}
              busy={busy}
              onDecide={(decision, answers) =>
                void act("approval", v.id, {
                  decision,
                  scope: "once",
                  ...(answers ? { answers } : {}),
                })
              }
            />
          ),
        })),
    ]);
  return (
    <>
      {children}
      <button
        className="rh-btn"
        onClick={() => {
          dialog.current?.showModal();
          void refresh();
        }}
      >
        上线收件箱 · {data.promotions.length + data.approvals.length}
      </button>
      <dialog className="rh rh-panel" ref={dialog} aria-label="上线时待批准">
        <button className="rh-btn" onClick={() => dialog.current?.close()}>
          稍后处理
        </button>
        <button
          className="rh-btn"
          onClick={() => {
            logout();
            setData({ promotions: [], approvals: [] });
            setError("");
            setStatus("");
            setBusy(false);
            setReady(false);
          }}
        >
          退出账户
        </button>
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        <AgentDock
          name="研究助手"
          target="上线时待批准"
          plan={{ stages: ["核对依据", "用户决定", "写入账本"], current: 0 }}
          suggestions={[
            {
              id: "refresh",
              label: "刷新待处理",
              onClick: () => void refresh(),
            },
          ]}
          events={
            events.length
              ? events
              : [
                  {
                    id: "empty",
                    kind: "agent",
                    text: "当前没有待处理事项。",
                    at: "",
                  },
                ]
          }
          busy={busy}
          onSend={() => setStatus("本批仅开放审批与上线收件箱。")}
          footnote="未经批准不会写入长期记忆"
        />
      </dialog>
    </>
  );
}
