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
  includeToolOutput: boolean;
}

export interface RecallResult {
  totalMessages: number;
  matchedMessages: number;
  returnedMessages: number;
  query: string | null;
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
const MAX_TEXT_CHARS = 6000;

export function normalizeRecallLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? 20)));
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
  const formatted = messages.map((message, index) => {
    return {
      index,
      id: messageID(message),
      role: messageRole(message),
      created: createdAt(message),
      text: truncate(messageText(message, query.includeToolOutput)),
    } satisfies FormattedMessage;
  });

  const matched = needle
    ? formatted.filter((message) => `${message.role}\n${message.text}`.toLowerCase().includes(needle))
    : formatted;
  const returned = matched.slice(-query.limit);
  return {
    totalMessages: messages.length,
    matchedMessages: matched.length,
    returnedMessages: returned.length,
    query: needle || null,
    messages: returned,
  };
}
