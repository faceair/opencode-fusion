export interface AutoContinueMessage {
  type?: string;
  parts?: unknown[];
  content?: unknown;
  info?: unknown;
  time?: unknown;
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

// In the auto-continue path the session is idle, so an assistant message
// without a finish marker did not complete normally — it was interrupted
// (e.g. user pressed Esc). Abort can fire the idle event before the
// message's error field is persisted, so checking finish absence is the
// reliable signal across all abort timing windows.
export function isInterruptedAssistantMessage(message: AutoContinueMessage): boolean {
  const role = messageRole(message).toLowerCase();
  if (role !== "assistant") return false;

  const info = asRecord(message.info);
  const finish = typeof message.finish === "string"
    ? message.finish
    : typeof info?.finish === "string"
      ? info.finish
      : null;
  return !finish;
}

export function shouldSkipAutoContinueForMessages(messages: AutoContinueMessage[]): boolean {
  const latest = latestMessage(messages);
  return latest ? isInterruptedAssistantMessage(latest) : false;
}
