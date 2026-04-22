import os from "node:os";
import path from "node:path";

export interface StatePaths {
  stateRoot: string;
  tasksIndexPath: string;
  eventsPath: string;
  tasksDir: string;
}

export interface TaskPaths {
  taskDir: string;
  metaPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

export function getDefaultStateRoot(): string {
  return path.join(os.homedir(), ".local", "state", "pi-background-workers");
}

export function getStatePaths(stateRoot = getDefaultStateRoot()): StatePaths {
  return {
    stateRoot,
    tasksIndexPath: path.join(stateRoot, "tasks.json"),
    eventsPath: path.join(stateRoot, "events.jsonl"),
    tasksDir: path.join(stateRoot, "tasks"),
  };
}

export function getTaskPaths(taskId: string, stateRoot = getDefaultStateRoot()): TaskPaths {
  const { tasksDir } = getStatePaths(stateRoot);
  const taskDir = path.join(tasksDir, taskId);
  return {
    taskDir,
    metaPath: path.join(taskDir, "meta.json"),
    stdoutPath: path.join(taskDir, "stdout.jsonl"),
    stderrPath: path.join(taskDir, "stderr.log"),
    resultPath: path.join(taskDir, "result.json"),
  };
}
