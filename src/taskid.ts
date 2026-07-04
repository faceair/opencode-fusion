import type { SessionMessage } from "./session-history.js";

export interface TaskInfo {
  task_id: string;
  description: string | null;
  last_used_at: number;
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

function asTimestamp(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function partTaskInfo(part: unknown, messageCreatedAt: number): TaskInfo | null {
  const p = asRecord(part);
  if (!p) return null;
  const state = asRecord(p.state);
  const time = asRecord(state?.time);
  const output = state?.output;
  const input = asRecord(state?.input ?? p.input);
  const taskId = extractTaskId(output) ?? extractTaskId(input);
  if (!taskId) return null;
  const description = typeof input?.description === "string" ? input.description : null;
  const last_used_at =
    asTimestamp(time?.end) ?? asTimestamp(time?.start) ?? messageCreatedAt;
  return { task_id: taskId, description, last_used_at };
}

function messageParts(message: SessionMessage): unknown[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

/** Extract all task_ids from task tool calls, grouped by subagent type, newest-first. */
export function extractAllTaskIds(messages: SessionMessage[]): Record<string, TaskInfo[]> {
  const byType: Record<string, Map<string, TaskInfo>> = {};
  for (const message of messages) {
    const messageTime = asRecord(message.time);
    const messageCreatedAt = asTimestamp(messageTime?.created) ?? 0;
    const parts = messageParts(message);
    for (const part of parts) {
      const subagentType = taskPartSubagentType(part);
      if (!subagentType) continue;
      const info = partTaskInfo(part, messageCreatedAt);
      if (!info) continue;
      const group = (byType[subagentType] ??= new Map<string, TaskInfo>());
      const existing = group.get(info.task_id);
      if (!existing || info.last_used_at > existing.last_used_at) {
        group.set(info.task_id, info);
      }
    }
  }

  const result: Record<string, TaskInfo[]> = {};
  for (const [subagentType, tasks] of Object.entries(byType)) {
    result[subagentType] = [...tasks.values()].sort(
      (a, b) => b.last_used_at - a.last_used_at,
    );
  }
  return result;
}
