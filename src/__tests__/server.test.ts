import { describe, expect, test } from "bun:test";

import plugin from "../server.js";
import type { SessionMessage } from "../session-history.js";

function taskMessage(subagentType: "sidekick" | "scout" = "sidekick", taskID = "ses_side123"): SessionMessage {
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
            description: subagentType === "sidekick" ? "sidekick work" : "scout work",
            prompt: subagentType === "sidekick" ? "do work" : "scout work",
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
) {
  const client = {
    session: {
      messages: async () => ({ data: await messages[0] }),
    },
  };
  const hooks = await plugin.server({ client } as any, undefined);
  return { hooks: hooks as any };
}

describe("server tools", () => {
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

  test("get_task_ids returns extracted task_ids grouped by subagent type", async () => {
    const { hooks } = await makeHooks([
      [taskMessage("sidekick", "ses_side123"), taskMessage("scout", "ses_scout123")],
    ]);

    const output = JSON.parse(await hooks.tool.get_task_ids.execute({}, { sessionID: "ses_tasks" }));

    expect(output).toEqual({
      sidekick: [{ task_id: "ses_side123", description: "sidekick work", last_used_at: 0 }],
      scout: [{ task_id: "ses_scout123", description: "scout work", last_used_at: 0 }],
    });
  });

  test("get_task_ids returns empty object without task calls", async () => {
    const { hooks } = await makeHooks([[normalAssistantMessage()]]);

    const output = JSON.parse(await hooks.tool.get_task_ids.execute({}, { sessionID: "ses_no_tasks" }));

    expect(output).toEqual({});
  });
});
