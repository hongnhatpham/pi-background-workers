import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { DelegateTaskInput, DelegationEvent, DelegationSnapshot, DelegationTask, DelegationTaskStatus } from "./schema.js";

const STORE_DIR = path.join(os.homedir(), ".local", "state", "pi-subagent-orchestrator");
const SNAPSHOT_PATH = path.join(STORE_DIR, "tasks.json");
const EVENTS_PATH = path.join(STORE_DIR, "events.jsonl");
const MAX_RECENT_EVENTS = 60;

function now(): string {
  return new Date().toISOString();
}

function ensureStoreDir(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function appendJsonl(filePath: string, value: unknown): void {
  ensureStoreDir();
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readSnapshot(): DelegationSnapshot | undefined {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return undefined;
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as DelegationSnapshot;
  } catch {
    return undefined;
  }
}

export class TaskStore {
  private tasks = new Map<string, DelegationTask>();
  private events: DelegationEvent[] = [];

  constructor() {
    this.reload();
  }

  reload(): void {
    const snapshot = readSnapshot();
    this.tasks = new Map((snapshot?.tasks ?? []).map((task) => [task.id, task]));
    this.events = snapshot?.recentEvents ?? [];
  }

  private addEvent(kind: DelegationEvent["kind"], message: string, taskId?: string): DelegationEvent {
    const event: DelegationEvent = {
      id: randomUUID(),
      taskId,
      at: now(),
      kind,
      message,
    };
    this.events.push(event);
    this.events = this.events.slice(-MAX_RECENT_EVENTS);
    appendJsonl(EVENTS_PATH, event);
    this.writeSnapshot();
    return event;
  }

  private writeSnapshot(): void {
    ensureStoreDir();
    const snapshot: DelegationSnapshot = {
      version: 1,
      updatedAt: now(),
      tasks: this.listTasks(),
      recentEvents: this.listEvents(),
    };
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  }

  createTask(input: DelegateTaskInput): DelegationTask {
    this.reload();
    const createdAt = now();
    const parent = input.parentId ? this.tasks.get(input.parentId) : undefined;
    const task: DelegationTask = {
      id: randomUUID(),
      parentId: input.parentId,
      title: input.title,
      agent: input.agent,
      mode: input.mode,
      model: input.model,
      cwd: input.cwd,
      depth: parent ? parent.depth + 1 : 0,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      allowNestedDelegation: input.allowNestedDelegation,
      maxDepth: input.maxDepth,
      includeMemoryRead: input.includeMemoryRead,
      allowedTools: [...input.allowedTools],
      childIds: [],
    };
    this.tasks.set(task.id, task);
    if (parent) {
      parent.childIds.push(task.id);
      parent.updatedAt = now();
    }
    this.addEvent("task.created", `${task.agent} queued (${task.mode}): ${task.title}`, task.id);
    return task;
  }

  updateTask(taskId: string, patch: Partial<Pick<DelegationTask, "latestNote" | "status" | "resultSummary" | "errorMessage">>): DelegationTask | undefined {
    this.reload();
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (patch.latestNote !== undefined) task.latestNote = patch.latestNote;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.resultSummary !== undefined) task.resultSummary = patch.resultSummary;
    if (patch.errorMessage !== undefined) task.errorMessage = patch.errorMessage;
    task.updatedAt = now();
    this.addEvent("task.updated", `${task.agent}: ${task.status}${task.latestNote ? ` — ${task.latestNote}` : ""}`, task.id);
    return task;
  }

  startTask(taskId: string, note?: string): DelegationTask | undefined {
    this.reload();
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = "running";
    task.latestNote = note ?? task.latestNote;
    task.updatedAt = now();
    this.addEvent("task.started", `${task.agent} started (${task.mode}): ${task.title}`, task.id);
    return task;
  }

  noteTask(taskId: string, note: string): DelegationTask | undefined {
    this.reload();
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.latestNote = note;
    task.updatedAt = now();
    this.addEvent("task.note", `${task.agent}: ${note}`, task.id);
    return task;
  }

  finishTask(taskId: string, status: Extract<DelegationTaskStatus, "done" | "failed" | "cancelled">, note?: string, details?: { resultSummary?: string; errorMessage?: string }): DelegationTask | undefined {
    this.reload();
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = status;
    task.latestNote = note ?? task.latestNote;
    if (details?.resultSummary !== undefined) task.resultSummary = details.resultSummary;
    if (details?.errorMessage !== undefined) task.errorMessage = details.errorMessage;
    task.updatedAt = now();
    const kind = status === "done" ? "task.finished" : status === "failed" ? "task.failed" : "task.cancelled";
    this.addEvent(kind, `${task.agent} ${status}: ${task.title}${task.latestNote ? ` — ${task.latestNote}` : ""}`, task.id);
    return task;
  }

  clear(): void {
    this.tasks.clear();
    this.events = [];
    ensureStoreDir();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ version: 1, updatedAt: now(), tasks: [], recentEvents: [] }, null, 2) + "\n", "utf8");
    fs.writeFileSync(EVENTS_PATH, "", "utf8");
    this.addEvent("store.cleared", "Delegation store cleared.");
  }

  listTasks(): DelegationTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listEvents(): DelegationEvent[] {
    return [...this.events];
  }

  getTask(taskId: string): DelegationTask | undefined {
    this.reload();
    return this.tasks.get(taskId);
  }

  summary(): { queued: number; running: number; done: number; failed: number; cancelled: number } {
    this.reload();
    const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const task of this.tasks.values()) counts[task.status] += 1;
    return counts;
  }

  snapshotPath(): string {
    return SNAPSHOT_PATH;
  }

  eventsPath(): string {
    return EVENTS_PATH;
  }
}
