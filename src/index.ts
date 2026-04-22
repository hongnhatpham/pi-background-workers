import { Type } from "@sinclair/typebox";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import { BackgroundWorkerRuntime, type LaunchTaskInput, type TaskList } from "./runtime.js";
import type { TaskPriority, TaskRecord, TaskResult } from "./types.js";

const STATUS_KEY = "pi-background-workers";
const WIDGET_KEY = "pi-background-workers";
const STATUS_POLL_MS = 2_000;
const COMPLETION_MESSAGE_TYPE = "pi-background-workers-completion";

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
  ];

  if (!result.outputFormatSatisfied) {
    lines.push("", "Validation issues");
    for (const issue of result.validationIssues) lines.push(`- ${issue}`);
  }

  lines.push("", "Done", result.done || "(no Done section)", "", "Files Changed");

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

export interface DelegateTaskParams {
  task: string;
  title?: string;
  cwd?: string;
  model?: string;
  timeoutMinutes?: number;
  tools?: string[];
  priority?: TaskPriority;
  waitForResult?: boolean;
}

export function toLaunchTaskInput(params: DelegateTaskParams, cwd: string): LaunchTaskInput {
  return {
    task: params.task,
    title: params.title?.trim() || params.task.trim(),
    cwd: params.cwd?.trim() || cwd,
    model: params.model?.trim() || null,
    tools: params.tools && params.tools.length > 0 ? params.tools : null,
    priority: params.priority ?? "normal",
    timeoutMinutes: typeof params.timeoutMinutes === "number" ? params.timeoutMinutes : null,
  };
}

export function buildDelegateTaskText(task: TaskRecord, waitForResult: boolean): string {
  const waitNote = waitForResult
    ? "waitForResult is not supported in v0; launched in background instead."
    : "Launched in background.";
  return [
    `Created background task ${task.id}.`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    `CWD: ${task.cwd}`,
    waitNote,
    `Use /bg-show ${task.id} or /bg-results ${task.id} to inspect it.`,
  ].join("\n");
}

export function buildDelegateTaskResult(task: TaskRecord, waitForResult: boolean): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: buildDelegateTaskText(task, waitForResult) }],
    details: {
      taskId: task.id,
      title: task.title,
      status: task.status,
      cwd: task.cwd,
      waitForResultIgnored: waitForResult,
      inspectCommands: {
        show: `/bg-show ${task.id}`,
        results: `/bg-results ${task.id}`,
        cancel: `/bg-cancel ${task.id}`,
      },
    },
  };
}

export interface CompletionMessageDetails {
  taskId: string;
  title: string;
  status: TaskResult["status"];
  summary: string;
  outputFormatSatisfied: boolean;
  validationIssues: string[];
  showCommand: string;
  resultsCommand: string;
}

export function summarizeCompletion(result: TaskResult): string {
  if (result.outputFormatSatisfied) return result.summary;
  if (result.status === "cancelled" || result.status === "timed_out" || result.status === "failed") {
    return result.summary;
  }
  if (result.done) return result.done;
  const lines = result.rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#+\s*(done|files changed|notes)\b/i.test(line))
    .filter((line) => !/^use \/bg-results\b/i.test(line))
    .filter((line) => !/^validation issues:/i.test(line));
  const fileLikeLines = lines.filter((line) => /[/.]/.test(line) && !/\s/.test(line));
  if ((lines.length >= 3 && fileLikeLines.length === lines.length) || (lines.length >= 6 && fileLikeLines.length >= Math.ceil(lines.length * 0.6))) {
    return "Worker finished but returned an unstructured file listing instead of a usable summary.";
  }
  const preview = lines.slice(0, 4).join("; ");
  return preview || result.summary;
}

