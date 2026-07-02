import type { RecallMessage } from "./recall.js";

export interface TaskInfo {
  task_id: string;
  description: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function extractTaskId(value: unknown): string | null {
  if (typeof value === "string") {
    // Real task tool output: <task id="ses_xxx" state="completed">...</task>
    const tagMatch = value.match(/<task\s+id="([^"]+)"/);
    if (tagMatch) return tagMatch[1]!;
    try {
      return extractTaskId(JSON.parse(value));
    } catch {
      const m = value.match(/"task_id"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    }
  }
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.task_id === "string" && rec.task_id) return rec.task_id;
  const inner = rec.output ?? rec.result ?? rec.data;
  if (typeof inner === "string") return extractTaskId(inner);
  const innerRec = asRecord(inner);
  if (innerRec && typeof innerRec.task_id === "string" && innerRec.task_id) {
    return innerRec.task_id;
  }
  return null;
}

function isTaskPartForSubagent(part: unknown, subagentType: string): boolean {
  const p = asRecord(part);
  if (!p) return false;
  const name = p.tool ?? p.name;
  if (name !== "task") return false;
  const state = asRecord(p.state);
  const input = state?.input ?? p.input;
  return asRecord(input)?.subagent_type === subagentType;
}

function partTaskInfo(part: unknown): TaskInfo | null {
  const p = asRecord(part);
  if (!p) return null;
  const state = asRecord(p.state);
  const output = state?.output;
  const input = asRecord(state?.input ?? p.input);
  const taskId = extractTaskId(output) ?? extractTaskId(input);
  if (!taskId) return null;
  const description = typeof input?.description === "string" ? input.description : null;
  return { task_id: taskId, description };
}

function messageParts(message: RecallMessage): unknown[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

/** Extract the latest task_id from task tool calls for the given subagent type. */
function extractTaskIdForSubagent(
  messages: RecallMessage[],
  subagentType: string,
): TaskInfo | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messageParts(messages[i]);
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isTaskPartForSubagent(part, subagentType)) continue;
      const info = partTaskInfo(part);
      if (info) return info;
    }
  }
  return null;
}

/** Extract the latest sidekick task_id. Preserved for backward compatibility. */
export function extractSidekickTaskId(messages: RecallMessage[]): TaskInfo | null {
  return extractTaskIdForSubagent(messages, "sidekick");
}

/** Extract the latest reviewer task_id. */
export function extractReviewerTaskId(messages: RecallMessage[]): TaskInfo | null {
  return extractTaskIdForSubagent(messages, "reviewer");
}

/** Render recovery context for subagent task_ids after compaction. Returns empty string when no task_ids. */
export function compactionContext(
  sidekick?: TaskInfo | null,
  reviewer?: TaskInfo | null,
): string {
  const lines: string[] = [];
  if (sidekick) {
    lines.push(`Sidekick task_id: ${sidekick.task_id}${sidekick.description ? ` (last dispatch: "${sidekick.description}")` : ""}`);
  }
  if (reviewer) {
    lines.push(`Reviewer task_id: ${reviewer.task_id}${reviewer.description ? ` (last dispatch: "${reviewer.description}")` : ""}`);
  }
  if (lines.length === 0) return "";
  return `[Subagent task_ids — recovered after compaction]

${lines.join("\n")}

These task_ids are session handles for resuming subagent sessions. Reuse a task_id to continue the same subagent thread; do not start a fresh subagent unless the prior thread is unrelated or recovery fails.`;
}
