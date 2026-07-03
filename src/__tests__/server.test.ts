import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../server.js";
import * as goal from "../goal.js";
import type { RecallMessage } from "../recall.js";

let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "fusion-server-test-"));
  process.env.FUSION_GOAL_STATE_PATH = join(tempDir, "goals.json");
});

afterEach(async () => {
  delete process.env.FUSION_GOAL_STATE_PATH;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
  const start = Date.now();
  while (Date.now() - start < 1000) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for test condition");
}

function taskMessage(taskID = "ses_side123"): RecallMessage {
  return {
    type: "assistant",
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {
            subagent_type: "sidekick",
            description: "sidekick work",
            prompt: "do work",
          },
          output: `<task id="${taskID}" state="completed">done</task>`,
        },
      },
    ],
  } as RecallMessage;
}

function normalAssistantMessage(): RecallMessage {
  return {
    type: "assistant",
    finish: "stop",
    parts: [{ type: "text", text: "done" }],
    time: { created: Date.now() },
  } as RecallMessage;
}

async function makeHooks(
  messages: Array<RecallMessage[] | Promise<RecallMessage[]>>,
  promptWaits: Array<Promise<unknown>> = [],
) {
  const prompts: string[] = [];
  const logs: unknown[] = [];
  const client = {
    session: {
      messages: async () => ({ data: await messages.shift() }),
      promptAsync: async (input: any) => {
        prompts.push(input.body.parts[0].text);
        const wait = promptWaits.shift();
        if (wait) await wait;
      },
    },
    app: {
      log: async (input: unknown) => {
        logs.push(input);
      },
    },
  };
  const hooks = await plugin.server({ client } as any, undefined);
  return { hooks: hooks as any, prompts, logs };
}

function compactedEvent(sessionID: string) {
  return { type: "session.compacted", properties: { sessionID } };
}

function idleEvent(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } };
}

describe("server compaction auto-continue coordination", () => {
  test("compacted before idle sends one recovery continuation with task_id", async () => {
    const sessionID = "ses_compact_first";
    await goal.createGoal(sessionID, "compact first goal");
    const promptGate = deferred();
    const { hooks, prompts } = await makeHooks([[taskMessage()]], [promptGate.promise]);

    const compact = hooks.event({ event: compactedEvent(sessionID) });
    await waitFor(() => prompts.length === 1);
    const idle = hooks.event({ event: idleEvent(sessionID) });

    promptGate.resolve();
    await compact;
    await idle;

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Continue working toward the current goal");
    expect(prompts[0]).toContain("Sidekick task_id: ses_side123");
  });

  test("idle during compact recovery is suppressed and only recovery continuation is sent", async () => {
    const sessionID = "ses_idle_during_compact";
    await goal.createGoal(sessionID, "idle during compact goal");
    const compactMessages = deferred<RecallMessage[]>();
    const { hooks, prompts } = await makeHooks([compactMessages.promise]);

    const compact = hooks.event({ event: compactedEvent(sessionID) });
    const idle = hooks.event({ event: idleEvent(sessionID) });
    await Bun.sleep(0);
    expect(prompts.length).toBe(0);

    compactMessages.resolve([taskMessage()]);
    await compact;
    await idle;

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Continue working toward the current goal");
    expect(prompts[0]).toContain("Sidekick task_id: ses_side123");
  });

  test("compaction without task_id falls back to normal idle continuation", async () => {
    const sessionID = "ses_compact_no_task";
    await goal.createGoal(sessionID, "no task compact goal");
    const compactMessages = deferred<RecallMessage[]>();
    const { hooks, prompts } = await makeHooks([
      compactMessages.promise,
      [normalAssistantMessage()],
    ]);

    const compact = hooks.event({ event: compactedEvent(sessionID) });
    const idle = hooks.event({ event: idleEvent(sessionID) });
    compactMessages.resolve([]);
    await compact;
    await idle;

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Continue working toward the current goal");
    expect(prompts[0]).not.toContain("task_id");
  });

  test("compaction error falls back to normal idle continuation", async () => {
    const sessionID = "ses_compact_error";
    await goal.createGoal(sessionID, "compact error goal");
    const compactMessages = deferred<RecallMessage[]>();
    const { hooks, prompts, logs } = await makeHooks([
      compactMessages.promise,
      [normalAssistantMessage()],
    ]);

    const compact = hooks.event({ event: compactedEvent(sessionID) });
    const idle = hooks.event({ event: idleEvent(sessionID) });
    compactMessages.reject(new Error("messages failed"));
    await compact;
    await idle;

    expect(logs.length).toBe(1);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Continue working toward the current goal");
    expect(prompts[0]).not.toContain("task_id");
  });

  test("task_id recovery without active goal does not suppress normal idle continuation", async () => {
    const sessionID = "ses_taskctx_then_continue";
    const taskCtxGate = deferred();
    const { hooks, prompts } = await makeHooks(
      [[taskMessage()], [normalAssistantMessage()]],
      [taskCtxGate.promise],
    );

    const compact = hooks.event({ event: compactedEvent(sessionID) });
    await waitFor(() => prompts.length === 1);
    expect(prompts[0]).toContain("Sidekick task_id: ses_side123");
    expect(prompts[0]).not.toContain("Continue working toward the current goal");

    await goal.createGoal(sessionID, "goal created before idle fallback");
    const idle = hooks.event({ event: idleEvent(sessionID) });
    taskCtxGate.resolve();
    await compact;
    await idle;

    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("Continue working toward the current goal");
    expect(prompts[1]).not.toContain("task_id");
  });
});
