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
    return readJsonFile<TaskRecord[]>(this.paths.tasksIndexPath, []);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const taskPaths = getTaskPaths(taskId, this.paths.stateRoot);
    if (await pathExists(taskPaths.metaPath)) {
      return readJsonFile<TaskRecord | null>(taskPaths.metaPath, null);
    }

    const tasks = await this.listTasks();
    return tasks.find((task) => task.id === taskId) ?? null;
  }

  async createTask(task: TaskRecord): Promise<void> {
    await this.ensureStateRoot();
    const tasks = await this.listTasks();
    const filtered = tasks.filter((entry) => entry.id !== task.id);
    filtered.push(task);
    filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeJsonFile(this.paths.tasksIndexPath, filtered);
    await writeJsonFile(getTaskPaths(task.id, this.paths.stateRoot).metaPath, task);
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
    await writeJsonFile(getTaskPaths(result.taskId, this.paths.stateRoot).resultPath, result);
  }

  async getResult(taskId: string): Promise<TaskResult | null> {
    return readJsonFile<TaskResult | null>(getTaskPaths(taskId, this.paths.stateRoot).resultPath, null);
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
