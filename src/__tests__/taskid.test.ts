import { describe, expect, it } from "bun:test";
import { extractAllTaskIds } from "../taskid.js";
import type { SessionMessage } from "../session-history.js";

// Mirrors the real OpenCode ToolPart/ToolStateCompleted shape from
// @opencode-ai/sdk types.gen.d.ts: state.output is a JSON string.
function realToolPart(name: string, input: unknown, output: unknown): unknown {
  return {
    id: `part-${Math.random()}`,
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: name,
    state: {
      status: "completed",
      input,
      output: typeof output === "string" ? output : JSON.stringify(output),
      title: name,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function msg(parts: unknown[]): SessionMessage {
  return { id: `msg-${Math.random()}`, type: "assistant", parts } as SessionMessage;
}

describe("extractAllTaskIds", () => {
  it("collects all sidekick and reviewer entries grouped by type, newest-first, with descriptions", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "old sidekick", prompt: "first" }, `<task id="ses_side_old" state="completed">old</task>`)]),
      msg([realToolPart("task", { subagent_type: "reviewer", description: "reviewer review", prompt: "review" }, `<task id="ses_rev" state="completed">rev</task>`)]),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "new sidekick", prompt: "second" }, `<task id="ses_side_new" state="completed">new</task>`)]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [
        { task_id: "ses_side_new", description: "new sidekick" },
        { task_id: "ses_side_old", description: "old sidekick" },
      ],
      reviewer: [{ task_id: "ses_rev", description: "reviewer review" }],
    });
  });

  it("handles mixed types in the same message list", () => {
    const messages = [
      msg([
        realToolPart("task", { subagent_type: "sidekick", description: "side", prompt: "work" }, `<task id="ses_side" state="completed">side</task>`),
        realToolPart("task", { subagent_type: "reviewer", description: "review", prompt: "review" }, `<task id="ses_review" state="completed">review</task>`),
      ]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      reviewer: [{ task_id: "ses_review", description: "review" }],
      sidekick: [{ task_id: "ses_side", description: "side" }],
    });
  });

  it("returns an empty object for empty messages", () => {
    expect(extractAllTaskIds([])).toEqual({});
  });

  it("handles real-shape ToolPart state.output JSON string and XML output", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "json output", prompt: "work" }, { task_id: "ses_json" })]),
      msg([realToolPart("task", { subagent_type: "reviewer", description: "xml output", prompt: "review" }, `<task id="ses_xml" state="completed">xml</task>`)]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      reviewer: [{ task_id: "ses_xml", description: "xml output" }],
      sidekick: [{ task_id: "ses_json", description: "json output" }],
    });
  });

  it("skips non-task tool calls", () => {
    const messages = [
      msg([realToolPart("session_history", { subagent_type: "sidekick", description: "not task" }, { task_id: "ses_skip" })]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({});
  });
});
