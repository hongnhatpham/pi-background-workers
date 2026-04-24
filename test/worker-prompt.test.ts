import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { buildWorkerSystemPrompt, writeWorkerPromptFile } from "../src/worker-prompt.js";

test("buildWorkerSystemPrompt includes task metadata and required sections", () => {
  const prompt = buildWorkerSystemPrompt({
    id: "task-123",
    title: "Audit CSS issue",
    task: "Audit why CSS is stale",
    cwd: "/tmp/project",
    swarmId: null,
    swarmRole: null,
  });

  assert.match(prompt, /Task ID: task-123/);
  assert.match(prompt, /Title: Audit CSS issue/);
  assert.match(prompt, /Working directory: \/tmp\/project/);
  assert.match(prompt, /Objective: Audit why CSS is stale/);
  assert.match(prompt, /Do not launch or delegate new background workers/);
  assert.match(prompt, /## Done/);
  assert.match(prompt, /## Files Changed/);
  assert.match(prompt, /## Notes/);
});

test("buildWorkerSystemPrompt adds swarm coordination when task belongs to a swarm", () => {
  const prompt = buildWorkerSystemPrompt({
    id: "task-123",
    title: "Review worker policy",
    task: "Review the worker policy slice",
    cwd: "/tmp/project",
    swarmId: "swarm-1",
    swarmRole: "reviewer",
  });

  assert.match(prompt, /Swarm coordination:/);
  assert.match(prompt, /one disposable worker in a parallel swarm/);
  assert.match(prompt, /Swarm ID: swarm-1/);
  assert.match(prompt, /Swarm role: reviewer/);
});

test("buildWorkerSystemPrompt includes richer swarm task contract metadata", () => {
  const prompt = buildWorkerSystemPrompt({
    id: "task-123",
    title: "Verify swarm metadata",
    task: "Verify the metadata path",
    cwd: "/tmp/project",
    swarmId: "swarm-1",
    swarmRole: "verifier",
    taskType: "verification",
    roleHint: "test-runner",
    cancellationGroup: "swarm-1",
    acceptanceCriteria: "Report whether typecheck and tests pass.",
    expectedArtifacts: ["test output", "risk notes"],
    riskLevel: "low",
  });

  assert.match(prompt, /Task type: verification/);
  assert.match(prompt, /Role hint: test-runner/);
  assert.match(prompt, /Cancellation group: swarm-1/);
  assert.match(prompt, /Acceptance criteria: Report whether typecheck and tests pass\./);
  assert.match(prompt, /Expected artifacts: test output; risk notes/);
  assert.match(prompt, /Explicitly state whether the acceptance criteria were met/);
});

test("writeWorkerPromptFile writes a private prompt file", async () => {
  const written = await writeWorkerPromptFile("hello worker", "pi-bg-worker-test-");
  try {
    const content = await fs.readFile(written.filePath, "utf8");
    assert.equal(content, "hello worker");
    const stat = await fs.stat(written.filePath);
    assert.ok(stat.isFile());
    assert.equal(path.basename(written.filePath), "system-prompt.md");
    assert.match(written.dir, new RegExp(`${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*pi-bg-worker-test-`));
  } finally {
    await fs.rm(written.dir, { recursive: true, force: true });
  }
});
