import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promises as fsp } from "node:fs";

import { TaskStore } from "./store.js";
import { buildWorkerSystemPrompt, writeWorkerPromptFile } from "./worker-prompt.js";
import type { TaskRecord, TaskResult, TaskStatus } from "./types.js";

export interface WorkerRunOptions {
  store: TaskStore;
  task: TaskRecord;
  piCommand?: string;
  now?: () => string;
  timeoutMs?: number;
}

export interface WorkerHandle {
  taskId: string;
  pid: number;
  cancel: () => void;
  finished: Promise<TaskRecord>;
}

export interface PiInvocation {
  command: string;
  args: string[];
}

interface ParsedAssistantState {
  finalText: string;
}

function isRuntimeBinary(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(base);
}

export function getPiInvocation(baseArgs: string[], piCommand?: string): PiInvocation {
  if (piCommand) {
    return { command: piCommand, args: baseArgs };
  }

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...baseArgs] };
  }

  if (!isRuntimeBinary(process.execPath)) {
    return { command: process.execPath, args: baseArgs };
  }

  return { command: "pi", args: baseArgs };
}

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseSection(rawOutput: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n?([\\s\\S]*?)(?=\\n## |$)`);
  const match = rawOutput.match(regex);
  return match?.[1]?.trim() ?? "";
}

function parseFilesChanged(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0 && !/^no files changed\.?$/i.test(line));
}

function validateResultSections(done: string, filesChangedSection: string, notes: string): string[] {
  const issues: string[] = [];
  if (!done) issues.push("Missing ## Done section content.");
  if (!filesChangedSection) issues.push("Missing ## Files Changed section content.");
  if (!notes) issues.push("Missing ## Notes section content.");
  return issues;
}

export function normalizeTaskResult(
  taskId: string,
  status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled" | "timed_out">,
  rawOutput: string,
  finishedAt: string,
): TaskResult {
  const done = parseSection(rawOutput, "Done");
  const filesChangedSection = parseSection(rawOutput, "Files Changed");
  const notes = parseSection(rawOutput, "Notes");
  const filesChanged = parseFilesChanged(filesChangedSection);
  const validationIssues = validateResultSections(done, filesChangedSection, notes);
  const outputFormatSatisfied = validationIssues.length === 0;
  const summary = outputFormatSatisfied
    ? (done || notes || rawOutput.trim() || status)
    : ((done || notes || rawOutput.trim() || status).slice(0, 600));

  return {
    taskId,
    status,
    summary,
    done,
    filesChanged,
    notes,
    rawOutput,
    finishedAt,
    outputFormatSatisfied,
    validationIssues,
  };
}

export function buildWorkerArgs(task: Pick<TaskRecord, "task" | "model" | "tools">, promptFilePath: string): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptFilePath];
  if (task.model) args.push("--model", task.model);
  if (task.tools && task.tools.length > 0) args.push("--tools", task.tools.join(","));
  args.push(`Task: ${task.task}`);
  return args;
}

