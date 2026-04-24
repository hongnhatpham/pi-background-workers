import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import { BackgroundWorkerRuntime, type LaunchTaskInput, type TaskList } from "./runtime.js";
import type { TaskPriority, TaskRecord, TaskResult } from "./types.js";

const STATUS_KEY = "pi-background-workers";
const WIDGET_KEY = "pi-background-workers";
const STATUS_POLL_MS = 2_000;
const MAX_SWARM_TASKS = 8;
const COMPLETION_MESSAGE_TYPE = "pi-background-workers-completion";
const LAUNCH_MESSAGE_TYPE = "pi-background-workers-launch";
const SWARM_LAUNCH_MESSAGE_TYPE = "pi-background-workers-swarm-launch";
const PANEL_MESSAGE_TYPE = "pi-background-workers-panel";
const SWARM_POLICY_MARKER = "## Background worker swarm policy";
const DELEGATION_TOOL_NAMES = new Set(["delegate_task", "delegate_swarm"]);
const MUTATING_OR_EXPENSIVE_TOOL_NAMES = new Set(["bash", "edit", "write"]);

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
  const role = task.swarmRole ?? task.roleHint;
  const swarm = task.swarmId ? ` · swarm ${task.swarmId}${role ? `/${role}` : ""}` : "";
  const note = task.latestNote ? ` — ${truncate(task.latestNote, 72)}` : "";
  return `[${task.status}] ${task.id}${swarm} · ${title}${note}`;
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
    `Swarm: ${task.swarmId ? `${task.swarmId}${task.swarmRole || task.roleHint ? ` / ${task.swarmRole ?? task.roleHint}` : ""}` : "—"}`,
    `CWD: ${task.cwd}`,
    `Created: ${formatTimestamp(task.createdAt)}`,
    `Started: ${formatTimestamp(task.startedAt)}`,
    `Finished: ${formatTimestamp(task.finishedAt)}`,
    `PID: ${task.pid ?? "—"}`,
    `Exit code: ${task.exitCode ?? "—"}`,
  ];

  if (task.taskType || task.roleHint || task.acceptanceCriteria || task.riskLevel) {
    lines.push(`Type: ${task.taskType ?? "—"}`);
    lines.push(`Role hint: ${task.roleHint ?? "—"}`);
    lines.push(`Risk: ${task.riskLevel ?? "—"}`);
    if (task.acceptanceCriteria) lines.push(`Acceptance: ${task.acceptanceCriteria}`);
  }

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

function isBackgroundWorkerSessionPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes("You are the default general-purpose background worker for Pi.")
    || systemPrompt.includes("Task metadata:\n- Task ID:");
}

