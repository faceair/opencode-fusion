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

function taskPartSubagentType(part: unknown): string | null {
  const p = asRecord(part);
  if (!p) return null;
  const name = p.tool ?? p.name;
  if (name !== "task") return null;
  const state = asRecord(p.state);
  const input = asRecord(state?.input ?? p.input);
  const subagentType = input?.subagent_type;
  return typeof subagentType === "string" && subagentType ? subagentType : null;
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

/** Extract all task_ids from task tool calls, grouped by subagent type, newest-first. */
export function extractAllTaskIds(messages: RecallMessage[]): Record<string, TaskInfo[]> {
  const result: Record<string, TaskInfo[]> = {};
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messageParts(messages[i]);
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      const subagentType = taskPartSubagentType(part);
      if (!subagentType) continue;
      const info = partTaskInfo(part);
      if (!info) continue;
      (result[subagentType] ??= []).push(info);
    }
  }
  return result;
}