export function buildCompletionMessage(task: TaskRecord, result: TaskResult): { content: string; details: CompletionMessageDetails } {
  const summary = summarizeCompletion(result);
  const primaryIssue = result.validationIssues[0] ?? "Worker output did not match the expected structured format.";
  const qualityNote = result.status !== "cancelled" && !result.outputFormatSatisfied
    ? `\nOutput quality note: ${primaryIssue}`
    : "";
  return {
    content: `Background task finished: ${task.title}\nSummary: ${summary}${qualityNote}\nUse /bg-results ${task.id} for the full normalized result.`,
    details: {
      taskId: task.id,
      title: task.title,
      status: result.status,
      summary,
      outputFormatSatisfied: result.outputFormatSatisfied,
      validationIssues: result.validationIssues,
      showCommand: `/bg-show ${task.id}`,
      resultsCommand: `/bg-results ${task.id}`,
    },
  };
}

export default function backgroundWorkersExtension(pi: ExtensionAPI): void {
  let runtime: BackgroundWorkerRuntime | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let autoReportCutoffAt: string | null = null;

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

  const deliverFinishedTaskReports = async (): Promise<void> => {
    const activeRuntime = await ensureRuntime();
    const groups = await activeRuntime.listTasks(20);
    for (const task of groups.recent) {
      if (task.reportedAt) continue;
      if (autoReportCutoffAt && task.finishedAt && task.finishedAt < autoReportCutoffAt) {
        await activeRuntime.store.updateTask({
          ...task,
          reportedAt: activeRuntime.now(),
        });
        continue;
      }
      const result = await activeRuntime.getTaskResult(task.id);
      if (!result) continue;
      const completion = buildCompletionMessage(task, result);
      pi.sendMessage(
        {
          customType: COMPLETION_MESSAGE_TYPE,
          content: completion.content,
          display: true,
          details: completion.details,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      await activeRuntime.store.updateTask({
        ...task,
        reportedAt: activeRuntime.now(),
      });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    autoReportCutoffAt = new Date().toISOString();
    await ensureRuntime();
    await refreshStatus(ctx);
    await deliverFinishedTaskReports();
    if (ctx.hasUI) {
      clearStatusTimer();
      statusTimer = setInterval(() => {
        void refreshStatus(ctx);
        void deliverFinishedTaskReports();
      }, STATUS_POLL_MS);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    autoReportCutoffAt = null;
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

  const delegateTaskTool = defineTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Launch a bounded background Pi worker so the main conversation can stay available.",
    promptSnippet: "delegate_task(task, title?, cwd?, model?, timeoutMinutes?, tools?, priority?, waitForResult?) — launch a background worker and return task tracking info.",
    promptGuidelines: [
      "Use delegate_task for long-running, parallelizable, or noisy work that does not need to monopolize the current turn.",
      "Prefer delegate_task over blocking yourself on long implementation or audit runs when the user may want to keep chatting.",
      "delegate_task is background-first; in v0 waitForResult is ignored and the task is still launched asynchronously.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The worker objective." }),
      title: Type.Optional(Type.String({ description: "Short task title for displays." })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
      model: Type.Optional(Type.String({ description: "Optional model override for the worker." })),
      timeoutMinutes: Type.Optional(Type.Number({ description: "Optional timeout override in minutes." })),
      tools: Type.Optional(Type.Array(Type.String({ description: "Tool name" }), { description: "Optional tool allow-list passed to Pi." })),
      priority: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("normal"),
        Type.Literal("high"),
      ], { description: "Optional task priority." })),
      waitForResult: Type.Optional(Type.Boolean({ description: "Ignored in v0; background launch still returns immediately." })),
    }),
    async execute(_toolCallId, params: DelegateTaskParams, _signal, _onUpdate, ctx: ExtensionContext) {
      const activeRuntime = await ensureRuntime();
      const task = await activeRuntime.launchTask(toLaunchTaskInput(params, ctx.cwd));
      await refreshStatus(ctx);
      return buildDelegateTaskResult(task, Boolean(params.waitForResult));
    },
  });

  pi.registerTool(delegateTaskTool);
}
