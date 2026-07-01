import type { RecallMessage } from "./recall.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function extractTaskId(value: unknown): string | null {
  if (typeof value === "string") {
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

function isSidekickTaskPart(part: unknown): boolean {
  const p = asRecord(part);
  if (!p) return false;
  const name = p.tool ?? p.name;
  if (name !== "task") return false;
  const state = asRecord(p.state);
  const input = state?.input ?? p.input;
  return asRecord(input)?.subagent_type === "sidekick";
}

function partTaskId(part: unknown): string | null {
  const p = asRecord(part);
  if (!p) return null;
  const state = asRecord(p.state);
  const output = state?.content ?? state?.result ?? p.output ?? p.result ?? p.content;
  const input = state?.input ?? p.input;
  return extractTaskId(output) ?? extractTaskId(input);
}

function messageParts(message: RecallMessage): unknown[] {
  if (Array.isArray(message.parts)) return message.parts;
  const rec = asRecord(message);
  if (rec && Array.isArray(rec.content)) return rec.content as unknown[];
  return [];
}

export function extractSidekickTaskId(messages: RecallMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messageParts(messages[i]);
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isSidekickTaskPart(part)) continue;
      const taskId = partTaskId(part);
      if (taskId) return taskId;
    }
  }
  return null;
}