async function cleanupPromptFile(dir: string | null): Promise<void> {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function runWorkerInBackground(options: WorkerRunOptions): Promise<WorkerHandle> {
  const { store, task, piCommand, now = () => new Date().toISOString() } = options;
  const timeoutMs = options.timeoutMs ?? (task.timeoutMinutes ? task.timeoutMinutes * 60_000 : undefined);
  const promptFile = await writeWorkerPromptFile(buildWorkerSystemPrompt(task));
  const invocation = getPiInvocation(buildWorkerArgs(task, promptFile.filePath), piCommand);
  const child = spawn(invocation.command, invocation.args, {
    cwd: task.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const startedAt = now();
  let latestTask: TaskRecord = {
    ...task,
    status: "running",
    pid: child.pid ?? null,
    startedAt,
    updatedAt: startedAt,
    latestNote: "Worker started",
  };

  await store.updateTask(latestTask);
  await store.appendEvent({
    taskId: task.id,
    at: startedAt,
    kind: "task.started",
    message: "Worker process started",
    payload: { pid: child.pid ?? null },
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let timer: NodeJS.Timeout | undefined;
  let cancelRequested = false;
  let timedOut = false;
  let finalized = false;
  const assistantState: ParsedAssistantState = { finalText: "" };
  let stdoutQueue = Promise.resolve();
  let stderrQueue = Promise.resolve();

  const processStdoutLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown = trimmed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // keep raw line
    }

    await store.appendWorkerStdoutEvent(task.id, parsed);

    if (!parsed || typeof parsed !== "object") return;
    const event = parsed as { type?: string; message?: unknown; assistantMessageEvent?: { partial?: unknown } };
    const text = event.type === "message_end"
      ? extractAssistantText(event.message)
      : event.type === "message_update"
        ? (extractAssistantText(event.message) || extractAssistantText(event.assistantMessageEvent?.partial))
        : "";
    if (!text) return;
    assistantState.finalText = text;
    latestTask = {
      ...latestTask,
      updatedAt: now(),
      latestNote: text.slice(0, 240),
    };
    await store.updateTask(latestTask);
    await store.appendEvent({
      taskId: task.id,
      at: latestTask.updatedAt,
      kind: "task.progress",
      message: text.slice(0, 240),
    });
  };

  const finalize = async (
    status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled" | "timed_out">,
    finishedAt: string,
    exitCode: number | null,
    fallbackOutput: string,
  ): Promise<TaskRecord> => {
    if (finalized) return latestTask;
    finalized = true;
    if (timer) clearTimeout(timer);
    await stdoutQueue;
    await stderrQueue;

    if (stdoutBuffer.trim()) {
      await processStdoutLine(stdoutBuffer);
      stdoutBuffer = "";
    }

    const rawOutput = assistantState.finalText || stderrBuffer.trim() || fallbackOutput || status;
    const result = normalizeTaskResult(task.id, status, rawOutput, finishedAt);
    await store.writeResult(result);

    latestTask = {
      ...latestTask,
      status,
      updatedAt: finishedAt,
      finishedAt,
      exitCode,
      resultSummary: result.summary,
      latestNote: result.outputFormatSatisfied
        ? result.summary.slice(0, 240)
        : `Unstructured worker output: ${result.validationIssues.join(" ")}`.slice(0, 240),
      error: status === "failed"
        ? (stderrBuffer.trim() || result.summary)
        : (!result.outputFormatSatisfied ? result.validationIssues.join(" ") : null),
    };
    await store.updateTask(latestTask);
    await store.appendEvent({
      taskId: task.id,
      at: finishedAt,
      kind: status === "succeeded"
        ? "task.completed"
        : status === "timed_out"
          ? "task.timeout"
          : status === "cancelled"
            ? "task.cancelled"
            : "task.failed",
      message: result.outputFormatSatisfied ? result.summary : `Worker finished with unstructured output. ${result.validationIssues.join(" ")}`,
      payload: { exitCode, outputFormatSatisfied: result.outputFormatSatisfied, validationIssues: result.validationIssues },
    });
    await cleanupPromptFile(promptFile.dir);
    return latestTask;
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      stdoutQueue = stdoutQueue.then(() => processStdoutLine(line));
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    stderrQueue = stderrQueue.then(() => store.appendWorkerStderr(task.id, text));
  });

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
  }

  const finished = new Promise<TaskRecord>((resolve) => {
    child.on("error", (error) => {
      void finalize("failed", now(), null, error.message).then(resolve);
    });

    child.on("close", (code) => {
      const status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled" | "timed_out"> = timedOut
        ? "timed_out"
        : cancelRequested
          ? "cancelled"
          : code === 0
            ? "succeeded"
            : "failed";
      void finalize(status, now(), code ?? null, status).then(resolve);
    });
  });

  return {
    taskId: task.id,
    pid: child.pid ?? -1,
    cancel: () => {
      if (finalized || cancelRequested) return;
      cancelRequested = true;
      const at = now();
      latestTask = {
        ...latestTask,
        status: "cancelling",
        updatedAt: at,
        latestNote: "Cancellation requested",
      };
      void store.updateTask(latestTask);
      void store.appendEvent({
        taskId: task.id,
        at,
        kind: "task.cancel_requested",
        message: "Cancellation requested",
      });
      child.kill("SIGTERM");
    },
    finished,
  };
}
