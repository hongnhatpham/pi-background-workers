export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "cancelling",
  "timed_out",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskPriority = "low" | "normal" | "high";

export type TaskEventKind =
  | "task.created"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.cancel_requested"
  | "task.cancelled"
  | "task.timeout";

export interface TaskRecord {
  id: string;
  title: string;
  task: string;
  status: TaskStatus;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pid: number | null;
  exitCode: number | null;
  model: string | null;
  tools: string[] | null;
  priority: TaskPriority;
  timeoutMinutes: number | null;
  error: string | null;
  latestNote: string | null;
  resultSummary: string | null;
  reportedAt: string | null;
  swarmId: string | null;
  swarmRole: string | null;
  taskType?: string | null;
  roleHint?: string | null;
  parentTaskId?: string | null;
  cancellationGroup?: string | null;
  acceptanceCriteria?: string | null;
  expectedArtifacts?: string[] | null;
  riskLevel?: string | null;
}

export interface TaskResult {
  taskId: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled" | "timed_out">;
  summary: string;
  done: string;
  filesChanged: string[];
  notes: string;
  rawOutput: string;
  finishedAt: string;
  outputFormatSatisfied: boolean;
  validationIssues: string[];
}

export interface TaskEvent {
  taskId: string;
  at: string;
  kind: TaskEventKind;
  message: string;
  payload?: Record<string, unknown>;
}

export interface RuntimeConfig {
  stateRoot: string;
  maxConcurrentWorkers: number;
  defaultTimeoutMinutes: number;
}
