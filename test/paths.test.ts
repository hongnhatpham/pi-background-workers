import test from "node:test";
import assert from "node:assert/strict";

import { getDefaultStateRoot, getStatePaths, getTaskPaths } from "../src/paths.js";

test("getDefaultStateRoot ends with pi-background-workers state dir", () => {
  assert.match(getDefaultStateRoot(), /\.local[\\/]state[\\/]pi-background-workers$/);
});

test("getStatePaths returns canonical top-level files", () => {
  const paths = getStatePaths("/tmp/pi-background-workers-test");
  assert.equal(paths.tasksIndexPath, "/tmp/pi-background-workers-test/tasks.json");
  assert.equal(paths.eventsPath, "/tmp/pi-background-workers-test/events.jsonl");
  assert.equal(paths.tasksDir, "/tmp/pi-background-workers-test/tasks");
});

test("getTaskPaths returns canonical task file layout", () => {
  const paths = getTaskPaths("task-123", "/tmp/pi-background-workers-test");
  assert.equal(paths.taskDir, "/tmp/pi-background-workers-test/tasks/task-123");
  assert.equal(paths.metaPath, "/tmp/pi-background-workers-test/tasks/task-123/meta.json");
  assert.equal(paths.stdoutPath, "/tmp/pi-background-workers-test/tasks/task-123/stdout.jsonl");
  assert.equal(paths.stderrPath, "/tmp/pi-background-workers-test/tasks/task-123/stderr.log");
  assert.equal(paths.resultPath, "/tmp/pi-background-workers-test/tasks/task-123/result.json");
});
