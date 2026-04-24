import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDelegateSwarmResult,
  buildDelegateSwarmText,
  buildDelegateTaskResult,
  buildDelegateTaskText,
  toLaunchSwarmInputs,
  toLaunchTaskInput,
} from "../src/index.js";
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
    reportedAt: null,
    swarmId: null,
    swarmRole: null,
    taskType: null,
    roleHint: null,
    parentTaskId: null,
    cancellationGroup: null,
    acceptanceCriteria: null,
    expectedArtifacts: null,
    riskLevel: null,
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
    swarmId: null,
    swarmRole: null,
    taskType: null,
    roleHint: null,
    parentTaskId: null,
    cancellationGroup: null,
    acceptanceCriteria: null,
    expectedArtifacts: null,
    riskLevel: null,
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

test("toLaunchSwarmInputs applies shared defaults and swarm metadata", () => {
  const prepared = toLaunchSwarmInputs({
    cwd: "/tmp/project",
    model: "gpt-test",
    timeoutMinutes: 7,
    tools: ["read"],
    priority: "high",
    tasks: [
      { task: "Find relevant files", role: "scout" },
      { task: "Review likely changes", role: "reviewer", tools: ["read", "bash"] },
    ],
  }, "/fallback", "swarm-fixed");

  assert.equal(prepared.swarmId, "swarm-fixed");
  assert.deepEqual(prepared.tasks.map((task) => ({
    task: task.task,
    cwd: task.cwd,
    model: task.model,
    timeoutMinutes: task.timeoutMinutes,
    tools: task.tools,
    priority: task.priority,
    swarmId: task.swarmId,
    swarmRole: task.swarmRole,
  })), [
    {
      task: "Find relevant files",
      cwd: "/tmp/project",
      model: "gpt-test",
      timeoutMinutes: 7,
      tools: ["read"],
      priority: "high",
      swarmId: "swarm-fixed",
      swarmRole: "scout",
    },
    {
      task: "Review likely changes",
      cwd: "/tmp/project",
      model: "gpt-test",
      timeoutMinutes: 7,
      tools: ["read", "bash"],
      priority: "high",
      swarmId: "swarm-fixed",
      swarmRole: "reviewer",
    },
  ]);
});

test("buildDelegateSwarmText and result expose all task ids", () => {
  const tasks = [
    makeTask({ id: "task-1", swarmId: "swarm-1", swarmRole: "scout" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", swarmRole: "reviewer" }),
  ];
  const text = buildDelegateSwarmText("swarm-1", tasks, true);
  assert.match(text, /Created background worker swarm swarm-1 with 2 task\(s\)/);
  assert.match(text, /waitForResults is not supported in v0/);
  assert.match(text, /task-1/);
  assert.match(text, /task-2/);

  const result = buildDelegateSwarmResult("swarm-1", tasks, false);
  assert.equal(result.details.swarmId, "swarm-1");
  assert.deepEqual(result.details.taskIds, ["task-1", "task-2"]);
});
