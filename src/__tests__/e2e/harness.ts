// Fusion e2e harness: spawns a real `opencode serve` subprocess with the
// fusion plugin loaded, a fake LLM in-process, and full env isolation.
//
// Modeled after opencode's test/lib/cli-process.ts but self-contained in
// opencode-fusion so we don't modify the opencode repo.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { FakeLLM } from "./fake-llm.js";

const OPENCODE_ROOT = process.env.OPENCODE_ROOT ?? "/Users/faceair/Developer/opencode";
const OPENCODE_ENTRY = join(OPENCODE_ROOT, "packages/opencode/src/index.ts");
const FUSION_DIST = join(import.meta.dir, "..", "..", "..", "dist", "server.js");

if (!existsSync(OPENCODE_ENTRY)) {
  throw new Error(
    `opencode entry not found at ${OPENCODE_ENTRY}. Set OPENCODE_ROOT to your opencode repo checkout.`,
  );
}

export interface FusionEnv {
  readonly home: string;
  readonly goalStatePath: string;
  readonly llm: FakeLLM;
  readonly serverUrl: string;
  readonly client: OpencodeClient;
  close(): Promise<void>;
}

function fusionPluginUrl(): string {
  return pathToFileURL(FUSION_DIST).href;
}

function testProviderConfig(llmUrl: string, modelLimit?: { context: number; output: number }) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: modelLimit ?? { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: llmUrl },
      },
    },
    plugin: [fusionPluginUrl()],
  };
}

function isolatedEnv(
  home: string,
  goalStatePath: string,
  configJson: string,
  opts?: { enableAutoCompact?: boolean },
): Record<string, string> {
  const base: Record<string, string> = {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: configJson,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    // NOT setting OPENCODE_PURE — we need plugins to load.
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    FUSION_GOAL_STATE_PATH: goalStatePath,
  };
  if (opts?.enableAutoCompact) delete base.OPENCODE_DISABLE_AUTOCOMPACT;
  return base;
}

// Pre-create node_modules + package-lock.json in config directories so the
// npm install that opencode runs during config loading is a no-op. Without
// this, the install hangs trying to reach the npm registry from the isolated
// tmpdir. Mirrors opencode's test/fixture/plugin.ts markPluginDependenciesReady.
async function markPluginDependenciesReady(dir: string) {
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await writeFile(
    join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "0.0.0" } } } }),
  );
}

export async function withFusionEnv<T>(
  fn: (env: FusionEnv) => Promise<T>,
  opts?: { readyTimeoutMs?: number; modelLimit?: { context: number; output: number }; enableAutoCompact?: boolean },
): Promise<T> {
  const { startFakeLLM } = await import("./fake-llm.js");
  const llm = await startFakeLLM();

  const home = await mkdtemp(join(tmpdir(), "fusion-e2e-"));
  const goalStatePath = join(home, "goals.json");
  const configJson = JSON.stringify(testProviderConfig(llm.url, opts?.modelLimit));
  const env = isolatedEnv(home, goalStatePath, configJson, opts);

  // Pre-create plugin dependencies in config directories so npm install is a no-op.
  // opencode walks these directories during config loading and tries to install
  // @opencode-ai/plugin into each. Without this, the install hangs.
  await markPluginDependenciesReady(join(home, ".config", "opencode"));
  await markPluginDependenciesReady(join(home, ".opencode"));

  // Spawn opencode serve
  const child = spawn(
    "bun",
    ["run", "--conditions=browser", OPENCODE_ENTRY, "serve", "--port", "0", "--hostname", "127.0.0.1"],
    {
      cwd: home,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c.toString()));

  const readyTimeoutMs = opts?.readyTimeoutMs ?? 30_000;
  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `opencode serve did not become ready within ${readyTimeoutMs}ms\nstderr: ${stderrChunks.join("").slice(-2000)}`,
        ),
      );
    }, readyTimeoutMs);

    let stdoutBuf = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString();
      for (const line of stdoutBuf.split("\n")) {
        const m = line.match(/listening on (http:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
          return;
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `opencode serve exited with code ${code} before ready\nstderr: ${stderrChunks.join("").slice(-2000)}`,
        ),
      );
    });
  });

  const client = createOpencodeClient({ baseUrl: serverUrl, directory: home });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    child.kill();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await llm.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  try {
    return await fn({ home, goalStatePath, llm, serverUrl, client, close });
  } finally {
    await close();
  }
}

// Helper: wait for a session to reach idle status by polling session.status.
// Note: if the fusion plugin's auto-continue is active (goal is set), the
// session may never go idle because the plugin sends a continuation prompt.
// Use waitForToolComplete instead for tool-call assertions.
export async function waitForIdle(client: OpencodeClient, sessionID: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await client.session.status();
      const map = (result.data ?? {}) as Record<string, { type: string }>;
      const status = map[sessionID];
      if (status && status.type === "idle") return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`session ${sessionID} did not reach idle within ${timeoutMs}ms`);
}

// Helper: wait for a session to reach "busy" status (useful for detecting
// auto-continue). Returns true if busy was observed, false on timeout.
export async function waitForBusy(client: OpencodeClient, sessionID: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await client.session.status();
      const map = (result.data ?? {}) as Record<string, { type: string }>;
      const status = map[sessionID];
      if (status && status.type === "busy") return true;
    } catch {}
    await Bun.sleep(100);
  }
  return false;
}

// Helper: poll session.messages() until a tool part with the given name
// reaches "completed" status. Returns the tool part or throws on timeout.
export async function waitForToolComplete(
  client: OpencodeClient,
  sessionID: string,
  toolName: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await client.session.messages({
        path: { id: sessionID },
        query: { limit: 80 },
      } as any);
      const messages = (result.data ?? result) as any[];
      if (Array.isArray(messages)) {
        const found = findToolPart(messages, toolName);
        if (found) {
          const state = found.part.state as Record<string, unknown>;
          if (state.status === "completed" || state.status === "error") {
            return found.part;
          }
        }
      }
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`tool ${toolName} did not complete within ${timeoutMs}ms`);
}

// Helper: find a tool part in messages by tool name.
export function findToolPart(
  messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
  toolName: string,
): { part: Record<string, unknown>; messageIndex: number; partIndex: number } | undefined {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    for (let j = 0; j < msg.parts.length; j++) {
      const part = msg.parts[j]!;
      if (part.type === "tool" && part.tool === toolName) {
        return { part, messageIndex: i, partIndex: j };
      }
    }
  }
  return undefined;
}
