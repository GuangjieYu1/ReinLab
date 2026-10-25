import { it, expect } from "vitest";
import {
  smokeOperatorArguments,
  smokeFetchArguments,
} from "../scripts/smoke-policy";
const search = (id = "W4387156572", status = "completed") => [
  {
    type: "tool",
    state: {
      status,
      input: { requestId: "this-run-search", capability: "papers.search" },
      output: JSON.stringify({
        papers: [{ paperId: id, title: "Actual result" }],
      }),
    },
  },
];
it("smoke attribution must explicitly name new authorization and executor; the CLI never invents either", () => {
  expect(
    smokeOperatorArguments([
      "--execute-once",
      "--authorization-source",
      "fixture-second-user-authorization",
      "--executor",
      "Claude",
    ])
  ).toEqual({
    authorization: "fixture-second-user-authorization",
    executor: "Claude",
  });
  for (const args of [
    [],
    ["--execute-once"],
    ["--execute-once", "--executor", "Claude"],
    [
      "--execute-once",
      "--authorization-source",
      "fixture",
      "--executor",
      "sk-fixture",
    ],
  ])
    expect(() => smokeOperatorArguments(args)).toThrow();
});
it("fetch complete args come from this run successful search, never preflight metadata or an invented paper", () => {
  expect(
    smokeFetchArguments(search(), "this-run-search", "W4387156572")
  ).toEqual({ paperId: "W4387156572" });
  for (const [tools, request] of [
    [search("W2"), "this-run-search"],
    [search("W4387156572", "error"), "this-run-search"],
    [search(), "another-run-search"],
    [search("../escape"), "this-run-search"],
  ] as const)
    expect(() => smokeFetchArguments(tools, request, "W4387156572")).toThrow();
});
