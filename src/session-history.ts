export interface SessionMessage {
  id?: string;
  type?: string;
  time?: { created?: number; completed?: number };
  info?: unknown;
  parts?: unknown[];
  [key: string]: unknown;
}

export const SESSION_HISTORY_ROLES = ["user", "assistant"] as const;
export const SESSION_HISTORY_KINDS = [
  "user_text",
  "assistant_text",
  "tool_input",
  "tool_output",
  "tool_error",
  "reasoning",
] as const;

export type SessionHistoryRole = (typeof SESSION_HISTORY_ROLES)[number];
export type SessionHistoryKind = (typeof SESSION_HISTORY_KINDS)[number];

export interface SessionHistorySearchQuery {
  query?: string;
  kind?: SessionHistoryKind[];
  toolName?: string;
  role: SessionHistoryRole | null;
  timeAfter?: number;
  timeBefore?: number;
  limit: number;
  offset: number;
  includeToolOutput: boolean;
}

export interface SessionHistorySearchResult {
  totalMessages: number;
  matchedMessages: number;
  returnedMessages: number;
  offset: number;
  query: string | null;
  role: SessionHistoryRole | null;
  kind: SessionHistoryKind[] | null;
  tool_name: string | null;
  time_after: number | null;
  time_before: number | null;
  messages: FormattedMessage[];
}

export interface SessionHistoryAroundResult {
  anchorMessageId: string;
  sessionID?: string;
  messages: Array<FormattedMessage & { matched: boolean }>;
  error?: string;
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
const MAX_AROUND = 50;
const MAX_TEXT_CHARS = 6000;
const ROLE_SET = new Set(SESSION_HISTORY_ROLES);
const KIND_SET = new Set(SESSION_HISTORY_KINDS);

export function normalizeSessionHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? 20)));
}

export function normalizeSessionHistoryOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(MAX_OFFSET, Math.floor(offset ?? 0)));
}

export function normalizeSessionHistoryAround(value: number | undefined): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(0, Math.min(MAX_AROUND, Math.floor(value ?? 5)));
}

export function normalizeSessionHistoryRole(role: string | undefined | null): SessionHistoryRole | null {
  if (typeof role !== "string") return null;
  const value = role.trim().toLowerCase();
  return ROLE_SET.has(value as SessionHistoryRole) ? value as SessionHistoryRole : null;
}

