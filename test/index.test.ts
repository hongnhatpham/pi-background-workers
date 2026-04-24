import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletionDeliveryOptions,
  buildCompletionMessage,
  buildSwarmCompletionMessage,
  buildLaunchMessage,
  buildStatusText,
  buildSwarmCancelWidget,
  buildSwarmDetailWidget,
  buildSwarmLaunchMessage,
  assessSwarmOpportunity,
  buildDelegationFirstBlockReason,
  buildSwarmPolicyPrompt,
  buildSuggestedSwarmShape,
  buildTaskDetailWidget,
  buildTaskListWidget,
  buildTaskResultWidget,
  formatTaskLine,
  planCompletionReports,
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

test("formatTaskLine includes swarm metadata when present", () => {
  const line = formatTaskLine(makeTask({ swarmId: "swarm-1", swarmRole: "scout" }));
  assert.match(line, /task-1 · swarm swarm-1\/scout · Investigate stale CSS/);
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

test("buildLaunchMessage makes delegated work visible and inspectable", () => {
  const launch = buildLaunchMessage(makeTask(), true);
  assert.match(launch.content, /Background task started: Investigate stale CSS on homepage/);
  assert.match(launch.content, /waitForResult is ignored/);
  assert.equal(launch.details.showCommand, "/bg-show task-1");
  assert.equal(launch.details.resultsCommand, "/bg-results task-1");
  assert.equal(launch.details.cancelCommand, "/bg-cancel task-1");
});

test("buildSwarmDetailWidget renders grouped swarm tasks", () => {
  const lines = buildSwarmDetailWidget("swarm-1", [
    makeTask({ id: "task-1", swarmId: "swarm-1", swarmRole: "scout", status: "succeeded", latestNote: "Mapped files" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", swarmRole: "reviewer", status: "queued" }),
  ]);
  assert.ok(lines.includes("Swarm: swarm-1"));
  assert.ok(lines.some((line) => line.includes("succeeded=1")));
  assert.ok(lines.some((line) => line.includes("task-1 [succeeded] scout")));
});

test("buildSwarmCancelWidget renders plan-level cancellation", () => {
  const lines = buildSwarmCancelWidget("swarm-1", 1, 1, [
    makeTask({ id: "task-1", swarmId: "swarm-1", status: "cancelled" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", status: "succeeded" }),
  ]);
  assert.ok(lines.includes("Swarm cancellation requested: swarm-1"));
  assert.ok(lines.includes("Accepted: 1"));
  assert.ok(lines.some((line) => line.includes("task-2 [succeeded]")));
});

test("buildSwarmLaunchMessage makes a swarm visible and inspectable", () => {
  const launch = buildSwarmLaunchMessage("swarm-1", [
    makeTask({ id: "task-1", swarmId: "swarm-1", swarmRole: "scout" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", swarmRole: "reviewer" }),
  ], true);
  assert.match(launch.content, /Background worker swarm started: swarm-1/);
  assert.match(launch.content, /task-1 \[running\] scout/);
  assert.match(launch.content, /waitForResults is ignored/);
  assert.equal(launch.details.taskCount, 2);
  assert.deepEqual(launch.details.tasks.map((task) => task.taskId), ["task-1", "task-2"]);
});

test("buildCompletionMessage includes summary and inspection commands", () => {
  const completion = buildCompletionMessage(makeTask({ status: "succeeded" }), makeResult());
  assert.match(completion.content, /Background task finished: Investigate stale CSS on homepage/);
  assert.match(completion.content, /Summary: Found the stale CSS cause/);
  assert.equal(completion.details.showCommand, "/bg-show task-1");
  assert.equal(completion.details.resultsCommand, "/bg-results task-1");
});

test("buildSwarmCompletionMessage renders grouped completion with adoption boundary", () => {
  const tasks = [
    makeTask({ id: "task-1", swarmId: "swarm-1", swarmRole: "scout", taskType: "scout", status: "succeeded", cwd: "/tmp/a" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", swarmRole: "verifier", taskType: "verification", status: "failed", cwd: "/tmp/a" }),
  ];
  const results = [
    makeResult({ taskId: "task-1", status: "succeeded", summary: "Mapped runtime flow", filesChanged: ["src/index.ts"] }),
    makeResult({ taskId: "task-2", status: "failed", summary: "Found a regression", filesChanged: ["test/index.test.ts"], outputFormatSatisfied: false, validationIssues: ["Missing Notes section."] }),
  ];
  const completion = buildSwarmCompletionMessage("swarm-1", tasks, results);
  assert.match(completion.content, /Background worker swarm finished: swarm-1/);
  assert.match(completion.content, /scout \[succeeded\]: Mapped runtime flow/);
  assert.match(completion.content, /verifier \[failed\]: Found a regression/);
  assert.match(completion.content, /\/bg-show-swarm swarm-1/);
  assert.match(completion.content, /\/aria swarm review swarm-1 --write-inbox/);
  assert.match(completion.content, /This is not adopted yet/);
  assert.equal(completion.details.status, "partial");
  assert.equal(completion.details.adoptionBoundary, "not_adopted");
  assert.equal(completion.details.reviewBoundary, "review_not_opened");
  assert.deepEqual(completion.details.changedFiles, ["src/index.ts", "test/index.test.ts"]);
  assert.deepEqual(completion.details.validationIssues, ["Missing Notes section."]);
  assert.equal(completion.details.commands.openReview, "/aria swarm review swarm-1 --write-inbox");
  assert.equal(completion.details.tasks[1].cwd, "/tmp/a");
  assert.equal(completion.details.tasks[1].filesChanged[0], "test/index.test.ts");
});

test("planCompletionReports holds swarm completion until all tasks are terminal", () => {
  const plans = planCompletionReports([
    makeTask({ id: "task-1", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", status: "running", finishedAt: null }),
  ], null);
  assert.deepEqual(plans, []);
});

test("planCompletionReports reports a terminal swarm once instead of per task", () => {
  const plans = planCompletionReports([
    makeTask({ id: "task-1", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:06:00.000Z" }),
    makeTask({ id: "task-3", status: "succeeded", finishedAt: "2026-04-22T12:07:00.000Z" }),
  ], null);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].kind, "task");
  assert.equal(plans[1].kind, "swarm");
  assert.equal(plans[1].kind === "swarm" ? plans[1].swarmId : null, "swarm-1");
  assert.deepEqual(plans[1].tasks.map((task) => task.id), ["task-1", "task-2"]);
});

test("planCompletionReports marks old pre-cutoff swarms reported without display", () => {
  const plans = planCompletionReports([
    makeTask({ id: "task-1", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:06:00.000Z" }),
  ], "2026-04-22T12:10:00.000Z");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "mark-only");
  assert.equal(plans[0].kind === "mark-only" ? plans[0].reason : null, "pre_cutoff");
});

test("planCompletionReports marks partially reported legacy swarms without noisy child completion", () => {
  const plans = planCompletionReports([
    makeTask({ id: "task-1", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z", reportedAt: "2026-04-22T12:05:10.000Z" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:06:00.000Z" }),
  ], null);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "mark-only");
  assert.equal(plans[0].kind === "mark-only" ? plans[0].reason : null, "partially_reported_swarm");
  assert.deepEqual(plans[0].tasks.map((task) => task.id), ["task-2"]);
});

test("planCompletionReports only reports owned tasks in the owning session", () => {
  const tasks = [
    makeTask({ id: "task-1", status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z", ownerSessionId: "session-a" }),
    makeTask({ id: "task-2", status: "succeeded", finishedAt: "2026-04-22T12:06:00.000Z", ownerSessionId: "session-b" }),
    makeTask({ id: "task-3", status: "succeeded", finishedAt: "2026-04-22T12:07:00.000Z" }),
  ];
  const sessionAPlans = planCompletionReports(tasks, null, "session-a");
  assert.deepEqual(sessionAPlans.map((plan) => plan.tasks.map((task) => task.id)).flat(), ["task-3", "task-1"]);

  const unknownSessionPlans = planCompletionReports(tasks, null, null);
  assert.deepEqual(unknownSessionPlans.map((plan) => plan.tasks.map((task) => task.id)).flat(), ["task-3"]);
});

test("planCompletionReports groups only swarm tasks owned by the current session", () => {
  const plans = planCompletionReports([
    makeTask({ id: "task-1", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:05:00.000Z", ownerSessionId: "session-a" }),
    makeTask({ id: "task-2", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:06:00.000Z", ownerSessionId: "session-a" }),
    makeTask({ id: "task-3", swarmId: "swarm-1", status: "succeeded", finishedAt: "2026-04-22T12:07:00.000Z", ownerSessionId: "session-b" }),
  ], null, "session-a");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, "swarm");
  assert.deepEqual(plans[0].tasks.map((task) => task.id), ["task-1", "task-2"]);
});

test("buildCompletionDeliveryOptions steers active reports and follows up idle reports", () => {
  assert.deepEqual(buildCompletionDeliveryOptions(false), { triggerTurn: false, deliverAs: "steer" });
  assert.deepEqual(buildCompletionDeliveryOptions(true), { triggerTurn: true, deliverAs: "followUp" });
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

test("assessSwarmOpportunity classifies multi-strand coding work as swarm-worthy", () => {
  const assessment = assessSwarmOpportunity("Investigate this extension, implement a fix, and add tests/review across the repo in parallel");
  assert.equal(assessment.level, "explicit");
  assert.ok(assessment.reasons.length >= 3);
});

test("assessSwarmOpportunity treats delegation-system requests as explicit swarm opportunities", () => {
  const assessment = assessSwarmOpportunity("Evolve delegation into an agent swarm system and parallelize as much task as makes sense");
  assert.equal(assessment.level, "explicit");
  assert.ok(assessment.reasons.some((reason) => reason.includes("explicitly")));
  assert.ok(assessment.reasons.some((reason) => reason.includes("architecture")));
});

test("buildDelegationFirstBlockReason nudges explicit delegation requests before local tools", () => {
  const assessment = assessSwarmOpportunity("Please evolve delegation into an agent swarm system and parallelize as much as makes sense");
  const reason = buildDelegationFirstBlockReason(assessment, "bash");
  assert.match(reason ?? "", /Delegation-first policy/);
  assert.match(reason ?? "", /delegate_swarm/);
  assert.equal(buildDelegationFirstBlockReason(assessment, "delegate_swarm"), null);
});

test("buildDelegationFirstBlockReason nudges swarm-worthy edits before mutating tools", () => {
  const assessment = assessSwarmOpportunity("Implement and review a multi-file runtime change, update docs, and add tests");
  assert.equal(assessment.level, "swarm");
  assert.match(buildDelegationFirstBlockReason(assessment, "edit") ?? "", /swarm-worthy/);
  assert.equal(buildDelegationFirstBlockReason(assessment, "read"), null);
});

test("buildSuggestedSwarmShape proposes bounded worker slices", () => {
  const lines = buildSuggestedSwarmShape({
    level: "swarm",
    reasons: [
      "there is a reconnaissance strand",
      "there is an architecture or planning strand",
      "there is a verification strand",
    ],
  });
  assert.ok(lines.some((line) => line.includes("scout/recon")));
  assert.ok(lines.some((line) => line.includes("architecture/planning")));
  assert.ok(lines.some((line) => line.includes("verification/review")));
});

test("buildSwarmPolicyPrompt advertises delegate_swarm", () => {
  const prompt = buildSwarmPolicyPrompt("Implement and review a multi-file package change");
  assert.match(prompt, /Background worker swarm policy/);
  assert.match(prompt, /delegate_swarm/);
  assert.match(prompt, /2-4 workers/);
  assert.match(prompt, /delegation triage/);
});
