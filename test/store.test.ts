import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { TaskStore } from "../src/store.js";
import type { TaskEvent, TaskRecord, TaskResult } from "../src/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-background-workers-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    title: "Investigate issue",
    task: "Investigate issue in repo",
    status: "queued",
    cwd: "/tmp/project",
    createdAt: "2026-04-22T10:00:00.000Z",
    updatedAt: "2026-04-22T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    pid: null,
    exitCode: null,
    model: null,
    tools: null,
    priority: "normal",
    timeoutMinutes: null,
    error: null,
    latestNote: null,
    resultSummary: null,
    reportedAt: null,
    ownerSessionId: null,
    ownerSessionFile: null,
    reportDeliveryLog: null,
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

test("createTask persists task to index and task-local meta", async () => {
  const store = new TaskStore({ stateRoot: await makeTempRoot() });
  const task = makeTask();

  await store.createTask(task);

  const tasks = await store.listTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], task);

  const loaded = await store.getTask(task.id);
  assert.deepEqual(loaded, task);
});

test("updateTask replaces an existing task record", async () => {
  const store = new TaskStore({ stateRoot: await makeTempRoot() });
  const task = makeTask();
  await store.createTask(task);

  const updated = makeTask({ status: "running", startedAt: "2026-04-22T10:01:00.000Z", pid: 1234 });
  await store.updateTask(updated);

  const loaded = await store.getTask(task.id);
  assert.equal(loaded?.status, "running");
  assert.equal(loaded?.pid, 1234);
});

test("appendEvent writes JSONL events", async () => {
  const root = await makeTempRoot();
  const store = new TaskStore({ stateRoot: root });
  const event: TaskEvent = {
    taskId: "task-1",
    at: "2026-04-22T10:00:00.000Z",
    kind: "task.created",
    message: "Task created",
    payload: { source: "test" },
  };

  await store.appendEvent(event);

  const raw = await fs.readFile(path.join(root, "events.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), event);
});

test("writeResult and getResult persist normalized task results", async () => {
  const store = new TaskStore({ stateRoot: await makeTempRoot() });
  const result: TaskResult = {
    taskId: "task-1",
    status: "succeeded",
    summary: "Finished successfully",
    done: "Implemented the requested change",
    filesChanged: ["src/store.ts"],
    notes: "No blockers",
    rawOutput: "## Done\nImplemented",
    finishedAt: "2026-04-22T10:05:00.000Z",
    outputFormatSatisfied: true,
    validationIssues: [],
  };

  await store.writeResult(result);

  const loaded = await store.getResult("task-1");
  assert.deepEqual(loaded, result);
});

test("appendWorkerStdoutEvent and appendWorkerStderr persist worker logs", async () => {
  const root = await makeTempRoot();
  const store = new TaskStore({ stateRoot: root });

  await store.appendWorkerStdoutEvent("task-1", { type: "message_end", ok: true });
  await store.appendWorkerStderr("task-1", "warning: test\n");

  const stdout = await fs.readFile(path.join(root, "tasks", "task-1", "stdout.jsonl"), "utf8");
  const stderr = await fs.readFile(path.join(root, "tasks", "task-1", "stderr.log"), "utf8");

  assert.deepEqual(JSON.parse(stdout.trim()), { type: "message_end", ok: true });
  assert.equal(stderr, "warning: test\n");
});