export function normalizeSessionHistoryKinds(kind: unknown): SessionHistoryKind[] | null {
  const values = Array.isArray(kind) ? kind : typeof kind === "string" ? [kind] : [];
  const result = values
    .map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
    .filter((value): value is SessionHistoryKind => KIND_SET.has(value as SessionHistoryKind));
  return result.length > 0 ? [...new Set(result)] : null;
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

function toolState(part: unknown) {
  return asRecord(asRecord(part)?.state);
}

export function partKind(part: unknown, role: string): SessionHistoryKind | null {
  const p = asRecord(part);
  if (!p) return null;
  if (p.type === "reasoning") return "reasoning";
  if (p.type === "text" || typeof p.text === "string") {
    if (role === "user") return "user_text";
    if (role === "assistant") return "assistant_text";
    return null;
  }
  if (p.type !== "tool" && !p.tool && !p.name) return null;
  const status = toolState(part)?.status ?? p.status;
  if (status === "completed") return "tool_output";
  if (status === "error") return "tool_error";
  return "tool_input";
}

function toolName(part: unknown): string | null {
  const p = asRecord(part);
  if (!p || (p.type !== "tool" && !p.tool && !p.name)) return null;
  const name = p.tool ?? p.name;
  return typeof name === "string" && name ? name : null;
}

function partText(part: unknown, includeToolOutput: boolean): string {
  const p = asRecord(part);
  if (!p) return textOf(part);
  const type = typeof p.type === "string" ? p.type : "part";

  if (typeof p.text === "string") return p.text;
  if (type === "reasoning") return textOf(p.text ?? p.content ?? p);

  if (type === "tool" || p.tool || p.name) {
    const name = textOf(p.tool ?? p.name ?? "tool");
    const state = toolState(part);
    const status = textOf(state?.status ?? p.status ?? "unknown");
    const input = state?.input ?? p.input;
    const chunks = [`[tool ${name} ${status}]`];
    if (input !== undefined) chunks.push(`input: ${truncate(textOf(input), 1200)}`);
    if (includeToolOutput) {
      const output = state?.output;
      if (output !== undefined) chunks.push(`output: ${truncate(textOf(output), 3000)}`);
      const error = state?.error;
      if (error !== undefined) chunks.push(`error: ${truncate(textOf(error), 3000)}`);
    }
    return chunks.join("\n");
  }

  return textOf(p);
}

export function messageRole(message: SessionMessage): string {
  if (typeof message.type === "string") return message.type;
  const info = asRecord(message.info);
  if (typeof info?.role === "string") return info.role;
  if (typeof info?.type === "string") return info.type;
  return "message";
}

export function messageID(message: SessionMessage): string | null {
  if (typeof message.id === "string") return message.id;
  const info = asRecord(message.info);
  if (typeof info?.id === "string") return info.id;
  return null;
}

export function createdAt(message: SessionMessage): number | null {
  const direct = asRecord(message.time)?.created;
  if (typeof direct === "number") return direct;
  const info = asRecord(message.info);
  const infoTime = asRecord(info?.time)?.created;
  if (typeof infoTime === "number") return infoTime;
  return null;
}

function messageParts(message: SessionMessage): unknown[] {
  return Array.isArray(message.parts) ? message.parts : [];
}

function messageText(message: SessionMessage, includeToolOutput: boolean): string {
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

function formatMessage(message: SessionMessage, index: number, includeToolOutput: boolean): FormattedMessage {
  return {
    index,
    id: messageID(message),
    role: messageRole(message),
    created: createdAt(message),
    text: truncate(messageText(message, includeToolOutput)),
  };
}

function matchesKind(message: SessionMessage, kinds: SessionHistoryKind[] | null): boolean {
  if (!kinds) return true;
  const role = messageRole(message);
  return messageParts(message).some((part) => {
    const kind = partKind(part, role);
    return kind ? kinds.includes(kind) : false;
  });
}

function matchesToolName(message: SessionMessage, name: string | undefined): boolean {
  if (!name) return true;
  return messageParts(message).some((part) => toolName(part) === name);
}

export function searchMessages(messages: SessionMessage[], query: SessionHistorySearchQuery): SessionHistorySearchResult {
  const needle = query.query?.trim().toLowerCase() || "";
  const toolFilter = query.toolName?.trim() || "";
  const formatted = messages.map((message, index) => formatMessage(message, index, query.includeToolOutput));
  const matched = formatted.filter((message) => {
    const raw = messages[message.index]!;
    if (query.role !== null && message.role !== query.role) return false;
    if (query.timeAfter !== undefined && message.created !== null && message.created <= query.timeAfter) return false;
    if (query.timeBefore !== undefined && message.created !== null && message.created >= query.timeBefore) return false;
    if (query.timeAfter !== undefined && message.created === null) return false;
    if (query.timeBefore !== undefined && message.created === null) return false;
    if (!matchesKind(raw, query.kind ?? null)) return false;
    if (!matchesToolName(raw, toolFilter)) return false;
    if (needle && !`${message.role}\n${message.text}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const end = Math.max(0, matched.length - query.offset);
  const start = Math.max(0, end - query.limit);
  const returned = matched.slice(start, end);
  return {
    totalMessages: messages.length,
    matchedMessages: matched.length,
    returnedMessages: returned.length,
    offset: query.offset,
    query: needle || null,
    role: query.role,
    kind: query.kind ?? null,
    tool_name: toolFilter || null,
    time_after: query.timeAfter ?? null,
    time_before: query.timeBefore ?? null,
    messages: returned,
  };
}

export function aroundMessages(
  messages: SessionMessage[],
  anchorId: string,
  before: number,
  after: number,
  includeToolOutput: boolean,
  sessionID?: string,
): SessionHistoryAroundResult {
  const anchorIndex = messages.findIndex((message) => messageID(message) === anchorId);
  if (anchorIndex === -1) {
    return {
      anchorMessageId: anchorId,
      ...(sessionID ? { sessionID } : {}),
      messages: [],
      error: `Message not found: ${anchorId}`,
    };
  }
  return {
    anchorMessageId: anchorId,
    ...(sessionID ? { sessionID } : {}),
    messages: messages
      .slice(Math.max(0, anchorIndex - before), Math.min(messages.length, anchorIndex + after + 1))
      .map((message, sliceIndex) => {
        const index = Math.max(0, anchorIndex - before) + sliceIndex;
        return { ...formatMessage(message, index, includeToolOutput), matched: index === anchorIndex };
      }),
  };
}
