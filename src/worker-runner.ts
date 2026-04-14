import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Message } from "@mariozechner/pi-ai";

import type { DelegationMode, DelegationTask } from "./schema.js";
import { TaskStore } from "./task-store.js";

export interface WorkerRunParams {
  task: DelegationTask;
  objective: string;
}

export interface WorkerRunResult {
  status: "done" | "failed" | "cancelled";
  summary: string;
  errorMessage?: string;
}

function packageRoot(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

function tempPromptPath(taskId: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-"));
  return { dir, filePath: path.join(dir, `${taskId}.md`) };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function truncate(value: string, max = 300): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function buildWorkerSystemPrompt(task: DelegationTask): string {
  return [
    `You are a delegated worker acting on behalf of ARIA-03.`,
    `Task mode: ${task.mode}.`,
    `Stay bounded to the delegated objective.`,
    `Bring back concrete findings or completed implementation work.`,
    `Do not pretend to be the continuity-bearing primary assistant.`,
    `If you use memory, use it only for read context. Do not modify memory.`,
    `Do not modify SOUL.md or any soul support files.`,
    task.allowNestedDelegation
      ? `Nested delegation is allowed only if necessary and only within the configured depth limit.`
      : `Do not delegate further unless explicitly allowed by tools and policy.`,
    `End with a compact final report: what you did, result, and any important caveats.`,
  ].join("\n");
}

function defaultToolsForMode(mode: DelegationMode): string[] {
  switch (mode) {
    case "research":
      return ["read", "bash", "find", "grep", "ls"];
    case "implementation":
      return ["read", "bash", "find", "grep", "ls", "edit", "write"];
    case "review":
      return ["read", "bash", "find", "grep", "ls"];
    case "design":
      return ["read", "bash", "find", "grep", "ls", "edit", "write"];
    case "general":
    default:
      return ["read", "bash", "find", "grep", "ls"];
  }
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

function memoryReadTools(): string[] {
  return ["memory_search", "memory_diary_read", "memory_kg_query"];
}

export function buildAllowedTools(task: Pick<DelegationTask, "mode" | "includeMemoryRead" | "allowNestedDelegation" | "depth" | "maxDepth">): string[] {
  const tools = new Set(defaultToolsForMode(task.mode));
  if (task.includeMemoryRead) for (const tool of memoryReadTools()) tools.add(tool);
  if (task.allowNestedDelegation && task.depth < task.maxDepth) tools.add("delegate_task");
  return [...tools];
}

function latestAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) return part.text.trim();
    }
  }
  return "";
}

function toolCallPreview(message: Message): string | undefined {
  if (message.role !== "assistant") return undefined;
  const toolCall = message.content.find((part) => part.type === "toolCall");
  if (!toolCall || toolCall.type !== "toolCall") return undefined;
  return `${toolCall.name}`;
}

export async function runDelegatedWorker(params: WorkerRunParams, signal: AbortSignal | undefined, store: TaskStore, importMetaUrl: string): Promise<WorkerRunResult> {
  const { task, objective } = params;
  const root = packageRoot(importMetaUrl);
  const guardPath = path.join(root, "src", "worker-guard.ts");
  const extensionPath = path.join(root, "src", "index.ts");
  const promptFile = tempPromptPath(task.id);
  const prompt = buildWorkerSystemPrompt(task);
  fs.writeFileSync(promptFile.filePath, prompt, { encoding: "utf8", mode: 0o600 });

  const allowedTools = buildAllowedTools(task);
  store.updateTask(task.id, { latestNote: `tools: ${allowedTools.join(", ")}` });

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "-e", extensionPath,
    "-e", guardPath,
    "--append-system-prompt", promptFile.filePath,
    "--tools", BUILTIN_TOOLS.join(","),
  ];
  if (task.model?.trim()) args.push("--model", task.model.trim());
  args.push(objective);

  const invocation = getPiInvocation(args);
  const messages: Message[] = [];
  let latestAssistantOutput = "";
  let stderr = "";
  let buffer = "";
  let wasAborted = false;

  store.startTask(task.id, `launching ${task.mode} worker`);

  const result = await new Promise<WorkerRunResult>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: task.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_DELEGATION_ALLOW_NESTED: task.allowNestedDelegation ? "1" : "0",
        PI_DELEGATION_DEPTH: String(task.depth),
        PI_DELEGATION_MAX_DEPTH: String(task.maxDepth),
        PI_DELEGATION_PARENT_TASK_ID: task.id,
        PI_DELEGATION_ALLOWED_TOOLS: allowedTools.join(","),
      },
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_update" && event.assistantMessageEvent) {
        const update = event.assistantMessageEvent as { type?: string; delta?: string; content?: string };
        if (update.type === "text_delta" && typeof update.delta === "string") {
          latestAssistantOutput += update.delta;
        }
        if (update.type === "text_end" && typeof update.content === "string") {
          latestAssistantOutput = update.content;
          if (update.content.trim()) store.noteTask(task.id, truncate(update.content, 160));
        }
      }

      if (event.type === "message_end" && event.message) {
        const message = event.message as Message;
        messages.push(message);
        const toolPreview = toolCallPreview(message);
        const textPreview = latestAssistantText([message]);
        if (toolPreview) store.noteTask(task.id, `tool: ${toolPreview}`);
        else if (textPreview) {
          latestAssistantOutput = textPreview;
          store.noteTask(task.id, truncate(textPreview, 160));
        }
      }

      if (event.type === "tool_result_end" && event.message) {
        messages.push(event.message as Message);
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      const summary = truncate(latestAssistantOutput || latestAssistantText(messages) || stderr || `${task.agent} finished with exit code ${code ?? 0}`, 500);
      if (wasAborted) {
        store.finishTask(task.id, "cancelled", "worker aborted", { errorMessage: stderr || "aborted" });
        resolve({ status: "cancelled", summary, errorMessage: stderr || "aborted" });
        return;
      }
      if ((code ?? 0) !== 0) {
        store.finishTask(task.id, "failed", "worker failed", { resultSummary: summary, errorMessage: stderr || `exit code ${code ?? 0}` });
        resolve({ status: "failed", summary, errorMessage: stderr || `exit code ${code ?? 0}` });
        return;
      }
      store.finishTask(task.id, "done", "worker finished", { resultSummary: summary });
      resolve({ status: "done", summary });
    });

    proc.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.finishTask(task.id, "failed", "worker spawn error", { errorMessage: message });
      resolve({ status: "failed", summary: message, errorMessage: message });
    });

    if (signal) {
      const abort = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });

  try {
    fs.unlinkSync(promptFile.filePath);
  } catch {}
  try {
    fs.rmdirSync(promptFile.dir);
  } catch {}

  return result;
}
