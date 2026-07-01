export interface AutoContinueMessage {
  type?: string;
  parts?: unknown[];
  content?: unknown;
  info?: unknown;
  time?: unknown;
  error?: unknown;
  finish?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function messageRole(message: AutoContinueMessage): string {
  if (typeof message.type === "string") return message.type;
  const info = asRecord(message.info);
  if (typeof info?.role === "string") return info.role;
  if (typeof info?.type === "string") return info.type;
  return "message";
}

function messageCreatedAt(message: AutoContinueMessage): number | null {
  const direct = asRecord(message.time)?.created;
  if (typeof direct === "number") return direct;
  const info = asRecord(message.info);
  const infoTime = asRecord(info?.time)?.created;
  if (typeof infoTime === "number") return infoTime;
  return null;
}

function latestMessage(messages: AutoContinueMessage[]): AutoContinueMessage | undefined {
  const ordered = messages
    .map((message, index) => ({ message, index, created: messageCreatedAt(message) }))
    .sort((a, b) => {
      if (a.created !== null && b.created !== null && a.created !== b.created) return a.created - b.created;
      if (a.created !== null && b.created === null) return 1;
      if (a.created === null && b.created !== null) return -1;
      return a.index - b.index;
    });
  return ordered.at(-1)?.message;
}

function interruptedMetadata(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return record.interrupted === true;
}

function isAbortError(value: unknown): boolean {
  const error = asRecord(value);
  if (!error) return false;
  const data = asRecord(error.data);
  return error.name === "MessageAbortedError" || data?.message === "Aborted";
}

function isInterruptedPart(part: unknown): boolean {
  const record = asRecord(part);
  if (!record) return false;
  if (interruptedMetadata(record.metadata)) return true;

  const state = asRecord(record.state);
  if (!state) return false;
  if (interruptedMetadata(state.metadata)) return true;
  return state.error === "Tool execution aborted";
}

export function isInterruptedAssistantMessage(message: AutoContinueMessage): boolean {
  const role = messageRole(message).toLowerCase();
  if (role !== "assistant") return false;

  const info = asRecord(message.info);
  if (isAbortError(message.error) || isAbortError(info?.error)) return true;

  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : [];
  return parts.some(isInterruptedPart);
}

export function shouldSkipAutoContinueForMessages(messages: AutoContinueMessage[]): boolean {
  const latest = latestMessage(messages);
  return latest ? isInterruptedAssistantMessage(latest) : false;
}
