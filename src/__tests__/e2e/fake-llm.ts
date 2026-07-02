// Minimal fake OpenAI-compatible LLM server for e2e tests.
//
// Speaks the /v1/chat/completions SSE protocol well enough for opencode to
// run a real session against `test/test-model`: text deltas, tool_calls, and
// a [DONE] sentinel. Responses are queued from the test; unmatched requests
// auto-respond with a short text so a turn always completes.
//
// This is intentionally NOT a general-purpose fake — it covers the chat
// completions tool-call loop only. It does not implement the Responses API
// (/v1/responses) because the test provider uses @ai-sdk/openai-compatible
// which targets /v1/chat/completions.
import http from "node:http";
import { randomUUID } from "node:crypto";

export type Usage = { input: number; output: number };

export type QueuedItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "hang" };

export interface FakeLLM {
  readonly url: string;
  readonly port: number;
  queue(...items: QueuedItem[]): void;
  text(value: string): void;
  tool(name: string, args: unknown): void;
  hang(): void;
  /** Set the usage reported in the next LLM response's finish chunk. */
  setNextUsage(usage: Usage): void;
  reset(): void;
  readonly hits: Array<{ url: string; body: Record<string, unknown> }>;
  wait(count: number): Promise<void>;
  close(): Promise<void>;
}

function sseLine(data: unknown): string {
  if (data === null) return "data: [DONE]\n\n";
  return `data: ${JSON.stringify(data)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finish?: string, usage?: Usage) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          },
        }
      : {}),
  };
}

function isTitleRequest(body: unknown): boolean {
  try {
    return JSON.stringify(body).includes("Generate a title for this conversation");
  } catch {
    return false;
  }
}

export async function startFakeLLM(): Promise<FakeLLM> {
  let queue: QueuedItem[] = [];
  let nextUsage: Usage | null = null;
  const hits: Array<{ url: string; body: Record<string, unknown> }> = [];
  let waiters: Array<{ count: number; resolve: () => void }> = [];

  function notifyWaiters() {
    const ready = waiters.filter((w) => hits.length >= w.count);
    waiters = waiters.filter((w) => hits.length < w.count);
    for (const w of ready) w.resolve();
  }

  function buildSse(items: QueuedItem[]): string {
    const lines: string[] = [];
    lines.push(sseLine(chunk({ role: "assistant" })));
    let hasTool = false;
    for (const item of items) {
      if (item.kind === "text") {
        lines.push(sseLine(chunk({ content: item.text })));
      } else if (item.kind === "tool") {
        hasTool = true;
        const id = randomUUID();
        lines.push(
          sseLine(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: "function",
                  function: { name: item.name, arguments: JSON.stringify(item.args) },
                },
              ],
            }),
          ),
        );
      } else if (item.kind === "hang") {
        // Don't emit [DONE]; the stream stays open until closed.
        return lines.join("");
      }
    }
    const usage = nextUsage ?? { input: 1, output: 1 };
    nextUsage = null;
    lines.push(sseLine(chunk({}, hasTool ? "tool_calls" : "stop", usage)));
    lines.push(sseLine(null));
    return lines.join("");
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const hit = { url: req.url ?? "", body: parsed };
      hits.push(hit);
      notifyWaiters();

      // Title generation requests get a canned response.
      if (isTitleRequest(parsed)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseLine(chunk({ role: "assistant" })));
        res.write(sseLine(chunk({ content: "E2E Title" })));
        res.write(sseLine(chunk({}, "stop", { input: 1, output: 1 })));
        res.write(sseLine(null));
        res.end();
        return;
      }

      // Pull queued items; auto-respond if empty.
      const items: QueuedItem[] =
        queue.length > 0 ? queue.splice(0, queue.length) : [{ kind: "text", text: "ok" } as QueuedItem];
      const sse = buildSse(items);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (items.some((i) => i.kind === "hang")) {
        // Keep the connection open without ending; the test will close the server.
        res.write(sse);
        return;
      }
      res.end(sse);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as import("node:net").AddressInfo;
  if (!addr || typeof addr === "string") throw new Error("failed to bind fake LLM");
  const port = addr.port;
  const url = `http://127.0.0.1:${port}/v1`;

  return {
    url,
    port,
    queue(...items: QueuedItem[]) {
      queue.push(...items);
    },
    text(value: string) {
      queue.push({ kind: "text", text: value });
    },
    tool(name: string, args: unknown) {
      queue.push({ kind: "tool", name, args });
    },
    hang() {
      queue.push({ kind: "hang" });
    },
    setNextUsage(usage: Usage) {
      nextUsage = usage;
    },
    reset() {
      queue = [];
      nextUsage = null;
      hits.length = 0;
      waiters = [];
    },
    hits,
    wait(count: number) {
      if (hits.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
