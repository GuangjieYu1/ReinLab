/**
 * 第 8 节：把档案的操作记录投递给会话。
 *
 * 做法：每个会话记一个事件游标；每次发送前取游标之后、这份档案的 user_op，
 * 拼成一小段人话随这一轮送进去，然后推进游标（落库，重启不会重复投递）。
 * 这段文字会以用户消息的形式出现在页面上，所以写成「档案变动：…」这样的一行。
 */
import type pg from "pg";

type Client = pg.PoolClient;

const HEAD = "档案变动：";

export async function withDossierContext(
  client: Client,
  input: { account: string; dossier: string; sessionId: string | null; prompt: string },
): Promise<string> {
  if (!input.sessionId) return input.prompt;
  const row = (
    await client.query("select user_op_cursor from dsh_session where account_id=$1 and session_id=$2", [
      input.account,
      input.sessionId,
    ])
  ).rows[0];
  const cursor = Number(row?.user_op_cursor ?? 0);
  const notes = (
    await client.query(
      `select seq, payload->>'text' text from event
        where account_id=$1 and dossier_id=$2 and kind='user_op' and seq > $3
        order by seq limit 50`,
      [input.account, input.dossier, cursor],
    )
  ).rows;
  if (!notes.length) return input.prompt;
  await client.query(
    "update dsh_session set user_op_cursor=$3 where account_id=$1 and session_id=$2",
    [input.account, input.sessionId, notes[notes.length - 1].seq],
  );
  const facts = notes
    .map((n: any) => String(n.text ?? "").trim())
    .filter(Boolean)
    .join("；");
  if (!facts) return input.prompt;
  return `${HEAD}${facts}。\n\n${input.prompt}`;
}
