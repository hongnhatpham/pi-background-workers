import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { TaskRecord } from "./types.js";

export interface WorkerPromptFile {
  dir: string;
  filePath: string;
}

export function buildWorkerSystemPrompt(task: Pick<TaskRecord, "id" | "title" | "task" | "cwd">): string {
  return [
    "You are the default general-purpose background worker for Pi.",
    "You work in an isolated context window so the main conversation can stay focused.",
    "",
    "Do the assigned task directly and competently.",
    "Do not roleplay a specialty unless the task itself demands it.",
    "Use the available tools as needed.",
    "",
    "Prefer practical progress over ceremony:",
    "- inspect only what you need",
    "- make concrete changes when asked",
    "- keep output compact and useful",
    "- surface risks, blockers, or follow-up items clearly",
    "",
    "Task metadata:",
    `- Task ID: ${task.id}`,
    `- Title: ${task.title}`,
    `- Working directory: ${task.cwd}`,
    `- Objective: ${task.task}`,
    "",
    "You must finish with exactly these sections:",
    "## Done",
    "## Files Changed",
    "## Notes",
    "",
    "Under ## Files Changed, list changed files as bullets.",
    "If no files changed, say so explicitly.",
  ].join("\n");
}

export async function writeWorkerPromptFile(prompt: string, prefix = "pi-bg-worker-"): Promise<WorkerPromptFile> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "system-prompt.md");
  await fs.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}
