import { StringEnum } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import type { DelegateTaskInput, DelegationMode, DelegationTask } from "./schema.js";
import { TaskStore } from "./task-store.js";
import { buildAllowedTools, runDelegatedWorker } from "./worker-runner.js";

const CUSTOM_MESSAGE_TYPE = "delegation-output";
const store = new TaskStore();

const DelegateTaskParams = Type.Object({
  task: Type.String({ description: "Objective for the delegated worker." }),
  title: Type.Optional(Type.String({ description: "Short task title shown in the observable task graph." })),
  mode: Type.Optional(StringEnum(["general", "research", "implementation", "review", "design"] as const, {
    description: "Execution profile for the worker.",
    default: "general",
  })),
  model: Type.Optional(Type.String({ description: "Optional model override for the worker." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the delegated worker." })),
  parentTaskId: Type.Optional(Type.String({ description: "Optional parent task id for explicit nesting." })),
  allowNestedDelegation: Type.Optional(Type.Boolean({ description: "Allow the worker to call delegate_task again within depth limits.", default: false })),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum delegation depth including nested tasks.", default: 2 })),
  includeMemoryRead: Type.Optional(Type.Boolean({ description: "Allow read-only memory tools such as memory_search for context.", default: true })),
}, { additionalProperties: false });

type DelegateTaskParamsType = {
  task: string;
  title?: string;
  mode?: DelegationMode;
  model?: string;
  cwd?: string;
  parentTaskId?: string;
  allowNestedDelegation?: boolean;
  maxDepth?: number;
  includeMemoryRead?: boolean;
};

function truncate(value: string, max = 100): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function showOutput(pi: ExtensionAPI, title: string, body: string): void {
  pi.sendMessage({
    customType: CUSTOM_MESSAGE_TYPE,
    content: `${title}\n\n${body}`,
    display: true,
    details: { title },
  });
}

function roots(tasks: DelegationTask[]): DelegationTask[] {
  return tasks.filter((task) => !task.parentId);
}

function renderTree(tasks: DelegationTask[]): string {
  if (tasks.length === 0) return "<no tasks>";
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lines: string[] = [];

  const walk = (task: DelegationTask, depth: number) => {
    const indent = "  ".repeat(depth);
    const state =
      task.status === "running" ? "▶" :
      task.status === "queued" ? "…" :
      task.status === "done" ? "✓" :
      task.status === "failed" ? "✗" : "⊘";
    const profile = `${task.mode}${task.model ? ` @ ${task.model}` : ""}`;
    const note = task.latestNote ? ` [${truncate(task.latestNote, 48)}]` : "";
    lines.push(`${indent}${state} ${task.agent} — ${truncate(task.title, 78)} (${profile})${note}`);
    for (const childId of task.childIds) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1);
    }
  };

  for (const task of roots(tasks)) walk(task, 0);
  return lines.join("\n");
}

function renderEvents(): string {
  const events = store.listEvents();
  if (events.length === 0) return "<no recent events>";
  return events
    .slice(-20)
    .map((event) => `- ${event.at} ${event.kind}${event.taskId ? ` ${event.taskId.slice(0, 8)}` : ""} :: ${truncate(event.message, 160)}`)
    .join("\n");
}

function renderTaskEvents(taskId: string): string {
  const events = store.listEvents().filter((event) => event.taskId === taskId);
  if (events.length === 0) return "<no recent events for task>";
  return events
    .slice(-12)
    .map((event) => `- ${event.at} ${event.kind} :: ${truncate(event.message, 160)}`)
    .join("\n");
}

function renderTaskDetails(task: DelegationTask): string {
  return [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `agent: ${task.agent}`,
    `mode: ${task.mode}`,
    `model: ${task.model ?? "<default>"}`,
    `cwd: ${task.cwd}`,
    `status: ${task.status}`,
    `parent: ${task.parentId ?? "<root>"}`,
    `children: ${task.childIds.length ? task.childIds.join(", ") : "<none>"}`,
    `depth: ${task.depth}/${task.maxDepth}`,
    `nested: ${task.allowNestedDelegation ? "yes" : "no"}`,
    `memory-read: ${task.includeMemoryRead ? "yes" : "no"}`,
    `allowed tools: ${task.allowedTools.join(", ")}`,
    `created: ${task.createdAt}`,
    `updated: ${task.updatedAt}`,
    task.latestNote ? `latest: ${task.latestNote}` : undefined,
    task.resultSummary ? `summary: ${task.resultSummary}` : undefined,
    task.errorMessage ? `error: ${task.errorMessage}` : undefined,
  ].filter(Boolean).join("\n");
}

function resolveTaskReference(taskRef: string): { task?: DelegationTask; error?: string } {
  const ref = taskRef.trim();
  if (!ref) return { error: "Usage: /delegate-inspect <taskId>" };
  store.reload();
  const tasks = store.listTasks();
  const exact = tasks.find((task) => task.id === ref);
  if (exact) return { task: exact };
  const matches = tasks.filter((task) => task.id.startsWith(ref));
  if (matches.length === 1) return { task: matches[0] };
  if (matches.length > 1) {
    return { error: `Ambiguous task id prefix. Matches: ${matches.slice(0, 8).map((task) => task.id.slice(0, 8)).join(", ")}` };
  }
  return { error: `Task not found: ${ref}` };
}

function syncStatus(ctx: ExtensionContext): void {
  const counts = store.summary();
  const active = counts.running + counts.queued;
  if (active === 0) {
    ctx.ui.setStatus("delegation", "Del idle");
    return;
  }
  const parts = [`Del ${active}a`];
  if (counts.running) parts.push(`${counts.running}r`);
  if (counts.queued) parts.push(`${counts.queued}q`);
  if (counts.failed) parts.push(`${counts.failed}f`);
  ctx.ui.setStatus("delegation", parts.join(" · "));
}

function defaultTitle(task: string, mode: DelegationMode): string {
  return `${mode}: ${truncate(task, 64)}`;
}

function resolveParentTaskId(params: DelegateTaskParamsType): string | undefined {
  const explicitParent = params.parentTaskId?.trim();
  if (explicitParent) return explicitParent;
  const inheritedParent = process.env.PI_DELEGATION_PARENT_TASK_ID?.trim();
  return inheritedParent || undefined;
}

function buildTaskInput(params: DelegateTaskParamsType, ctx: ExtensionContext): DelegateTaskInput {
  const mode = params.mode ?? "general";
  const parentTaskId = resolveParentTaskId(params);
  const parent = parentTaskId ? store.getTask(parentTaskId) : undefined;
  const allowNestedDelegation = params.allowNestedDelegation ?? false;
  const maxDepth = Math.max(parent?.maxDepth ?? 0, Math.max(0, Math.floor(params.maxDepth ?? 2)));
  const includeMemoryRead = params.includeMemoryRead ?? true;
  const provisional: Omit<DelegationTask, "id" | "createdAt" | "updatedAt" | "status" | "childIds"> = {
    parentId: parentTaskId,
    title: params.title?.trim() || defaultTitle(params.task, mode),
    agent: parent ? "subagent" : "subagent",
    mode,
    model: params.model?.trim() || undefined,
    cwd: params.cwd?.trim() || ctx.cwd,
    depth: parent ? parent.depth + 1 : 0,
    latestNote: undefined,
    resultSummary: undefined,
    errorMessage: undefined,
    allowNestedDelegation,
    maxDepth,
    includeMemoryRead,
    allowedTools: [],
  };
  provisional.allowedTools = buildAllowedTools({
    mode: provisional.mode,
    includeMemoryRead: provisional.includeMemoryRead,
    allowNestedDelegation: provisional.allowNestedDelegation,
    depth: provisional.depth,
    maxDepth: provisional.maxDepth,
  });

  return {
    title: provisional.title,
    agent: provisional.agent,
    mode: provisional.mode,
    model: provisional.model,
    cwd: provisional.cwd,
    parentId: provisional.parentId,
    allowNestedDelegation: provisional.allowNestedDelegation,
    maxDepth: provisional.maxDepth,
    includeMemoryRead: provisional.includeMemoryRead,
    allowedTools: provisional.allowedTools,
  };
}

async function executeDelegatedTask(
  params: DelegateTaskParamsType,
  ctx: ExtensionContext,
  onUpdate?: (partial: AgentToolResult<{ taskId: string }>) => void,
): Promise<{ task: DelegationTask; resultText: string; status: string }> {
  const input = buildTaskInput(params, ctx);
  const task = store.createTask(input);
  syncStatus(ctx);

  onUpdate?.({
    content: [{ type: "text", text: `Queued ${task.id.slice(0, 8)}: ${task.title}` }],
    details: { taskId: task.id },
  });

  const result = await runDelegatedWorker({ task, objective: params.task }, ctx.signal, store, import.meta.url);
  syncStatus(ctx);

  const refreshed = store.getTask(task.id) ?? task;
  const resultText = refreshed.resultSummary || result.summary;
  onUpdate?.({
    content: [{ type: "text", text: `${refreshed.status.toUpperCase()} ${task.id.slice(0, 8)}\n${resultText}` }],
    details: { taskId: task.id },
  });
  return { task: refreshed, resultText, status: result.status };
}

export default function subagentOrchestratorExtension(pi: ExtensionAPI) {
  if ((globalThis as any).__subagentOrchestratorLoaded) return;
  (globalThis as any).__subagentOrchestratorLoaded = true;

  pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
    const body = typeof message.content === "string"
      ? message.content
      : message.content.map((item) => (item.type === "text" ? item.text : "[image]")).join("\n");
    return new Text(`${theme.fg("accent", theme.bold("Delegation"))}\n${body}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    syncStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("delegation", "");
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Spawn a fresh Pi worker with bounded tools and observable task tracking. Workers may read memory for context, but cannot modify memory or soul files.",
    parameters: DelegateTaskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const commandCtx = { ...ctx, signal } as ExtensionContext;
      const run = await executeDelegatedTask(params as DelegateTaskParamsType, commandCtx, onUpdate as any);
      return {
        content: [{ type: "text", text: `Delegated task ${run.task.id.slice(0, 8)} ${run.status}\n\n${run.resultText}` }],
        details: { taskId: run.task.id },
      };
    },
  });

  pi.registerCommand("delegate-status", {
    description: "Show current delegated task tree",
    handler: async (_args, ctx) => {
      syncStatus(ctx);
      const counts = store.summary();
      const parts = [
        `Snapshot: ${store.snapshotPath()}`,
        `Events: ${store.eventsPath()}`,
        `Counts: queued=${counts.queued}, running=${counts.running}, done=${counts.done}, failed=${counts.failed}, cancelled=${counts.cancelled}`,
        `Tasks:\n${renderTree(store.listTasks())}`,
      ];
      showOutput(pi, "Delegation status", parts.join("\n\n"));
    },
  });

  pi.registerCommand("delegate-log", {
    description: "Show recent delegation events",
    handler: async (_args, ctx) => {
      syncStatus(ctx);
      showOutput(pi, "Delegation log", renderEvents());
    },
  });

  pi.registerCommand("delegate-inspect", {
    description: "Inspect a delegated task by full id or unique prefix",
    handler: async (args, ctx) => {
      syncStatus(ctx);
      const resolved = resolveTaskReference(args);
      if (!resolved.task) {
        ctx.ui.notify(resolved.error ?? "Task not found", "error");
        return;
      }
      showOutput(
        pi,
        "Delegated task inspection",
        `${renderTaskDetails(resolved.task)}\n\nRecent task events:\n${renderTaskEvents(resolved.task.id)}`,
      );
    },
  });

  pi.registerCommand("delegate-clear", {
    description: "Clear the local delegation snapshot and event log",
    handler: async (_args, ctx) => {
      store.clear();
      syncStatus(ctx);
      ctx.ui.notify("Delegation store cleared", "info");
    },
  });

  pi.registerCommand("delegate-run", {
    description: "Manually run a delegated worker with the default general profile",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /delegate-run <task>", "error");
        return;
      }
      const run = await executeDelegatedTask({ task, mode: "general" }, ctx);
      showOutput(pi, "Delegated task", `${renderTaskDetails(run.task)}\n\nFinal report:\n${run.resultText}`);
    },
  });

  pi.registerCommand("delegate-demo", {
    description: "Create a tiny demo task tree so the observable workflow can be inspected",
    handler: async (_args, ctx) => {
      const root = store.createTask({
        title: "Investigate a delegated implementation task",
        agent: "ARIA-03",
        mode: "general",
        cwd: ctx.cwd,
        allowNestedDelegation: true,
        maxDepth: 2,
        includeMemoryRead: true,
        allowedTools: ["delegate_task"],
      });
      store.startTask(root.id, "Planning fan-out");

      const scout = store.createTask({
        title: "Inspect relevant code paths",
        agent: "subagent",
        mode: "research",
        cwd: ctx.cwd,
        parentId: root.id,
        allowNestedDelegation: false,
        maxDepth: 2,
        includeMemoryRead: true,
        allowedTools: ["read", "grep", "find", "memory_search"],
      });
      store.startTask(scout.id, "Reading repository files");
      store.finishTask(scout.id, "done", "Reported findings to parent", { resultSummary: "Located the main implementation surfaces." });

      const worker = store.createTask({
        title: "Draft implementation approach",
        agent: "subagent",
        mode: "implementation",
        cwd: ctx.cwd,
        parentId: root.id,
        allowNestedDelegation: true,
        maxDepth: 2,
        includeMemoryRead: true,
        allowedTools: ["read", "bash", "edit", "write", "delegate_task", "memory_search"],
      });
      store.startTask(worker.id, "Preparing patch plan");
      store.noteTask(worker.id, "Could further delegate review if policy allows");
      store.finishTask(worker.id, "done", "Returned implementation summary", { resultSummary: "Prepared a bounded plan for the parent task." });

      store.finishTask(root.id, "done", "Synthesized child reports", { resultSummary: "Parent task merged child outputs." });
      syncStatus(ctx);
      showOutput(pi, "Delegation demo", `Created demo task tree.\n\n${renderTree(store.listTasks())}`);
    },
  });
}
