import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerArgs, getPiInvocation, normalizeTaskResult } from "../src/worker-runner.js";

test("buildWorkerArgs includes prompt path, model, tools, and task", () => {
  const args = buildWorkerArgs(
    {
      task: "Inspect the repo",
      model: "gpt-5.4",
      tools: ["read", "bash"],
    },
    "/tmp/system-prompt.md",
  );

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--append-system-prompt",
    "/tmp/system-prompt.md",
    "--model",
    "gpt-5.4",
    "--tools",
    "read,bash",
    "Task: Inspect the repo",
  ]);
});

test("normalizeTaskResult extracts sections and changed files", () => {
  const result = normalizeTaskResult(
    "task-1",
    "succeeded",
    [
      "## Done",
      "Implemented storage layer.",
      "",
      "## Files Changed",
      "- `src/store.ts` - added task store",
      "- test/store.test.ts - added tests",
      "",
      "## Notes",
      "Need runtime manager next.",
    ].join("\n"),
    "2026-04-22T11:00:00.000Z",
  );

  assert.equal(result.done, "Implemented storage layer.");
  assert.deepEqual(result.filesChanged, [
    "`src/store.ts` - added task store",
    "test/store.test.ts - added tests",
  ]);
  assert.equal(result.notes, "Need runtime manager next.");
  assert.equal(result.summary, "Implemented storage layer.");
});

test("normalizeTaskResult omits no-files-changed sentinel", () => {
  const result = normalizeTaskResult(
    "task-1",
    "succeeded",
    [
      "## Done",
      "Investigated issue.",
      "",
      "## Files Changed",
      "No files changed.",
      "",
      "## Notes",
      "Research only.",
    ].join("\n"),
    "2026-04-22T11:00:00.000Z",
  );

  assert.deepEqual(result.filesChanged, []);
});

test("getPiInvocation respects explicit command override", () => {
  const invocation = getPiInvocation(["--mode", "json"], "pi-custom");
  assert.deepEqual(invocation, {
    command: "pi-custom",
    args: ["--mode", "json"],
  });
});
