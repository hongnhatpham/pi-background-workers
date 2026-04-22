import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletionMessage,
  buildStatusText,
  buildTaskDetailWidget,
  buildTaskListWidget,
  buildTaskResultWidget,
  formatTaskLine,
  summarizeCompletion,
} from "../src/index.js";
import type { TaskRecord, TaskResult } from "../src/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    title: "Investigate stale CSS on homepage",
    task: "Investigate stale CSS on homepage",
    status: "running",
    cwd: "/tmp/project",
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:01:00.000Z",
    startedAt: "2026-04-22T12:00:10.000Z",
    finishedAt: null,
    pid: 1234,
    exitCode: null,
    model: null,
    tools: null,
    priority: "normal",
    timeoutMinutes: 5,
    error: null,
    latestNote: "Inspecting Vite CSS output",
    resultSummary: null,
    reportedAt: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "task-1",
    status: "succeeded",
    summary: "Found the stale CSS cause",
    done: "Restarted Vite with --force and confirmed fresh CSS.",
    filesChanged: ["src/styles.css"],
    notes: "Need to audit selector conflicts next.",
    rawOutput: "## Done\nRestarted Vite",
    finishedAt: "2026-04-22T12:05:00.000Z",
    outputFormatSatisfied: true,
    validationIssues: [],
    ...overrides,
  };
}

test("formatTaskLine includes status id title and note", () => {
  const line = formatTaskLine(makeTask());
  assert.match(line, /^\[running\] task-1 · Investigate stale CSS on homepage/);
  assert.match(line, /Inspecting Vite CSS output/);
});

test("buildStatusText summarizes running queued and recent buckets", () => {
  const text = buildStatusText({
    running: [makeTask()],
    queued: [makeTask({ id: "task-2", status: "queued" })],
    recent: [makeTask({ id: "task-3", status: "succeeded" })],
  });

  assert.equal(text, "BG 1 running · 1 queued · 1 recent");
});

test("buildTaskListWidget renders grouped task lines", () => {
  const lines = buildTaskListWidget({
    running: [makeTask()],
    queued: [makeTask({ id: "task-2", status: "queued" })],
    recent: [makeTask({ id: "task-3", status: "succeeded" })],
  });

  assert.ok(lines.includes("Running"));
  assert.ok(lines.includes("Queued"));
  assert.ok(lines.includes("Recent"));
  assert.ok(lines.some((line) => line.includes("task-1")));
  assert.ok(lines.some((line) => line.includes("task-2")));
  assert.ok(lines.some((line) => line.includes("task-3")));
});

test("buildTaskDetailWidget includes task metadata and result summary", () => {
  const lines = buildTaskDetailWidget(makeTask(), makeResult());
  assert.ok(lines.includes("ID: task-1"));
  assert.ok(lines.includes("Status: running"));
  assert.ok(lines.includes("Summary: Found the stale CSS cause"));
  assert.ok(lines.some((line) => line.includes("src/styles.css")));
});

test("buildTaskResultWidget renders normalized result sections", () => {
  const lines = buildTaskResultWidget(makeTask({ status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z" }), makeResult());
  assert.ok(lines.includes("Done"));
  assert.ok(lines.includes("Restarted Vite with --force and confirmed fresh CSS."));
  assert.ok(lines.includes("Files Changed"));
  assert.ok(lines.includes("- src/styles.css"));
  assert.ok(lines.includes("Notes"));
  assert.ok(lines.includes("Need to audit selector conflicts next."));
});

test("buildCompletionMessage includes summary and inspection commands", () => {
  const completion = buildCompletionMessage(makeTask({ status: "succeeded" }), makeResult());
  assert.match(completion.content, /Background task finished: Investigate stale CSS on homepage/);
  assert.match(completion.content, /Summary: Found the stale CSS cause/);
  assert.equal(completion.details.showCommand, "/bg-show task-1");
  assert.equal(completion.details.resultsCommand, "/bg-results task-1");
});

test("buildCompletionMessage suppresses output quality note for cancelled tasks", () => {
  const completion = buildCompletionMessage(
    makeTask({ status: "cancelled", title: "Dogfood test task" }),
    makeResult({
      status: "cancelled",
      summary: "Cancelled before launch",
      outputFormatSatisfied: false,
      validationIssues: ["Task was cancelled before worker output was produced."],
    }),
  );
  assert.match(completion.content, /Summary: Cancelled before launch/);
  assert.doesNotMatch(completion.content, /Output quality note:/);
});

test("summarizeCompletion collapses unstructured file listings", () => {
  const summary = summarizeCompletion(makeResult({
    outputFormatSatisfied: false,
    validationIssues: ["Missing ## Done section content."],
    done: "",
    rawOutput: [
      "docs/spec.md",
      "docs/implementation-plan.md",
      "README.md",
      "shell/shell.qml",
      "shell/services/AudioService.qml",
      "scripts/update_state.py",
    ].join("\n"),
  }));
  assert.equal(summary, "Worker finished but returned an unstructured file listing instead of a usable summary.");
});

test("summarizeCompletion collapses short pure file listings", () => {
  const summary = summarizeCompletion(makeResult({
    outputFormatSatisfied: false,
    validationIssues: ["Legacy task result is missing structured validation metadata."],
    done: "",
    rawOutput: [
      "/home/hongnhatpham/.nvm/.git",
      "/home/hongnhatpham/.nvm/package.json",
      "/home/hongnhatpham/package.json",
    ].join("\n"),
  }));
  assert.equal(summary, "Worker finished but returned an unstructured file listing instead of a usable summary.");
});
