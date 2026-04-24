import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { TaskRecord } from "./types.js";

export interface WorkerPromptFile {
  dir: string;
  filePath: string;
}

type WorkerPromptTask = Pick<TaskRecord, "id" | "title" | "task" | "cwd" | "swarmId" | "swarmRole"> & Partial<Pick<TaskRecord, "taskType" | "roleHint" | "parentTaskId" | "cancellationGroup" | "acceptanceCriteria" | "expectedArtifacts" | "riskLevel">>;

export function buildWorkerSystemPrompt(task: WorkerPromptTask): string {
  const swarmGuidance = task.swarmId
    ? [
        "Swarm coordination:",
        "- You are one disposable worker in a parallel swarm, not the coordinator.",
        "- Stay tightly focused on your own objective/role; do not duplicate adjacent worker scopes.",
        "- Produce a standalone handoff summary that the main assistant can synthesize with other worker reports.",
        "- If your slice risks conflicting with another likely slice, call that out in ## Notes instead of broadening scope.",
        "",
      ]
    : [];

  return [
    "You are the default general-purpose background worker for Pi.",
    "You work in an isolated context window so the main conversation can stay focused.",
    "",
    "Do the assigned task directly and competently.",
    "Do not roleplay a specialty unless the task itself demands it.",
    "Use the available tools as needed.",
    "Do not launch or delegate new background workers from inside this worker session unless the task explicitly instructs you to do so.",
    "",
    "Prefer practical progress over ceremony:",
    "- inspect only what you need",
    "- make concrete changes when asked",
    "- keep output compact and useful",
    "- surface risks, blockers, or follow-up items clearly",
    "",
    ...swarmGuidance,
    "Task metadata:",
    `- Task ID: ${task.id}`,
    `- Title: ${task.title}`,
    `- Working directory: ${task.cwd}`,
    task.swarmId ? `- Swarm ID: ${task.swarmId}` : undefined,
    task.swarmRole ? `- Swarm role: ${task.swarmRole}` : undefined,
    task.taskType ? `- Task type: ${task.taskType}` : undefined,
    task.roleHint ? `- Role hint: ${task.roleHint}` : undefined,
    task.parentTaskId ? `- Parent task ID: ${task.parentTaskId}` : undefined,
    task.cancellationGroup ? `- Cancellation group: ${task.cancellationGroup}` : undefined,
    task.riskLevel ? `- Risk level: ${task.riskLevel}` : undefined,
    task.acceptanceCriteria ? `- Acceptance criteria: ${task.acceptanceCriteria}` : undefined,
    Array.isArray(task.expectedArtifacts) && task.expectedArtifacts.length ? `- Expected artifacts: ${task.expectedArtifacts.join('; ')}` : undefined,
    `- Objective: ${task.task}`,
    "",
    "You must finish with exactly these sections:",
    "## Done",
    "## Files Changed",
    "## Notes",
    "",
    "Under ## Files Changed, list changed files as bullets.",
    "If no files changed, say so explicitly.",
    task.acceptanceCriteria ? "Explicitly state whether the acceptance criteria were met under ## Notes." : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export async function writeWorkerPromptFile(prompt: string, prefix = "pi-bg-worker-"): Promise<WorkerPromptFile> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "system-prompt.md");
  await fs.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}
