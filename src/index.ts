import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { BackgroundWorkerRuntime, type TaskList } from "./runtime.js";
import type { TaskRecord, TaskResult } from "./types.js";

const STATUS_KEY = "pi-background-workers";
const WIDGET_KEY = "pi-background-workers";
const STATUS_POLL_MS = 2_000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "—";
  return timestamp.replace("T", " ").replace(".000Z", "Z");
}

export function formatTaskLine(task: TaskRecord): string {
  const title = truncate(task.title || task.task, 56);
  const note = task.latestNote ? ` — ${truncate(task.latestNote, 72)}` : "";
  return `[${task.status}] ${task.id} · ${title}${note}`;
}

export function buildStatusText(groups: TaskList): string | undefined {
  const parts: string[] = [];
  if (groups.running.length > 0) parts.push(`${groups.running.length} running`);
  if (groups.queued.length > 0) parts.push(`${groups.queued.length} queued`);
  if (groups.recent.length > 0) parts.push(`${groups.recent.length} recent`);
  if (parts.length === 0) return "BG idle";
  return `BG ${parts.join(" · ")}`;
}

export function buildTaskListWidget(groups: TaskList): string[] {
  const lines = ["pi-background-workers", ""];

  if (groups.running.length > 0) {
    lines.push("Running");
    for (const task of groups.running) lines.push(`- ${formatTaskLine(task)}`);
    lines.push("");
  }

  if (groups.queued.length > 0) {
    lines.push("Queued");
    for (const task of groups.queued) lines.push(`- ${formatTaskLine(task)}`);
    lines.push("");
  }

  if (groups.recent.length > 0) {
    lines.push("Recent");
    for (const task of groups.recent) lines.push(`- ${formatTaskLine(task)}`);
    lines.push("");
  }

  if (lines.length === 2) {
    lines.push("No background tasks yet.");
  }

  return lines;
}

export function buildTaskDetailWidget(task: TaskRecord, result?: TaskResult | null): string[] {
  const lines = [
    "pi-background-workers",
    "",
    `${task.title}`,
    `ID: ${task.id}`,
    `Status: ${task.status}`,
    `CWD: ${task.cwd}`,
    `Created: ${formatTimestamp(task.createdAt)}`,
    `Started: ${formatTimestamp(task.startedAt)}`,
    `Finished: ${formatTimestamp(task.finishedAt)}`,
    `PID: ${task.pid ?? "—"}`,
    `Exit code: ${task.exitCode ?? "—"}`,
  ];

  if (task.latestNote) {
    lines.push(`Latest note: ${task.latestNote}`);
  }

  if (task.error) {
    lines.push(`Error: ${task.error}`);
  }

  if (result) {
    lines.push("");
    lines.push("Result");
    lines.push(`Summary: ${result.summary}`);
    if (result.filesChanged.length > 0) {
      lines.push("Files changed:");
      for (const file of result.filesChanged) lines.push(`- ${file}`);
    }
    if (result.notes) {
      lines.push(`Notes: ${result.notes}`);
    }
  }

  return lines;
}

export function buildTaskResultWidget(task: TaskRecord, result: TaskResult): string[] {
  const lines = [
    "pi-background-workers",
    "",
    `${task.title}`,
    `ID: ${task.id}`,
    `Status: ${result.status}`,
    `Finished: ${formatTimestamp(result.finishedAt)}`,
    "",
    "Done",
    result.done || "(no Done section)",
    "",
    "Files Changed",
  ];

  if (result.filesChanged.length > 0) {
    for (const file of result.filesChanged) lines.push(`- ${file}`);
  } else {
    lines.push("No files changed.");
  }

  lines.push("", "Notes", result.notes || "(no Notes section)");
  return lines;
}

function parseRequiredId(args: string): string | null {
  const id = args.trim();
  return id.length > 0 ? id : null;
}