function statusCounts(tasks: TaskRecord[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildSwarmDetailWidget(swarmId: string, tasks: TaskRecord[], results: Array<TaskResult | null> = []): string[] {
  const lines = ["pi-background-workers", "", `Swarm: ${swarmId}`, `Tasks: ${tasks.length}`];
  const counts = statusCounts(tasks);
  if (Object.keys(counts).length > 0) lines.push(`Status: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(" · ")}`);
  lines.push("");
  for (const [index, task] of tasks.entries()) {
    const result = results[index];
    lines.push(`- ${task.id} [${task.status}] ${task.swarmRole ?? task.roleHint ?? "worker"}: ${task.title}`);
    if (task.taskType || task.riskLevel) lines.push(`  type=${task.taskType ?? "—"} risk=${task.riskLevel ?? "—"}`);
    if (task.latestNote) lines.push(`  note: ${truncate(task.latestNote, 140)}`);
    if (result?.summary) lines.push(`  result: ${truncate(result.summary, 180)}`);
  }
  return lines;
}

export function buildSwarmCancelWidget(swarmId: string, accepted: number, rejected: number, tasks: TaskRecord[]): string[] {
  return [
    "pi-background-workers",
    "",
    `Swarm cancellation requested: ${swarmId}`,
    `Accepted: ${accepted}`,
    `Rejected: ${rejected}`,
    "",
    ...tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`),
  ];
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

export interface DelegateSwarmTaskParams extends DelegateTaskParams {
  role?: string;
  taskType?: string;
  roleHint?: string;
  parentTaskId?: string;
  cancellationGroup?: string;
  acceptanceCriteria?: string;
  expectedArtifacts?: string[];
  riskLevel?: string;
}

export interface DelegateSwarmParams {
  objective?: string;
  tasks: DelegateSwarmTaskParams[];
  cwd?: string;
  model?: string;
  timeoutMinutes?: number;
  tools?: string[];
  priority?: TaskPriority;
  waitForResults?: boolean;
}

export interface PreparedSwarmLaunch {
  swarmId: string;
  tasks: LaunchTaskInput[];
}

export function createSwarmId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `swarm-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function nonEmptyTools(tools?: string[]): string[] | null {
  return tools && tools.length > 0 ? tools : null;
}

export function toLaunchTaskInput(params: DelegateTaskParams, cwd: string, swarmId?: string | null): LaunchTaskInput {
  return {
    task: params.task,
    title: params.title?.trim() || params.task.trim(),
    cwd: params.cwd?.trim() || cwd,
    model: params.model?.trim() || null,
    tools: nonEmptyTools(params.tools),
    priority: params.priority ?? "normal",
    timeoutMinutes: typeof params.timeoutMinutes === "number" ? params.timeoutMinutes : null,
    swarmId: swarmId ?? null,
    swarmRole: (params as DelegateSwarmTaskParams).role?.trim() || (params as DelegateSwarmTaskParams).roleHint?.trim() || null,
    taskType: (params as DelegateSwarmTaskParams).taskType?.trim() || null,
    roleHint: (params as DelegateSwarmTaskParams).roleHint?.trim() || (params as DelegateSwarmTaskParams).role?.trim() || null,
    parentTaskId: (params as DelegateSwarmTaskParams).parentTaskId?.trim() || null,
    cancellationGroup: (params as DelegateSwarmTaskParams).cancellationGroup?.trim() || swarmId || null,
    acceptanceCriteria: (params as DelegateSwarmTaskParams).acceptanceCriteria?.trim() || null,
    expectedArtifacts: (params as DelegateSwarmTaskParams).expectedArtifacts && (params as DelegateSwarmTaskParams).expectedArtifacts!.length > 0 ? (params as DelegateSwarmTaskParams).expectedArtifacts! : null,
    riskLevel: (params as DelegateSwarmTaskParams).riskLevel?.trim() || null,
  };
}

export function toLaunchSwarmInputs(params: DelegateSwarmParams, cwd: string, swarmId = createSwarmId()): PreparedSwarmLaunch {
  const sharedCwd = params.cwd?.trim() || cwd;
  const sharedObjective = params.objective?.trim();
  const tasks = params.tasks.slice(0, MAX_SWARM_TASKS).map((task, index) => ({
    ...toLaunchTaskInput({
      ...task,
      task: sharedObjective ? `Shared swarm objective: ${sharedObjective}\n\nWorker objective: ${task.task}` : task.task,
      title: task.title?.trim() || task.task.trim(),
      cwd: task.cwd?.trim() || sharedCwd,
      model: task.model?.trim() || params.model,
      timeoutMinutes: typeof task.timeoutMinutes === "number" ? task.timeoutMinutes : params.timeoutMinutes,
      tools: task.tools && task.tools.length > 0 ? task.tools : params.tools,
      priority: task.priority ?? params.priority ?? "normal",
    }, sharedCwd, swarmId),
    swarmRole: task.role?.trim() || `worker-${index + 1}`,
  }));
  return { swarmId, tasks };
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

export function buildDelegateSwarmText(swarmId: string, tasks: TaskRecord[], waitForResults: boolean): string {
  const waitNote = waitForResults
    ? "waitForResults is not supported in v0; launched the swarm in the background instead."
    : "Launched swarm in the background.";
  return [
    `Created background worker swarm ${swarmId} with ${tasks.length} task(s).`,
    waitNote,
    "Tasks:",
    ...tasks.map((task) => `- ${task.id} [${task.status}] ${task.swarmRole ?? task.roleHint ? `${task.swarmRole ?? task.roleHint}: ` : ""}${task.title}`),
    "",
    "Use /bg-list for the whole queue, /bg-show <id> for detail, or /bg-results <id> as each worker finishes.",
  ].join("\n");
}

export function buildDelegateSwarmResult(swarmId: string, tasks: TaskRecord[], waitForResults: boolean): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: buildDelegateSwarmText(swarmId, tasks, waitForResults) }],
    details: {
      swarmId,
      taskIds: tasks.map((task) => task.id),
      waitForResultsIgnored: waitForResults,
      tasks: tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        cwd: task.cwd,
        role: task.swarmRole ?? task.roleHint ?? null,
        inspectCommands: {
          show: `/bg-show ${task.id}`,
          results: `/bg-results ${task.id}`,
          cancel: `/bg-cancel ${task.id}`,
        },
      })),
    },
  };
}

