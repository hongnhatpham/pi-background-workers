import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import type { DelegationTask } from "./schema.js";
import { TaskStore } from "./task-store.js";

const CUSTOM_MESSAGE_TYPE = "delegation-output";
const store = new TaskStore();

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
    lines.push(`${indent}${state} ${task.agent} — ${truncate(task.title, 90)}${task.latestNote ? ` [${truncate(task.latestNote, 48)}]` : ""}`);
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
    .slice(-15)
    .map((event) => `- ${event.at} ${event.kind}${event.taskId ? ` ${event.taskId.slice(0, 8)}` : ""} :: ${truncate(event.message, 140)}`)
    .join("\n");
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

export default function subagentOrchestratorExtension(pi: ExtensionAPI) {
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

  pi.registerCommand("delegate-clear", {
    description: "Clear the local delegation snapshot and event log",
    handler: async (_args, ctx) => {
      store.clear();
      syncStatus(ctx);
      ctx.ui.notify("Delegation store cleared", "info");
    },
  });

  pi.registerCommand("delegate-demo", {
    description: "Create a tiny demo task tree so the observable workflow can be inspected",
    handler: async (_args, ctx) => {
      const root = store.createTask({
        title: "Investigate a delegated implementation task",
        agent: "ARIA-03",
        cwd: ctx.cwd,
      });
      store.startTask(root.id, "Planning fan-out");

      const scout = store.createTask({
        title: "Inspect relevant code paths",
        agent: "scout",
        cwd: ctx.cwd,
        parentId: root.id,
      });
      store.startTask(scout.id, "Reading repository files");
      store.finishTask(scout.id, "done", "Reported findings to parent");

      const worker = store.createTask({
        title: "Draft implementation approach",
        agent: "worker",
        cwd: ctx.cwd,
        parentId: root.id,
      });
      store.startTask(worker.id, "Preparing patch plan");
      store.noteTask(worker.id, "Could further delegate review if policy allows");
      store.finishTask(worker.id, "done", "Returned implementation summary");

      store.finishTask(root.id, "done", "Synthesized child reports");
      syncStatus(ctx);
      showOutput(pi, "Delegation demo", `Created demo task tree.\n\n${renderTree(store.listTasks())}`);
    },
  });
}
