import crypto from "node:crypto";

import { TaskStore } from "./store.js";
import { runWorkerInBackground, type WorkerHandle } from "./worker-runner.js";
import type { RuntimeConfig, TaskPriority, TaskRecord, TaskResult, TaskStatus } from "./types.js";

export interface RuntimeOptions {
  store?: TaskStore;
  config?: Partial<RuntimeConfig>;
  piCommand?: string;
  now?: () => string;
}

export interface LaunchTaskInput {
  task: string;
  title?: string;
  cwd: string;
  model?: string | null;
  tools?: string[] | null;
  priority?: TaskPriority;
  timeoutMinutes?: number | null;
  swarmId?: string | null;
  swarmRole?: string | null;
  taskType?: string | null;
  roleHint?: string | null;
  parentTaskId?: string | null;
  cancellationGroup?: string | null;
  acceptanceCriteria?: string | null;
  expectedArtifacts?: string[] | null;
  riskLevel?: string | null;
}

export interface TaskList {
  running: TaskRecord[];
  queued: TaskRecord[];
  recent: TaskRecord[];
}

const DEFAULT_CONFIG: RuntimeConfig = {
  stateRoot: "",
  maxConcurrentWorkers: 3,
  defaultTimeoutMinutes: 20,
};

function compareByCreatedAt(a: TaskRecord, b: TaskRecord): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function compareByUpdatedAtDesc(a: TaskRecord, b: TaskRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function isFinishedStatus(status: TaskStatus): status is Extract<TaskStatus, "succeeded" | "failed" | "cancelled" | "timed_out"> {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function isRunningLike(status: TaskStatus): boolean {
  return status === "running" || status === "cancelling";
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function buildTaskId(now: string): string {
  const stamp = now.replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${stamp}-${suffix}`;
}

export class BackgroundWorkerRuntime {
  readonly store: TaskStore;
  readonly config: RuntimeConfig;
  readonly piCommand?: string;
  readonly now: () => string;

  private readonly runningHandles = new Map<string, WorkerHandle>();
  private shuttingDown = false;

  constructor(options: RuntimeOptions = {}) {
    this.store = options.store ?? new TaskStore(options.config?.stateRoot ? { stateRoot: options.config.stateRoot } : {});
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
      stateRoot: options.config?.stateRoot ?? this.store.paths.stateRoot,
    };
    this.piCommand = options.piCommand;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<void> {
    this.shuttingDown = false;
    await this.store.ensureStateRoot();
    await this.reconcileTasksFromDisk();
    await this.pumpQueue();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.runningHandles.clear();
  }

  private buildQueuedTask(input: LaunchTaskInput, createdAt = this.now()): TaskRecord {
    return {
      id: buildTaskId(createdAt),
      title: input.title?.trim() || input.task.trim().slice(0, 80),
      task: input.task,
      status: "queued",
      cwd: input.cwd,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      pid: null,
      exitCode: null,
      model: input.model ?? null,
      tools: input.tools ?? null,
      priority: input.priority ?? "normal",
      timeoutMinutes: input.timeoutMinutes ?? this.config.defaultTimeoutMinutes,
      error: null,
      latestNote: "Queued",
      resultSummary: null,
      reportedAt: null,
      swarmId: input.swarmId ?? null,
      swarmRole: input.swarmRole ?? input.roleHint ?? null,
      taskType: input.taskType ?? null,
      roleHint: input.roleHint ?? input.swarmRole ?? null,
      parentTaskId: input.parentTaskId ?? null,
      cancellationGroup: input.cancellationGroup ?? input.swarmId ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      expectedArtifacts: input.expectedArtifacts ?? null,
      riskLevel: input.riskLevel ?? null,
    };
  }

  private async createQueuedTask(input: LaunchTaskInput): Promise<TaskRecord> {
    const createdAt = this.now();
    const task = this.buildQueuedTask(input, createdAt);

    await this.store.createTask(task);
    await this.store.appendEvent({
      taskId: task.id,
      at: createdAt,
      kind: "task.created",
      message: "Task created",
      payload: { cwd: task.cwd, priority: task.priority },
    });

    return (await this.store.getTask(task.id)) ?? task;
  }

  async launchTask(input: LaunchTaskInput): Promise<TaskRecord> {
    const task = await this.createQueuedTask(input);
    await this.pumpQueue();
    return (await this.store.getTask(task.id)) ?? task;
  }

  async launchTasks(inputs: LaunchTaskInput[]): Promise<TaskRecord[]> {
    const created: TaskRecord[] = [];
    for (const input of inputs) created.push(await this.createQueuedTask(input));
    await this.pumpQueue();
    const refreshed = await Promise.all(created.map((task) => this.store.getTask(task.id)));
    return refreshed.map((task, index) => task ?? created[index]);
  }

  async cancelTask(taskId: string): Promise<{ accepted: boolean; task: TaskRecord | null }> {
    const handle = this.runningHandles.get(taskId);
    if (handle) {
      const task = await handle.cancel();
      return { accepted: true, task: task ?? await this.store.getTask(taskId) };
    }

    const task = await this.store.getTask(taskId);
    if (!task) return { accepted: false, task: null };
    if (task.status !== "queued") return { accepted: false, task };

    const at = this.now();
    const cancelled: TaskRecord = {
      ...task,
      status: "cancelled",
      updatedAt: at,
      finishedAt: at,
      latestNote: "Cancelled before launch",
      resultSummary: "Cancelled before launch",
      error: null,
      reportedAt: task.reportedAt,
    };
    await this.store.updateTask(cancelled);
    await this.store.writeResult({
      taskId: cancelled.id,
      status: "cancelled",
      summary: "Cancelled before launch",
      done: "",
      filesChanged: [],
      notes: "Task was cancelled before a worker process started.",
      rawOutput: "Cancelled before launch",
      finishedAt: at,
      outputFormatSatisfied: false,
      validationIssues: ["Task was cancelled before worker output was produced."],
    });
    await this.store.appendEvent({
      taskId: cancelled.id,
      at,
      kind: "task.cancelled",
      message: "Cancelled before launch",
    });
    return { accepted: true, task: cancelled };
  }

  async cancelSwarm(swarmId: string): Promise<{ swarmId: string; accepted: number; rejected: number; tasks: TaskRecord[] }> {
    const tasks = (await this.store.listTasks()).filter((task) => task.swarmId === swarmId || task.cancellationGroup === swarmId);
    let accepted = 0;
    let rejected = 0;
    const updated: TaskRecord[] = [];
    for (const task of tasks) {
      const result = await this.cancelTask(task.id);
      if (result.accepted) accepted += 1;
      else rejected += 1;
      if (result.task) updated.push(result.task);
    }
    return { swarmId, accepted, rejected, tasks: updated };
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.store.getTask(taskId);
  }

  async getSwarmTasks(swarmId: string): Promise<TaskRecord[]> {
    return (await this.store.listTasks()).filter((task) => task.swarmId === swarmId || task.cancellationGroup === swarmId);
  }

  async getTaskResult(taskId: string): Promise<TaskResult | null> {
    return this.store.getResult(taskId);
  }

  async listTasks(limitRecent = 10): Promise<TaskList> {
    const tasks = await this.store.listTasks();
    const running = tasks.filter((task) => isRunningLike(task.status)).sort(compareByUpdatedAtDesc);
    const queued = tasks.filter((task) => task.status === "queued").sort(compareByCreatedAt);
    const recent = tasks.filter((task) => isFinishedStatus(task.status)).sort(compareByUpdatedAtDesc).slice(0, limitRecent);
    return { running, queued, recent };
  }

  async reconcileTasksFromDisk(): Promise<void> {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      if (!isRunningLike(task.status)) continue;
      if (this.runningHandles.has(task.id)) continue;
      if (isProcessAlive(task.pid)) continue;

      const at = this.now();
      const reconciled: TaskRecord = {
        ...task,
        status: "failed",
        updatedAt: at,
        finishedAt: task.finishedAt ?? at,
        latestNote: "Worker was interrupted before runtime could reattach",
        resultSummary: task.resultSummary ?? "Worker was interrupted before runtime could reattach",
        error: task.error ?? "Worker was interrupted before runtime could reattach",
        reportedAt: task.reportedAt,
      };
      await this.store.updateTask(reconciled);
      await this.store.writeResult({
        taskId: task.id,
        status: "failed",
        summary: reconciled.resultSummary ?? "Worker was interrupted before runtime could reattach",
        done: "",
        filesChanged: [],
        notes: "Marked failed during runtime reconciliation because the in-memory worker handle no longer existed.",
        rawOutput: reconciled.error ?? "Worker was interrupted before runtime could reattach",
        finishedAt: reconciled.finishedAt ?? at,
        outputFormatSatisfied: false,
        validationIssues: ["Worker did not complete normally before runtime reconciliation."],
      });
      await this.store.appendEvent({
        taskId: task.id,
        at,
        kind: "task.failed",
        message: "Marked failed during runtime reconciliation",
      });
    }
  }

  private async pumpQueue(): Promise<void> {
    if (this.shuttingDown) return;

    while (this.runningHandles.size < this.config.maxConcurrentWorkers) {
      const tasks = await this.store.listTasks();
      const next = tasks
        .filter((task) => task.status === "queued")
        .sort(compareByCreatedAt)[0];

      if (!next) return;
      await this.startQueuedTask(next);
    }
  }

  private async startQueuedTask(task: TaskRecord): Promise<void> {
    if (this.runningHandles.has(task.id)) return;

    const handle = await runWorkerInBackground({
      store: this.store,
      task,
      piCommand: this.piCommand,
      now: this.now,
    });

    this.runningHandles.set(task.id, handle);

    void handle.finished.finally(async () => {
      this.runningHandles.delete(task.id);
      await this.pumpQueue();
    });
  }
}