export interface LaunchMessageDetails {
  taskId: string;
  title: string;
  status: TaskRecord["status"];
  cwd: string;
  waitForResultIgnored: boolean;
  showCommand: string;
  resultsCommand: string;
  cancelCommand: string;
}

export function buildLaunchMessage(task: TaskRecord, waitForResult: boolean): { content: string; details: LaunchMessageDetails } {
  const waitNote = waitForResult ? "\nNote: waitForResult is ignored in v0; this is running in the background." : "";
  return {
    content: `Background task started: ${task.title}\nID: ${task.id}\nCWD: ${task.cwd}${waitNote}\nUse /bg-show ${task.id}, /bg-results ${task.id}, or /bg-cancel ${task.id}.`,
    details: {
      taskId: task.id,
      title: task.title,
      status: task.status,
      cwd: task.cwd,
      waitForResultIgnored: waitForResult,
      showCommand: `/bg-show ${task.id}`,
      resultsCommand: `/bg-results ${task.id}`,
      cancelCommand: `/bg-cancel ${task.id}`,
    },
  };
}

export interface SwarmLaunchMessageDetails {
  swarmId: string;
  taskCount: number;
  waitForResultsIgnored: boolean;
  tasks: Array<{
    taskId: string;
    title: string;
    status: TaskRecord["status"];
    role: string | null;
    showCommand: string;
    resultsCommand: string;
    cancelCommand: string;
  }>;
}

export function buildSwarmLaunchMessage(swarmId: string, tasks: TaskRecord[], waitForResults: boolean): { content: string; details: SwarmLaunchMessageDetails } {
  const waitNote = waitForResults ? "\nNote: waitForResults is ignored in v0; this swarm is running in the background." : "";
  return {
    content: [
      `Background worker swarm started: ${swarmId}`,
      `Tasks: ${tasks.length}`,
      ...tasks.map((task) => `- ${task.id} [${task.status}] ${task.swarmRole ?? task.roleHint ? `${task.swarmRole ?? task.roleHint}: ` : ""}${task.title}`),
      `${waitNote}\nUse /bg-list for the queue, /bg-show <id>, /bg-results <id>, or /bg-cancel <id>.`,
    ].join("\n"),
    details: {
      swarmId,
      taskCount: tasks.length,
      waitForResultsIgnored: waitForResults,
      tasks: tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        role: task.swarmRole ?? task.roleHint ?? null,
        showCommand: `/bg-show ${task.id}`,
        resultsCommand: `/bg-results ${task.id}`,
        cancelCommand: `/bg-cancel ${task.id}`,
      })),
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
  swarmId?: string | null;
  swarmRole?: string | null;
}

export interface CompletionDeliveryOptions {
  triggerTurn: boolean;
  deliverAs: "steer" | "followUp";
}

export function buildCompletionDeliveryOptions(isIdle: boolean): CompletionDeliveryOptions {
  return isIdle
    ? { triggerTurn: true, deliverAs: "followUp" }
    : { triggerTurn: false, deliverAs: "steer" };
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
      swarmId: task.swarmId,
      swarmRole: task.swarmRole ?? task.roleHint,
    },
  };
}

export type SwarmOpportunityLevel = "none" | "task" | "swarm" | "explicit";

