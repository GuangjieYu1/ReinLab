/**
 * 视觉拆解用量记账（契约 §14.2/14.9）：单价未知，按「未知」记——
 * known=false，token 与金额都留空（表约束要求），token 数写进 note。
 */

import type { Database } from '../db/database';

export async function recordBreakdownUsage(
  db: Database,
  account: string,
  dossier: string,
  runId: string | null,
  usage: { inputTokens: number | null; outputTokens: number | null; shots?: number },
): Promise<void> {
  const note = `视觉拆解${usage.shots ? ` ${usage.shots} 镜` : ''}，输入 ${usage.inputTokens ?? '未知'} / 输出 ${usage.outputTokens ?? '未知'} token，单价未知`;
  try {
    await db.withAccount(account, (client) =>
      client.query(
        `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose,note)
         values(gen_random_uuid(),$1,$2,$3,'volcengine-ark','doubao-seed-2-1-pro-260915',false,null,null,null,null,null,'creative_breakdown',$4)`,
        [account, dossier, runId, note],
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ code: 'USAGE_RECORD_FAILED', purpose: 'creative_breakdown', message: String((error as Error).message).slice(0, 160) }));
  }
}
