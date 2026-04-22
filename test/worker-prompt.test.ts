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
  });

  assert.match(prompt, /Task ID: task-123/);
  assert.match(prompt, /Title: Audit CSS issue/);
  assert.match(prompt, /Working directory: \/tmp\/project/);
  assert.match(prompt, /Objective: Audit why CSS is stale/);
  assert.match(prompt, /## Done/);
  assert.match(prompt, /## Files Changed/);
  assert.match(prompt, /## Notes/);
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