export function assessSwarmOpportunity(prompt: string): { level: SwarmOpportunityLevel; reasons: string[] } {
  const normalized = prompt.toLowerCase();
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (/\b(do not delegate|don't delegate|no delegation|without delegat(?:ing|ion)|do not parallelize|don't parallelize)\b/.test(normalized)) {
    return { level: "none", reasons: ["the user explicitly asked not to delegate or parallelize"] };
  }

  if (/\b(swarm\w*|parallel\w*|fan-?out|multiple workers|several workers|worker agents?|agent swarm|delegate\w*|delegation|background workers?)\b/.test(normalized)) {
    add("the user explicitly mentioned delegation, swarm, fan-out, or parallel work");
  }
  if (/\b(investigate|inspect|research|trace|audit|analy[sz]e|find|search|compare|map|inventory|survey)\b/.test(normalized)) add("there is a reconnaissance strand");
  if (/\b(implement|edit|write|patch|fix|update|refactor|build|modify|migrate|wire|integrate)\b/.test(normalized)) add("there is an implementation strand");
  if (/\b(review|verify|test|smoke|check|validate|typecheck|lint|regression)\b/.test(normalized)) add("there is a verification strand");
  if (/\b(evolve|design|architect|plan|revamp|improve|upgrade|strategy|workflow|policy|system)\b/.test(normalized)) add("there is an architecture or planning strand");
  if (/\b(repo|repository|codebase|project|extension|package|architecture|multi-file|files|hooks?|tools?|runtime|orchestrator|integration)\b/.test(normalized)) add("the work likely spans a codebase, runtime, or multiple files");
  if (prompt.trim().length >= 160) add("the request is substantial enough to split into bounded worker objectives");

  const explicit = reasons.some((reason) => reason.includes("explicitly"));
  const strandCount = ["reconnaissance", "implementation", "verification", "architecture"].filter((word) => reasons.some((reason) => reason.includes(word))).length;
  if (explicit) return { level: "explicit", reasons };
  if (strandCount >= 2 || reasons.length >= 4) return { level: "swarm", reasons };
  if (reasons.length >= 2) return { level: "task", reasons };
  return { level: "none", reasons };
}

export function buildDelegationFirstBlockReason(opportunity: { level: SwarmOpportunityLevel; reasons: string[] }, toolName: string): string | null {
  if (DELEGATION_TOOL_NAMES.has(toolName)) return null;

  if (opportunity.level === "explicit") {
    return [
      "Delegation-first policy: the user explicitly asked for delegation, parallelization, background workers, or an agent swarm.",
      `Before using ${toolName}, launch delegate_swarm with 2-4 bounded workers when there are independent strands, or delegate_task if there is only one useful background strand.`,
      "If you intentionally choose not to delegate, explain the concrete blocker in a brief assistant response instead of proceeding silently.",
    ].join(" ");
  }

  if (opportunity.level === "swarm" && MUTATING_OR_EXPENSIVE_TOOL_NAMES.has(toolName)) {
    return [
      "Delegation-first policy: this request appears swarm-worthy.",
      `Before using ${toolName}, launch delegate_swarm for independent reconnaissance, implementation, verification, docs, or code-area strands, unless coordination overhead is clearly larger than the work.`,
    ].join(" ");
  }

  if (opportunity.level === "task" && (toolName === "edit" || toolName === "write")) {
    return [
      "Delegation-first policy: this request likely has a useful background strand.",
      `Before using ${toolName}, consider launching delegate_task or delegate_swarm so review/recon can run while you coordinate.`,
    ].join(" ");
  }

  return null;
}

export function buildSuggestedSwarmShape(opportunity: { level: SwarmOpportunityLevel; reasons: string[] }): string[] {
  if (opportunity.level === "none") return [];

  const has = (needle: string) => opportunity.reasons.some((reason) => reason.includes(needle));
  const tasks: string[] = [];
  if (has("reconnaissance")) tasks.push("- scout/recon worker: map relevant files, APIs, prior decisions, and constraints without editing.");
  if (has("architecture")) tasks.push("- architecture/planning worker: propose the split, sequencing, risks, and adoption path.");
  if (has("implementation")) tasks.push("- implementation worker: make one bounded code/doc change slice and report exact files changed.");
  if (has("verification")) tasks.push("- verification/review worker: check tests, regressions, edge cases, and quality risks independently.");

  if (tasks.length < 2 && opportunity.level === "explicit") {
    tasks.push("- delegation scout: inspect the current delegation/background-worker surface and identify leverage points.");
    tasks.push("- delegation policy worker: suggest concrete behavior/prompt/runtime changes that increase useful fan-out without needless overhead.");
  }

  return ["Suggested swarm shape when applicable:", ...tasks.slice(0, 4)];
}

