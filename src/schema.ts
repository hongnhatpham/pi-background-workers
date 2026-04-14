export type DelegationTaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type DelegationMode = "general" | "research" | "implementation" | "review" | "design";

export interface DelegationTask {
  id: string;
  parentId?: string;
  title: string;
  agent: string;
  mode: DelegationMode;
  model?: string;
  cwd: string;
  depth: number;
  status: DelegationTaskStatus;
  createdAt: string;
  updatedAt: string;
  latestNote?: string;
  resultSummary?: string;
  errorMessage?: string;
  allowNestedDelegation: boolean;
  maxDepth: number;
  includeMemoryRead: boolean;
  allowedTools: string[];
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

export interface DelegateTaskInput {
  title: string;
  agent: string;
  mode: DelegationMode;
  cwd: string;
  model?: string;
  parentId?: string;
  allowNestedDelegation: boolean;
  maxDepth: number;
  includeMemoryRead: boolean;
  allowedTools: string[];
}
