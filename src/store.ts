import { promises as fs } from "node:fs";
import path from "node:path";

import { getStatePaths, getTaskPaths, type StatePaths } from "./paths.js";
import type { TaskEvent, TaskRecord, TaskResult } from "./types.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendTextFile(filePath: string, text: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, text, "utf8");
}

export interface StoreOptions {
  stateRoot?: string;
}

function normalizeTaskRecord(task: TaskRecord): TaskRecord {
  return {
    ...task,
    reportedAt: task.reportedAt ?? null,
  };
}

function normalizeTaskResult(result: TaskResult): TaskResult {
  const outputFormatSatisfied = result.outputFormatSatisfied ?? false;
  const validationIssues = Array.isArray(result.validationIssues) ? result.validationIssues : [];
  return {
    ...result,
    outputFormatSatisfied,
    validationIssues:
      !outputFormatSatisfied && validationIssues.length === 0
        ? ["Legacy task result is missing structured validation metadata."]
        : validationIssues,
  };
}

export class TaskStore {
  readonly paths: StatePaths;

  constructor(options: StoreOptions = {}) {
    this.paths = getStatePaths(options.stateRoot);
  }

  async ensureStateRoot(): Promise<void> {
    await ensureDir(this.paths.stateRoot);
    await ensureDir(this.paths.tasksDir);
  }

  async listTasks(): Promise<TaskRecord[]> {
    await this.ensureStateRoot();
    const tasks = await readJsonFile<TaskRecord[]>(this.paths.tasksIndexPath, []);
    return tasks.map(normalizeTaskRecord);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const taskPaths = getTaskPaths(taskId, this.paths.stateRoot);
    if (await pathExists(taskPaths.metaPath)) {
      const task = await readJsonFile<TaskRecord | null>(taskPaths.metaPath, null);
      return task ? normalizeTaskRecord(task) : null;
    }

    const tasks = await this.listTasks();
    return tasks.find((task) => task.id === taskId) ?? null;
  }

  async createTask(task: TaskRecord): Promise<void> {
    await this.ensureStateRoot();
    const normalizedTask = normalizeTaskRecord(task);
    const tasks = await this.listTasks();
    const filtered = tasks.filter((entry) => entry.id !== normalizedTask.id);
    filtered.push(normalizedTask);
    filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeJsonFile(this.paths.tasksIndexPath, filtered);
    await writeJsonFile(getTaskPaths(normalizedTask.id, this.paths.stateRoot).metaPath, normalizedTask);
  }

  async updateTask(task: TaskRecord): Promise<void> {
    await this.createTask(task);
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    await this.ensureStateRoot();
    await appendTextFile(this.paths.eventsPath, `${JSON.stringify(event)}\n`);
  }

  async writeResult(result: TaskResult): Promise<void> {
    await this.ensureStateRoot();
    const normalizedResult = normalizeTaskResult(result);
    await writeJsonFile(getTaskPaths(normalizedResult.taskId, this.paths.stateRoot).resultPath, normalizedResult);
  }

  async getResult(taskId: string): Promise<TaskResult | null> {
    const result = await readJsonFile<TaskResult | null>(getTaskPaths(taskId, this.paths.stateRoot).resultPath, null);
    return result ? normalizeTaskResult(result) : null;
  }

  async appendWorkerStdoutEvent(taskId: string, event: unknown): Promise<void> {
    await this.ensureStateRoot();
    const taskPaths = getTaskPaths(taskId, this.paths.stateRoot);
    await appendTextFile(taskPaths.stdoutPath, `${JSON.stringify(event)}\n`);
  }

  async appendWorkerStderr(taskId: string, chunk: string): Promise<void> {
    await this.ensureStateRoot();
    const taskPaths = getTaskPaths(taskId, this.paths.stateRoot);
    await appendTextFile(taskPaths.stderrPath, chunk);
  }
}