export function buildSwarmPolicyPrompt(prompt: string): string {
  const opportunity = assessSwarmOpportunity(prompt);
  const assessment = opportunity.level === "none"
    ? "Current turn assessment: no obvious delegation need unless hidden complexity appears."
    : [
        opportunity.level === "explicit"
          ? "Current turn assessment: the user explicitly expects delegation/fan-out; use the background worker system early unless there is a concrete reason not to."
          : opportunity.level === "swarm"
            ? "Current turn assessment: this is swarm-worthy; split independent strands into a small worker swarm."
            : "Current turn assessment: this likely deserves at least one background worker unless it collapses to a trivial local action.",
        "Reasons:",
        ...opportunity.reasons.map((reason) => `- ${reason}`),
        ...buildSuggestedSwarmShape(opportunity),
      ].join("\n");

  return [
    SWARM_POLICY_MARKER,
    "You have two model-facing delegation tools: delegate_task for one background worker and delegate_swarm for launching 2-8 related workers in one call.",
    "Use them much more aggressively than a default coding assistant would, while preserving judgment and avoiding needless theater.",
    "Before deep reading, editing, or long local tool chains on non-trivial work, do a quick delegation triage and launch useful worker(s) first.",
    "Default pattern for non-trivial coding/research work: launch workers early, keep yourself as coordinator/synthesizer, then continue the foreground conversation.",
    "Prefer delegate_swarm when independent strands can run in parallel, such as scout/review/implementation, frontend/backend, docs/code, or multiple search areas.",
    "Prefer delegate_task when there is one long/noisy strand that should not monopolize the main turn.",
    "For requests about improving delegation, background workers, orchestration, or agent swarms, dogfood this system: launch a scout/planner/reviewer swarm unless the requested change is tiny.",
    "Do not delegate genuinely tiny one-file edits, simple factual answers, or tasks where coordination overhead is clearly larger than the work.",
    "When you do delegate, make worker objectives specific and bounded, usually 2-4 workers for broad tasks rather than one vague worker.",
    "Background workers return asynchronously; report launch visibility to the user and synthesize finished reports when they arrive.",
    "",
    assessment,
  ].join("\n");
}

