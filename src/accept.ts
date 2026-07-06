import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { Schema } from "effect";

interface AcceptRecord {
  sessionID: string;
  evidence: string;
  completedCount: number;
  timestamp: number;
}

function acceptLogPath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : join(homedir(), ".local", "share"));
  return process.env.FUSION_ACCEPT_LOG_PATH || join(dataHome, "opencode-fusion", "accept-log.jsonl");
}

async function appendAcceptRecord(record: AcceptRecord): Promise<void> {
  const filePath = acceptLogPath();
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  try {
    const existing = await readFile(filePath, "utf-8").catch(() => "");
    await writeFile(filePath, existing + line, "utf-8");
  } catch {
    await writeFile(filePath, line, "utf-8");
  }
  try {
    await chmod(filePath, 0o600);
  } catch {}
}

function buildAcceptSchema() {
  const TodoInfo = Schema.Struct({
    content: Schema.String,
    status: Schema.String,
    priority: Schema.String,
  });

  return Schema.Struct({
    todos: Schema.mutable(Schema.Array(TodoInfo)),
    evidence: Schema.optional(Schema.String),
  });
}

export async function toolDefinitionHook(
  input: { toolID: string },
  output: { description: string; parameters: any },
): Promise<void> {
  if (input.toolID !== "todowrite") return;
  output.parameters = buildAcceptSchema();
}

export async function toolExecuteBeforeHook(
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
): Promise<void> {
  if (input.tool !== "todowrite") return;

  const args = output.args;
  if (!args || typeof args !== "object") return;
  const todos = Array.isArray(args.todos) ? args.todos : [];
  const completedCount = todos.filter((todo: any) => todo?.status === "completed").length;
  if (completedCount === 0) return;

  const evidence = args.evidence;
  if (typeof evidence !== "string" || evidence.length === 0) {
    throw new Error(
      "todowrite rejected: 'evidence' field is required when marking any todo completed. State what you verified — cite file:line you read, commands you ran with results, or specific code behavior you confirmed. Tests pass alone is not sufficient.",
    );
  }

  await appendAcceptRecord({
    sessionID: input.sessionID,
    evidence,
    completedCount,
    timestamp: Date.now(),
  }).catch(() => {
    // Logging is best-effort; do not block a verified completion if the audit log fails.
  });

  delete args.evidence;
}