export default function backgroundWorkersExtension(pi: ExtensionAPI): void {
  let runtime: BackgroundWorkerRuntime | null = null;
  let statusTimer: NodeJS.Timeout | null = null;

  const ensureRuntime = async (): Promise<BackgroundWorkerRuntime> => {
    if (!runtime) {
      runtime = new BackgroundWorkerRuntime();
      await runtime.initialize();
    }
    return runtime;
  };

  const clearStatusTimer = (): void => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  };

  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    const activeRuntime = await ensureRuntime();
    const groups = await activeRuntime.listTasks();
    if (ctx?.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, buildStatusText(groups));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await ensureRuntime();
    await refreshStatus(ctx);
    if (ctx.hasUI) {
      clearStatusTimer();
      statusTimer = setInterval(() => {
        void refreshStatus(ctx);
      }, STATUS_POLL_MS);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
  });

  pi.registerCommand("bg", {
    description: "Launch a background worker (usage: /bg <task>)",
    handler: async (args, ctx) => {
      const taskText = args.trim();
      if (!taskText) {
        ctx.ui.notify("Usage: /bg <task>", "warning");
        return;
      }

      const activeRuntime = await ensureRuntime();
      const task = await activeRuntime.launchTask({
        task: taskText,
        title: taskText,
        cwd: ctx.cwd,
      });

      ctx.ui.setWidget(WIDGET_KEY, buildTaskDetailWidget(task));
      ctx.ui.notify(`Background task ${task.id} is ${task.status}.`, "info");
      await refreshStatus(ctx);
    },
  });

  pi.registerCommand("bg-list", {
    description: "List running, queued, and recent background tasks",
    handler: async (_args, ctx) => {
      const activeRuntime = await ensureRuntime();
      const groups = await activeRuntime.listTasks();
      ctx.ui.setWidget(WIDGET_KEY, buildTaskListWidget(groups));
      ctx.ui.notify("Updated background task list.", "info");
      await refreshStatus(ctx);
    },
  });

  pi.registerCommand("bg-show", {
    description: "Show details for a background task (usage: /bg-show <id>)",
    handler: async (args, ctx) => {
      const taskId = parseRequiredId(args);
      if (!taskId) {
        ctx.ui.notify("Usage: /bg-show <id>", "warning");
        return;
      }

      const activeRuntime = await ensureRuntime();
      const task = await activeRuntime.getTask(taskId);
      if (!task) {
        ctx.ui.notify(`Task not found: ${taskId}`, "warning");
        return;
      }

      const result = await activeRuntime.getTaskResult(taskId);
      ctx.ui.setWidget(WIDGET_KEY, buildTaskDetailWidget(task, result));
      ctx.ui.notify(`Showing task ${task.id}.`, "info");
      await refreshStatus(ctx);
    },
  });

  pi.registerCommand("bg-cancel", {
    description: "Cancel a background task (usage: /bg-cancel <id>)",
    handler: async (args, ctx) => {
      const taskId = parseRequiredId(args);
      if (!taskId) {
        ctx.ui.notify("Usage: /bg-cancel <id>", "warning");
        return;
      }

      const activeRuntime = await ensureRuntime();
      const cancelled = await activeRuntime.cancelTask(taskId);
      if (!cancelled.task) {
        ctx.ui.notify(`Task not found: ${taskId}`, "warning");
        return;
      }
      if (!cancelled.accepted) {
        ctx.ui.notify(`Task ${taskId} could not be cancelled from status ${cancelled.task.status}.`, "warning");
        return;
      }

      const result = await activeRuntime.getTaskResult(taskId);
      ctx.ui.setWidget(WIDGET_KEY, buildTaskDetailWidget(cancelled.task, result));
      ctx.ui.notify(`Cancellation requested for ${taskId}.`, "info");
      await refreshStatus(ctx);
    },
  });

  pi.registerCommand("bg-results", {
    description: "Show normalized results for a finished task (usage: /bg-results <id>)",
    handler: async (args, ctx) => {
      const taskId = parseRequiredId(args);
      if (!taskId) {
        ctx.ui.notify("Usage: /bg-results <id>", "warning");
        return;
      }

      const activeRuntime = await ensureRuntime();
      const task = await activeRuntime.getTask(taskId);
      if (!task) {
        ctx.ui.notify(`Task not found: ${taskId}`, "warning");
        return;
      }

      const result = await activeRuntime.getTaskResult(taskId);
      if (!result) {
        ctx.ui.notify(`Task ${taskId} has no final result yet.`, "warning");
        ctx.ui.setWidget(WIDGET_KEY, buildTaskDetailWidget(task));
        await refreshStatus(ctx);
        return;
      }

      ctx.ui.setWidget(WIDGET_KEY, buildTaskResultWidget(task, result));
      ctx.ui.notify(`Showing results for ${taskId}.`, "info");
      await refreshStatus(ctx);
    },
  });
}
