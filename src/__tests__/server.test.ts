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

function taskMessage(subagentType: "sidekick" | "reviewer" = "sidekick", taskID = "ses_side123"): RecallMessage {
  return {
    type: "assistant",
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {
            subagent_type: subagentType,
            description: subagentType === "sidekick" ? "sidekick work" : "reviewer review",
            prompt: subagentType === "sidekick" ? "do work" : "review work",
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

async function makeHooksWithMessageError(error: Error) {
  const logs: unknown[] = [];
  const client = {
    session: {
      messages: async () => {
        throw error;
      },
      promptAsync: async () => {},
    },
    app: {
      log: async (input: unknown) => {
        logs.push(input);
      },
    },
  };
  const hooks = await plugin.server({ client } as any, undefined);
  return { hooks: hooks as any, logs };
}

function idleEvent(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } };
}

describe("server compaction hooks", () => {
  test("get_task_ids returns extracted sidekick and reviewer task_ids", async () => {
    const { hooks } = await makeHooks([
      [taskMessage("sidekick", "ses_side123"), taskMessage("reviewer", "ses_rev123")],
    ]);

    const output = JSON.parse(await hooks.tool.get_task_ids.execute({}, { sessionID: "ses_tasks" }));

    expect(output).toEqual({
      sidekick: [{ task_id: "ses_side123", description: "sidekick work" }],
      reviewer: [{ task_id: "ses_rev123", description: "reviewer review" }],
    });
  });

  test("get_task_ids returns nulls without task calls", async () => {
    const { hooks } = await makeHooks([[normalAssistantMessage()]]);

    const output = JSON.parse(await hooks.tool.get_task_ids.execute({}, { sessionID: "ses_no_tasks" }));

    expect(output).toEqual({});
  });

  test("experimental.session.compacting injects sidekick and reviewer task_id context", async () => {
    const { hooks, prompts } = await makeHooks([
      [taskMessage("sidekick", "ses_side123"), taskMessage("reviewer", "ses_rev123")],
    ]);
    const output = { context: [] as string[] };

    await hooks["experimental.session.compacting"]({ sessionID: "ses_compact" }, output);

    expect(prompts.length).toBe(0);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain("Subagent task_ids — preserve in summary");
    expect(output.context[0]).toContain('Sidekick task_id: ses_side123 (last dispatch: "sidekick work")');
    expect(output.context[0]).toContain('Reviewer task_id: ses_rev123 (last dispatch: "reviewer review")');
    expect(output.context[0]).toContain('"## Critical Context"');
  });

  test("experimental.session.compacting leaves context empty without task_ids", async () => {
    const { hooks } = await makeHooks([[normalAssistantMessage()]]);
    const output = { context: [] as string[] };

    await hooks["experimental.session.compacting"]({ sessionID: "ses_no_tasks" }, output);

    expect(output.context).toEqual([]);
  });

  test("experimental.session.compacting logs and leaves context unchanged when messages fail", async () => {
    const { hooks, logs } = await makeHooksWithMessageError(new Error("messages failed"));
    const output = { context: ["existing context"] as string[] };

    await expect(hooks["experimental.session.compacting"]({ sessionID: "ses_fail" }, output)).resolves.toBeUndefined();

    expect(output.context).toEqual(["existing context"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      body: {
        service: "opencode-fusion",
        level: "error",
        message: "Compaction task_id injection failed",
        extra: { error: "messages failed" },
      },
    });
  });

  test("idle auto-continue still sends goal continuation after compaction", async () => {
    const sessionID = "ses_idle_after_compact";
    await goal.createGoal(sessionID, "idle after compact goal");
    const { hooks, prompts } = await makeHooks([[normalAssistantMessage()]]);

    await hooks.event({ event: idleEvent(sessionID) });

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Continue working toward the current goal");
    expect(prompts[0]).toContain("idle after compact goal");
    expect(prompts[0]).not.toContain("task_id");
  });
});
