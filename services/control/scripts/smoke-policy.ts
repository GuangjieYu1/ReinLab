import assert from "node:assert/strict";
import { parseArgs } from "node:util";
export function smokeOperatorArguments(args: string[]) {
  const cli = parseArgs({
    args,
    options: {
      "execute-once": { type: "boolean" },
      "authorization-source": { type: "string" },
      executor: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }).values;
  assert.equal(cli["execute-once"], true);
  for (const label of [cli["authorization-source"], cli.executor])
    assert.ok(
      typeof label === "string" &&
        label.trim().length > 0 &&
        label.length <= 200 &&
        !/[\r\n]/.test(label) &&
        !/(?:sk-|Bearer |token|password)/i.test(label),
    );
  return {
    authorization: cli["authorization-source"]!,
    executor: cli.executor!,
  };
}
export function smokeFetchArguments(
  tools: any[],
  searchRequest: string,
  expectedPaper: string,
) {
  const search = tools.find(
    (p) =>
      p.type === "tool" &&
      p.state?.input?.requestId === searchRequest &&
      p.state?.status === "completed",
  );
  assert.ok(search, "MCP10_SEARCH_RECEIPT_REQUIRED");
  assert.equal(search.state.input.capability, "papers.search");
  const papers = JSON.parse(search.state.output).papers;
  assert.ok(
    Array.isArray(papers) &&
      papers.length === 1 &&
      /^W[0-9]{1,30}$/.test(papers[0].paperId),
  );
  assert.equal(papers[0].paperId, expectedPaper);
  return { paperId: papers[0].paperId as string };
}
export function smokeReadReceipt(
  tools: any[],
  fetchRequest: string,
  pagesRequest: string,
) {
  const completed = (capability: string, requestId: string) => {
    const values = tools.filter(
      (p) =>
        p.type === "tool" &&
        p.state?.status === "completed" &&
        p.state.input?.capability === capability &&
        p.state.input.requestId === requestId,
    );
    assert.equal(values.length, 1, "MCP10_READ_RECEIPT_REQUIRED");
    return values[0].state;
  };
  const fetched = completed("papers.fetch", fetchRequest),
    fetchResult = JSON.parse(fetched.output);
  assert.equal(fetchResult.status, "full_text");
  assert.match(
    fetchResult.assetId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  const pages = completed("papers.pages", pagesRequest),
    result = JSON.parse(pages.output);
  assert.deepEqual(pages.input.args, {
    assetId: fetchResult.assetId,
    pages: [1],
  });
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].page, 1);
  assert.ok(
    typeof result.pages[0].text === "string" && result.pages[0].text.trim(),
  );
  return {
    assetId: fetchResult.assetId as string,
    page: 1,
    text: result.pages[0].text as string,
  };
}
