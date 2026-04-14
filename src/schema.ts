export type DelegationTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface DelegationTask {
  id: string;
  parentId?: string;
  title: string;
  agent: string;
  cwd: string;
  depth: number;
  status: DelegationTaskStatus;
  createdAt: string;
  updatedAt: string;
  latestNote?: string;
  childIds: string[];
}

export type DelegationEventKind =
  | "task.created"
  | "task.updated"
  | "task.started"
  | "task.note"
  | "task.finished"
  | "task.failed"
  | "task.cancelled"
  | "store.cleared";

export interface DelegationEvent {
  id: string;
  taskId?: string;
  at: string;
  kind: DelegationEventKind;
  message: string;
}

export interface DelegationSnapshot {
  version: 1;
  updatedAt: string;
  tasks: DelegationTask[];
  recentEvents: DelegationEvent[];
}
