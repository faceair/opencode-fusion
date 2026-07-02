export interface RecallMessage {
  id?: string;
  type?: string;
  time?: { created?: number; completed?: number };
  info?: unknown;
  parts?: unknown[];
  [key: string]: unknown;
}

export interface RecallQuery {
  query?: string;
  limit: number;
  offset: number;
  role: string | null;
  includeToolOutput: boolean;
}

export interface RecallResult {
  totalMessages: number;
  matchedMessages: number;
  returnedMessages: number;
  offset: number;
  query: string | null;
  role: string | null;
  messages: FormattedMessage[];
}

interface FormattedMessage {
  index: number;
  id: string | null;
  role: string;
  created: number | null;
  text: string;
}

const MAX_LIMIT = 80;
const MAX_OFFSET = 500;
const MAX_TEXT_CHARS = 6000;

// Authoritative message `type` values from the OpenCode session-message
// schema (packages/schema/src/session-message.ts). The `role` filter matches
// against the value produced by messageRole(), which is the message `type`.
export const RECALL_ROLES = [
  "user",
  "assistant",
  "system",
  "shell",
  "synthetic",
  "agent-switched",
  "model-switched",
  "compaction",
] as const;

const RECALL_ROLE_SET = new Set(RECALL_ROLES);

export function normalizeRecallLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? 20)));
}

export function normalizeRecallOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(MAX_OFFSET, Math.floor(offset ?? 0)));
}

// Returns a known lowercase role string, or null when no/invalid role given.
export function normalizeRecallRole(role: string | undefined | null): string | null {
  if (typeof role !== "string") return null;
  const r = role.trim().toLowerCase();
  if (!r) return null;
  return RECALL_ROLE_SET.has(r as (typeof RECALL_ROLES)[number]) ? r : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function partText(part: unknown, includeToolOutput: boolean): string {
  const p = asRecord(part);
  if (!p) return textOf(part);
  const type = typeof p.type === "string" ? p.type : "part";

  if (typeof p.text === "string") return p.text;

  if (type === "tool" || p.tool || p.name) {
    const name = textOf(p.tool ?? p.name ?? "tool");
    const state = asRecord(p.state);
    const status = textOf(state?.status ?? p.status ?? "unknown");
    const input = state?.input ?? p.input;
    const chunks = [`[tool ${name} ${status}]`];
    if (input !== undefined) chunks.push(`input: ${truncate(textOf(input), 1200)}`);
    if (includeToolOutput) {
      const output = state?.output;
      if (output !== undefined) chunks.push(`output: ${truncate(textOf(output), 3000)}`);
    }
    return chunks.join("\n");
  }

  return textOf(p);
}

function messageRole(message: RecallMessage): string {
  if (typeof message.type === "string") return message.type;
  const info = asRecord(message.info);
  if (typeof info?.role === "string") return info.role;
  if (typeof info?.type === "string") return info.type;
  return "message";
}

function messageID(message: RecallMessage): string | null {
  if (typeof message.id === "string") return message.id;
  const info = asRecord(message.info);
  if (typeof info?.id === "string") return info.id;
  return null;
}

function createdAt(message: RecallMessage): number | null {
  const direct = asRecord(message.time)?.created;
  if (typeof direct === "number") return direct;
  const info = asRecord(message.info);
  const infoTime = asRecord(info?.time)?.created;
  if (typeof infoTime === "number") return infoTime;
  return null;
}

function messageText(message: RecallMessage, includeToolOutput: boolean): string {
  if (typeof message.text === "string") return message.text;
  if (typeof message.summary === "string") {
    const recent = typeof message.recent === "string" ? `\nRecent kept verbatim:\n${message.recent}` : "";
    return `Compaction summary:\n${message.summary}${recent}`;
  }
  if (Array.isArray(message.parts)) {
    return message.parts.map((part) => partText(part, includeToolOutput)).filter(Boolean).join("\n\n");
  }
  return textOf(message);
}

export function recallMessages(messages: RecallMessage[], query: RecallQuery): RecallResult {
  const needle = query.query?.trim().toLowerCase() || "";
  const role = query.role;
  const formatted = messages.map((message, index) => {
    return {
      index,
      id: messageID(message),
      role: messageRole(message),
      created: createdAt(message),
      text: truncate(messageText(message, query.includeToolOutput)),
    } satisfies FormattedMessage;
  });

  // Apply role and keyword filters (both must match when present).
  const matched = formatted.filter((message) => {
    if (role !== null && message.role !== role) return false;
    if (needle && !`${message.role}\n${message.text}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  // Page backwards from the most recent matched message: drop `offset` most
  // recent matches, then take the preceding `limit` matches (still in
  // chronological order). offset=0 reproduces the prior `slice(-limit)` behavior.
  const end = Math.max(0, matched.length - query.offset);
  const start = Math.max(0, end - query.limit);
  const returned = matched.slice(start, end);
  return {
    totalMessages: messages.length,
    matchedMessages: matched.length,
    returnedMessages: returned.length,
    offset: query.offset,
    query: needle || null,
    role,
    messages: returned,
  };
}
