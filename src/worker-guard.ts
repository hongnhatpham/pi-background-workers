import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const BLOCKED_MEMORY_TOOLS = new Set([
  "memory_store",
  "memory_delete",
  "memory_native",
  "memory_diary_write",
  "memory_kg_add",
  "memory_kg_invalidate",
]);

function resolveProtectedSoulRoots(): string[] {
  return [
    path.resolve(os.homedir(), ".pi", "agent", "soul"),
  ];
}

function isProtectedSoulPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return resolveProtectedSoulRoots().some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function isLikelySoulWriteCommand(command: string): boolean {
  const compact = command.replace(/\s+/g, " ");
  const touchesSoul = compact.includes(".pi/agent/soul") || compact.includes("SOUL.md");
  if (!touchesSoul) return false;
  return /(>|>>|\btee\b|\bsed\s+-i\b|\bperl\s+-i\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b)/.test(compact);
}

export default function workerGuardExtension(pi: ExtensionAPI) {
  if ((globalThis as any).__delegateWorkerGuardLoaded) return;
  (globalThis as any).__delegateWorkerGuardLoaded = true;

  pi.on("tool_call", async (event) => {
    if (BLOCKED_MEMORY_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Subagents may not modify memory via ${event.toolName}.` };
    }

    if (event.toolName === "delegate_task") {
      const allowNested = process.env.PI_DELEGATION_ALLOW_NESTED === "1";
      const depth = Number.parseInt(process.env.PI_DELEGATION_DEPTH ?? "0", 10) || 0;
      const maxDepth = Number.parseInt(process.env.PI_DELEGATION_MAX_DEPTH ?? "0", 10) || 0;
      if (!allowNested) {
        return { block: true, reason: "Nested delegation is disabled for this subagent task." };
      }
      if (depth >= maxDepth) {
        return { block: true, reason: `Nested delegation depth limit reached (${depth}/${maxDepth}).` };
      }
    }

    if ((event.toolName === "edit" || event.toolName === "write") && isProtectedSoulPath((event.input as any)?.path)) {
      return { block: true, reason: "Subagents may not modify soul files." };
    }

    if (event.toolName === "bash" && isLikelySoulWriteCommand(String((event.input as any)?.command ?? ""))) {
      return { block: true, reason: "Subagents may not modify soul files via bash." };
    }
  });
}