export default function backgroundWorkersExtension(pi: ExtensionAPI): void {
  let runtime: BackgroundWorkerRuntime | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let autoReportCutoffAt: string | null = null;
  let currentTurnDelegationOpportunity: { level: SwarmOpportunityLevel; reasons: string[] } | null = null;
  let currentTurnDelegationToolSeen = false;
  let currentTurnDelegationNudgeUsed = false;

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

  const showTranscriptPanel = (title: string, lines: string[], details: Record<string, unknown> = {}): void => {
    pi.sendMessage({
      customType: PANEL_MESSAGE_TYPE,
      content: lines.join("\n"),
      display: true,
      details: { title, ...details },
    });
  };

  const clearPersistentWidget = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const announceTaskLaunch = async (task: TaskRecord, ctx: ExtensionContext, waitForResult = false): Promise<void> => {
    const launch = buildLaunchMessage(task, waitForResult);
    clearPersistentWidget(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`Background task started: ${truncate(task.title, 72)}`, "info");
    }
    pi.sendMessage({
      customType: LAUNCH_MESSAGE_TYPE,
      content: launch.content,
      display: true,
      details: launch.details,
    });
  };

  const announceSwarmLaunch = async (swarmId: string, tasks: TaskRecord[], ctx: ExtensionContext, waitForResults = false): Promise<void> => {
    const launch = buildSwarmLaunchMessage(swarmId, tasks, waitForResults);
    clearPersistentWidget(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`Background swarm started: ${tasks.length} task(s)`, "info");
    }
    pi.sendMessage({
      customType: SWARM_LAUNCH_MESSAGE_TYPE,
      content: launch.content,
      display: true,
      details: launch.details,
    });
  };

  const launchSwarm = async (params: DelegateSwarmParams, ctx: ExtensionContext): Promise<{ swarmId: string; tasks: TaskRecord[] }> => {
    if (params.tasks.length < 2) throw new Error("A swarm needs at least two worker tasks. Use delegate_task or /bg for a single worker.");
    const activeRuntime = await ensureRuntime();
    const prepared = toLaunchSwarmInputs(params, ctx.cwd);
    const launched = await activeRuntime.launchTasks(prepared.tasks);
    return { swarmId: prepared.swarmId, tasks: launched };
  };

  const deliverFinishedTaskReports = async (ctx: ExtensionContext): Promise<void> => {
    const activeRuntime = await ensureRuntime();
    const groups = await activeRuntime.listTasks(20);
    const idle = ctx.isIdle();
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
          details: {
            ...completion.details,
            delivery: idle ? "idle-follow-up" : "active-steering",
          },
        },
        buildCompletionDeliveryOptions(idle),
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
    clearPersistentWidget(ctx);
    await refreshStatus(ctx);
    await deliverFinishedTaskReports(ctx);
    if (ctx.hasUI) {
      clearStatusTimer();
      statusTimer = setInterval(() => {
        void refreshStatus(ctx);
        void deliverFinishedTaskReports(ctx);
      }, STATUS_POLL_MS);
    }
  });

  pi.on("before_agent_start", async (event) => {
    currentTurnDelegationToolSeen = false;
    currentTurnDelegationNudgeUsed = false;
    if (isBackgroundWorkerSessionPrompt(event.systemPrompt)) {
      currentTurnDelegationOpportunity = null;
      return;
    }
    currentTurnDelegationOpportunity = assessSwarmOpportunity(event.prompt);
    if (event.systemPrompt.includes(SWARM_POLICY_MARKER)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSwarmPolicyPrompt(event.prompt)}`,
    };
  });

  pi.on("tool_call", async (event) => {
    if (DELEGATION_TOOL_NAMES.has(event.toolName)) {
      currentTurnDelegationToolSeen = true;
      return;
    }
    if (currentTurnDelegationToolSeen || currentTurnDelegationNudgeUsed) return;
    if (process.env.PI_BACKGROUND_WORKERS_DELEGATION_NUDGE === "0") return;
    const opportunity = currentTurnDelegationOpportunity;
    if (!opportunity) return;
    const reason = buildDelegationFirstBlockReason(opportunity, event.toolName);
    if (!reason) return;
    currentTurnDelegationNudgeUsed = true;
    return { block: true, reason };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    clearPersistentWidget(ctx);
    autoReportCutoffAt = null;
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
  });

  const launchTaskFromCommand = async (args: string, ctx: ExtensionContext, usage: string): Promise<void> => {
    const taskText = args.trim();
    if (!taskText) {
      ctx.ui.notify(`Usage: ${usage}`, "warning");
      return;
    }

    const activeRuntime = await ensureRuntime();
    const task = await activeRuntime.launchTask({
      task: taskText,
      title: taskText,
      cwd: ctx.cwd,
    });

    await announceTaskLaunch(task, ctx);
    await refreshStatus(ctx);
  };

  const launchSwarmFromCommand = async (args: string, ctx: ExtensionContext, usage: string): Promise<void> => {
    const taskTexts = args
      .split("||")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_SWARM_TASKS);
    if (taskTexts.length < 2) {
      ctx.ui.notify(`${usage}\nA swarm needs at least two tasks. Use /bg for a single worker.`, "warning");
      return;
    }

    const swarm = await launchSwarm({
      tasks: taskTexts.map((task, index) => ({ task, title: task, role: `worker-${index + 1}` })),
    }, ctx);

    await announceSwarmLaunch(swarm.swarmId, swarm.tasks, ctx);
    await refreshStatus(ctx);
  };

  pi.registerCommand("bg", {
    description: "Launch a background worker (usage: /bg <task>)",
    handler: async (args, ctx) => launchTaskFromCommand(args, ctx, "/bg <task>"),
  });

  pi.registerCommand("delegate", {
    description: "Alias for /bg. Launch one background worker (usage: /delegate <task>)",
    handler: async (args, ctx) => launchTaskFromCommand(args, ctx, "/delegate <task>"),
  });

  pi.registerCommand("bg-swarm", {
    description: "Launch a background worker swarm (usage: /bg-swarm task one || task two || task three)",
    handler: async (args, ctx) => launchSwarmFromCommand(args, ctx, "/bg-swarm task one || task two || task three"),
  });

  pi.registerCommand("swarm", {
    description: "Alias for /bg-swarm. Launch a background worker swarm (usage: /swarm task one || task two)",
    handler: async (args, ctx) => launchSwarmFromCommand(args, ctx, "/swarm task one || task two"),
  });

  pi.registerCommand("bg-list", {
    description: "List running, queued, and recent background tasks",
    handler: async (_args, ctx) => {
      const activeRuntime = await ensureRuntime();
      const groups = await activeRuntime.listTasks();
      clearPersistentWidget(ctx);
      showTranscriptPanel("Background tasks", buildTaskListWidget(groups), { command: "bg-list" });
      ctx.ui.notify("Added background task list to transcript.", "info");
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
      clearPersistentWidget(ctx);
      showTranscriptPanel(`Background task ${task.id}`, buildTaskDetailWidget(task, result), { command: "bg-show", taskId: task.id });
      ctx.ui.notify(`Added task ${task.id} to transcript.`, "info");
      await refreshStatus(ctx);
    },
  });

  pi.registerCommand("bg-show-swarm", {
    description: "Show grouped details for a background worker swarm (usage: /bg-show-swarm <swarm-id>)",
    handler: async (args, ctx) => {
      const swarmId = parseRequiredId(args);
      if (!swarmId) {
        ctx.ui.notify("Usage: /bg-show-swarm <swarm-id>", "warning");
        return;
      }
      const activeRuntime = await ensureRuntime();
      const tasks = await activeRuntime.getSwarmTasks(swarmId);
      if (tasks.length === 0) {
        ctx.ui.notify(`Swarm not found: ${swarmId}`, "warning");
        return;
      }
      const results = await Promise.all(tasks.map((task) => activeRuntime.getTaskResult(task.id)));
      clearPersistentWidget(ctx);
      showTranscriptPanel(`Background swarm ${swarmId}`, buildSwarmDetailWidget(swarmId, tasks, results), { command: "bg-show-swarm", swarmId });
      ctx.ui.notify(`Added swarm ${swarmId} to transcript.`, "info");
      await refreshStatus(ctx);
    },
  });

  pi.registerCommand("bg-cancel-swarm", {
    description: "Cancel queued/running tasks in a background worker swarm (usage: /bg-cancel-swarm <swarm-id>)",
    handler: async (args, ctx) => {
      const swarmId = parseRequiredId(args);
      if (!swarmId) {
        ctx.ui.notify("Usage: /bg-cancel-swarm <swarm-id>", "warning");
        return;
      }
      const activeRuntime = await ensureRuntime();
      const cancelled = await activeRuntime.cancelSwarm(swarmId);
      if (cancelled.tasks.length === 0) {
        ctx.ui.notify(`Swarm not found: ${swarmId}`, "warning");
        return;
      }
      clearPersistentWidget(ctx);
      showTranscriptPanel(`Background swarm ${swarmId}`, buildSwarmCancelWidget(swarmId, cancelled.accepted, cancelled.rejected, cancelled.tasks), { command: "bg-cancel-swarm", swarmId });
      ctx.ui.notify(`Cancellation requested for swarm ${swarmId}.`, "info");
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
      clearPersistentWidget(ctx);
      showTranscriptPanel(`Background task ${taskId}`, buildTaskDetailWidget(cancelled.task, result), { command: "bg-cancel", taskId });
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
        clearPersistentWidget(ctx);
        showTranscriptPanel(`Background task ${taskId}`, buildTaskDetailWidget(task), { command: "bg-results", taskId });
        await refreshStatus(ctx);
        return;
      }

      clearPersistentWidget(ctx);
      showTranscriptPanel(`Background task result ${taskId}`, buildTaskResultWidget(task, result), { command: "bg-results", taskId });
      ctx.ui.notify(`Added results for ${taskId} to transcript.`, "info");
      await refreshStatus(ctx);
    },
  });

  const TaskPrioritySchema = Type.Optional(Type.Union([
    Type.Literal("low"),
    Type.Literal("normal"),
    Type.Literal("high"),
  ], { description: "Optional task priority." }));

  const ToolAllowListSchema = Type.Optional(Type.Array(Type.String({ description: "Tool name" }), { description: "Optional tool allow-list passed to Pi." }));

  const delegateTaskTool = defineTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Launch one bounded background Pi worker so the main conversation can stay available.",
    promptSnippet: "delegate_task(task, title?, cwd?, model?, timeoutMinutes?, tools?, priority?, waitForResult?) — launch one background worker and return task tracking info.",
    promptGuidelines: [
      "Use delegate_task for one long-running or noisy work strand that does not need to monopolize the current turn.",
      "If the work naturally splits into independent strands, prefer delegate_swarm instead of making only one vague worker.",
      "delegate_task is background-first; in v0 waitForResult is ignored and the task is still launched asynchronously.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The worker objective." }),
      title: Type.Optional(Type.String({ description: "Short task title for displays." })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
      model: Type.Optional(Type.String({ description: "Optional model override for the worker." })),
      timeoutMinutes: Type.Optional(Type.Number({ description: "Optional timeout override in minutes." })),
      tools: ToolAllowListSchema,
      priority: TaskPrioritySchema,
      waitForResult: Type.Optional(Type.Boolean({ description: "Ignored in v0; background launch still returns immediately." })),
    }),
    async execute(_toolCallId, params: DelegateTaskParams, _signal, _onUpdate, ctx: ExtensionContext) {
      const activeRuntime = await ensureRuntime();
      const waitForResult = Boolean(params.waitForResult);
      const task = await activeRuntime.launchTask(toLaunchTaskInput(params, ctx.cwd));
      await announceTaskLaunch(task, ctx, waitForResult);
      await refreshStatus(ctx);
      return buildDelegateTaskResult(task, waitForResult);
    },
  });

  const SwarmTaskSchema = Type.Object({
    task: Type.String({ description: "A bounded worker objective within the swarm." }),
    title: Type.Optional(Type.String({ description: "Short task title for displays." })),
    role: Type.Optional(Type.String({ description: "Optional role label such as scout, implementer, reviewer, docs, frontend, or backend." })),
    taskType: Type.Optional(Type.String({ description: "Optional task taxonomy label: scout, research, implementation, verification, audit, summarization, or adoption_review." })),
    roleHint: Type.Optional(Type.String({ description: "Optional extra role guidance." })),
    parentTaskId: Type.Optional(Type.String({ description: "Optional parent/coordinator task id." })),
    cancellationGroup: Type.Optional(Type.String({ description: "Optional cancellation group; defaults to swarm id." })),
    acceptanceCriteria: Type.Optional(Type.String({ description: "What this worker should satisfy before reporting done." })),
    expectedArtifacts: Type.Optional(Type.Array(Type.String(), { description: "Expected output artifacts or evidence refs." })),
    riskLevel: Type.Optional(Type.String({ description: "Optional risk label such as low, medium, or high." })),
    cwd: Type.Optional(Type.String({ description: "Optional working directory override for this worker." })),
    model: Type.Optional(Type.String({ description: "Optional model override for this worker." })),
    timeoutMinutes: Type.Optional(Type.Number({ description: "Optional timeout override in minutes for this worker." })),
    tools: ToolAllowListSchema,
    priority: TaskPrioritySchema,
  }, { additionalProperties: false });

  const delegateSwarmTool = defineTool({
    name: "delegate_swarm",
    label: "Delegate Swarm",
    description: "Launch 2-8 related background Pi workers in one call for parallelizable work strands.",
    promptSnippet: "delegate_swarm({ tasks: [{ task, title?, role? }, ...], objective?, cwd?, model?, timeoutMinutes?, tools?, priority?, waitForResults? }) — fan out a small background worker swarm.",
    promptGuidelines: [
      "Prefer delegate_swarm for non-trivial requests with independent research, implementation, review, docs, frontend/backend, or multi-area codebase strands.",
      "Use 2-4 focused workers for most swarms; only use more when the task genuinely has more independent slices.",
      "Make each worker objective concrete, bounded, and non-overlapping. You remain the coordinator and synthesizer.",
      "delegate_swarm is background-first; in v0 waitForResults is ignored and workers are launched asynchronously under the runtime concurrency cap.",
    ],
    parameters: Type.Object({
      objective: Type.Optional(Type.String({ description: "Optional shared objective or coordination note for the whole swarm." })),
      tasks: Type.Array(SwarmTaskSchema, { minItems: 2, maxItems: MAX_SWARM_TASKS, description: "Worker objectives to launch as one swarm." }),
      cwd: Type.Optional(Type.String({ description: "Shared working directory override for workers that do not specify cwd." })),
      model: Type.Optional(Type.String({ description: "Shared model override for workers that do not specify model." })),
      timeoutMinutes: Type.Optional(Type.Number({ description: "Shared timeout override in minutes." })),
      tools: ToolAllowListSchema,
      priority: TaskPrioritySchema,
      waitForResults: Type.Optional(Type.Boolean({ description: "Ignored in v0; swarm launch still returns immediately." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params: DelegateSwarmParams, _signal, _onUpdate, ctx: ExtensionContext) {
      const waitForResults = Boolean(params.waitForResults);
      const swarm = await launchSwarm(params, ctx);
      await announceSwarmLaunch(swarm.swarmId, swarm.tasks, ctx, waitForResults);
      await refreshStatus(ctx);
      return buildDelegateSwarmResult(swarm.swarmId, swarm.tasks, waitForResults);
    },
  });

  pi.registerTool(delegateTaskTool);
  pi.registerTool(delegateSwarmTool);
}
