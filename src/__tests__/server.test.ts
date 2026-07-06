import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../server.js";
import * as goal from "../goal.js";
import type { SessionMessage } from "../session-history.js";

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

function taskMessage(subagentType: "sidekick" | "reviewer" = "sidekick", taskID = "ses_side123"): SessionMessage {
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
  } as SessionMessage;
}

function normalAssistantMessage(): SessionMessage {
  return {
    type: "assistant",
    finish: "stop",
    parts: [{ type: "text", text: "done" }],
    time: { created: Date.now() },
  } as SessionMessage;
}

async function makeHooks(
  messages: Array<SessionMessage[] | Promise<SessionMessage[]>>,
  promptWaits: Array<Promise<unknown>> = [],
) {
  const prompts: string[] = [];
  const logs: unknown[] = [];
  const client = {
    session: {
      messages: async () => ({ data: await messages[0] }),
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

function idleEvent(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } };
}

describe("server compaction hooks", () => {
  test("session_history search returns filtered messages", async () => {
    const { hooks } = await makeHooks([[
      { id: "u1", type: "user", text: "hello" } as SessionMessage,
      { id: "a1", type: "assistant", parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { cmd: "echo needle" }, output: "needle output" } }] } as SessionMessage,
    ]]);

    const output = JSON.parse(await hooks.tool.session_history.execute({ operation: "search", query: "needle", kind: ["tool_output"], include_tool_output: true }, { sessionID: "ses_history" }));

    expect(output.matchedMessages).toBe(1);
    expect(output.messages[0].id).toBe("a1");
    expect(output.messages[0].text).toContain("needle output");
  });

  test("session_history around returns anchor context", async () => {
    const { hooks } = await makeHooks([[
      { id: "m1", type: "user", text: "one" } as SessionMessage,
      { id: "m2", type: "assistant", text: "two" } as SessionMessage,
      { id: "m3", type: "user", text: "three" } as SessionMessage,
    ]]);

    const output = JSON.parse(await hooks.tool.session_history.execute({ operation: "around", message_id: "m2", before: 1, after: 1 }, { sessionID: "ses_history" }));

    expect(output.anchorMessageId).toBe("m2");
    expect(output.messages.map((m: any) => [m.id, m.matched])).toEqual([["m1", false], ["m2", true], ["m3", false]]);
  });

  test("get_task_ids returns extracted sidekick and reviewer task_ids", async () => {
    const { hooks } = await makeHooks([
      [taskMessage("sidekick", "ses_side123"), taskMessage("reviewer", "ses_rev123")],
    ]);

    const output = JSON.parse(await hooks.tool.get_task_ids.execute({}, { sessionID: "ses_tasks" }));

    expect(output).toEqual({
      sidekick: [{ task_id: "ses_side123", description: "sidekick work", last_used_at: 0 }],
      reviewer: [{ task_id: "ses_rev123", description: "reviewer review", last_used_at: 0 }],
    });
  });

  test("get_task_ids returns empty object without task calls", async () => {
    const { hooks } = await makeHooks([[normalAssistantMessage()]]);

    const output = JSON.parse(await hooks.tool.get_task_ids.execute({}, { sessionID: "ses_no_tasks" }));

    expect(output).toEqual({});
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

  test("auto-continue stops after max react cap", async () => {
    const sessionID = "ses_max_react";
    await goal.createGoal(sessionID, "goal that never completes");
    const { hooks, prompts, logs } = await makeHooks([[normalAssistantMessage()]]);

    for (let i = 0; i < goal.MAX_GOAL_REACT; i++) {
      await hooks.event({ event: idleEvent(sessionID) });
    }
    await hooks.event({ event: idleEvent(sessionID) });

    expect(prompts.length).toBe(goal.MAX_GOAL_REACT);
    const g = await goal.getGoal(sessionID);
    expect(g?.status).toBe("unmet");
    expect((logs as any[]).filter((l) => (l as any)?.body?.level === "warn" && (l as any)?.body?.message?.includes("max react cap")).length).toBe(1);
  });
});
