import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { BackgroundWorkerRuntime } from "../src/runtime.js";
import { TaskStore } from "../src/store.js";
import type { TaskRecord } from "../src/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-background-workers-runtime-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-existing",
    title: "Existing task",
    task: "Existing task body",
    status: "queued",
    cwd: process.cwd(),
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    pid: null,
    exitCode: null,
    model: null,
    tools: null,
    priority: "normal",
    timeoutMinutes: 1,
    error: null,
    latestNote: null,
    resultSummary: null,
    reportedAt: null,
    ...overrides,
  };
}

test("initialize reconciles stale running tasks to failed", async () => {
  const stateRoot = await makeTempRoot();
  const store = new TaskStore({ stateRoot });
  await store.createTask(makeTask({ status: "running", startedAt: "2026-04-22T12:01:00.000Z", pid: 999 }));

  const runtime = new BackgroundWorkerRuntime({ store, now: () => "2026-04-22T12:05:00.000Z" });
  await runtime.initialize();

  const task = await runtime.getTask("task-existing");
  assert.equal(task?.status, "failed");
  assert.equal(task?.resultSummary, "Worker was interrupted before runtime could reattach");

  const result = await runtime.getTaskResult("task-existing");
  assert.equal(result?.status, "failed");
});

test("launchTask creates queued task and stores it", async () => {
  const stateRoot = await makeTempRoot();
  const store = new TaskStore({ stateRoot });
  const runtime = new BackgroundWorkerRuntime({
    store,
    piCommand: process.execPath,
    now: () => "2026-04-22T12:10:00.000Z",
    config: { maxConcurrentWorkers: 0, defaultTimeoutMinutes: 5 },
  });

  await runtime.initialize();
  const task = await runtime.launchTask({
    task: "Investigate issue",
    cwd: process.cwd(),
    title: "Investigate issue",
  });

  assert.equal(task.status, "queued");
  const stored = await runtime.getTask(task.id);
  assert.equal(stored?.status, "queued");
});

test("cancelTask can cancel a queued task before launch", async () => {
  const stateRoot = await makeTempRoot();
  const store = new TaskStore({ stateRoot });
  const runtime = new BackgroundWorkerRuntime({
    store,
    now: () => "2026-04-22T12:15:00.000Z",
    config: { maxConcurrentWorkers: 0, defaultTimeoutMinutes: 5 },
  });

  await runtime.initialize();
  const task = await runtime.launchTask({
    task: "Long task",
    cwd: process.cwd(),
    title: "Long task",
  });

  const cancelled = await runtime.cancelTask(task.id);
  assert.equal(cancelled.accepted, true);
  assert.equal(cancelled.task?.status, "cancelled");

  const result = await runtime.getTaskResult(task.id);
  assert.equal(result?.status, "cancelled");
});

test("listTasks groups running queued and recent tasks", async () => {
  const stateRoot = await makeTempRoot();
  const store = new TaskStore({ stateRoot });
  await store.createTask(makeTask({ id: "running-1", status: "running", updatedAt: "2026-04-22T12:00:05.000Z" }));
  await store.createTask(makeTask({ id: "queued-1", status: "queued", createdAt: "2026-04-22T12:00:02.000Z", updatedAt: "2026-04-22T12:00:02.000Z" }));
  await store.createTask(makeTask({ id: "done-1", status: "succeeded", updatedAt: "2026-04-22T12:00:10.000Z", finishedAt: "2026-04-22T12:00:10.000Z" }));

  const runtime = new BackgroundWorkerRuntime({ store });
  const groups = await runtime.listTasks();

  assert.deepEqual(groups.running.map((task) => task.id), ["running-1"]);
  assert.deepEqual(groups.queued.map((task) => task.id), ["queued-1"]);
  assert.deepEqual(groups.recent.map((task) => task.id), ["done-1"]);
});
