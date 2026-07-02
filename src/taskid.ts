import type { RecallMessage } from "./recall.js";

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

function partTaskId(part: unknown): string | null {
  const p = asRecord(part);
  if (!p) return null;
  const state = asRecord(p.state);
  const output = state?.output;
  const input = state?.input ?? p.input;
  return extractTaskId(output) ?? extractTaskId(input);
}

function messageParts(message: RecallMessage): unknown[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

/** Extract the latest task_id from task tool calls for the given subagent type. */
function extractTaskIdForSubagent(
  messages: RecallMessage[],
  subagentType: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messageParts(messages[i]);
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isTaskPartForSubagent(part, subagentType)) continue;
      const taskId = partTaskId(part);
      if (taskId) return taskId;
    }
  }
  return null;
}

/** Extract the latest sidekick task_id. Preserved for backward compatibility. */
export function extractSidekickTaskId(messages: RecallMessage[]): string | null {
  return extractTaskIdForSubagent(messages, "sidekick");
}

/** Extract the latest reviewer task_id. */
export function extractReviewerTaskId(messages: RecallMessage[]): string | null {
  return extractTaskIdForSubagent(messages, "reviewer");
}
