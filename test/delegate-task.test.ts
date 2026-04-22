import test from "node:test";
import assert from "node:assert/strict";

import { buildDelegateTaskResult, buildDelegateTaskText, toLaunchTaskInput } from "../src/index.js";
import type { TaskRecord } from "../src/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    title: "Audit stale CSS",
    task: "Audit stale CSS",
    status: "queued",
    cwd: "/tmp/project",
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    pid: null,
    exitCode: null,
    model: null,
    tools: null,
    priority: "normal",
    timeoutMinutes: 10,
    error: null,
    latestNote: "Queued",
    resultSummary: null,
    ...overrides,
  };
}

test("toLaunchTaskInput normalizes delegate task params", () => {
  const input = toLaunchTaskInput(
    {
      task: "Investigate Vite CSS issue",
      title: "  CSS audit  ",
      cwd: "  /tmp/project  ",
      model: "  gpt-5.4  ",
      timeoutMinutes: 15,
      tools: ["read", "bash"],
      priority: "high",
      waitForResult: true,
    },
    "/fallback",
  );

  assert.deepEqual(input, {
    task: "Investigate Vite CSS issue",
    title: "CSS audit",
    cwd: "/tmp/project",
    model: "gpt-5.4",
    tools: ["read", "bash"],
    priority: "high",
    timeoutMinutes: 15,
  });
});

test("buildDelegateTaskText explains background-first behavior", () => {
  const text = buildDelegateTaskText(makeTask(), true);
  assert.match(text, /Created background task task-1\./);
  assert.match(text, /waitForResult is not supported in v0/);
  assert.match(text, /\/bg-show task-1/);
  assert.match(text, /\/bg-results task-1/);
});

test("buildDelegateTaskResult returns task details and inspect commands", () => {
  const result = buildDelegateTaskResult(makeTask(), false);
  assert.equal(result.content[0]?.type, "text");
  assert.deepEqual(result.details, {
    taskId: "task-1",
    title: "Audit stale CSS",
    status: "queued",
    cwd: "/tmp/project",
    waitForResultIgnored: false,
    inspectCommands: {
      show: "/bg-show task-1",
      results: "/bg-results task-1",
      cancel: "/bg-cancel task-1",
    },
  });
});
