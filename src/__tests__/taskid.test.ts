import { describe, expect, it } from "bun:test";
import { extractAllTaskIds } from "../taskid.js";
import type { SessionMessage } from "../session-history.js";

// Mirrors the real OpenCode ToolPart/ToolStateCompleted shape from
// @opencode-ai/sdk types.gen.d.ts: state.output is a JSON string.
function realToolPart(
  name: string,
  input: unknown,
  output: unknown,
  time: { start?: number; end?: number } | null = { start: 0, end: 1 },
): unknown {
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
      time,
    },
  };
}

function msg(parts: unknown[], created = 0): SessionMessage {
  return { id: `msg-${Math.random()}`, type: "assistant", time: { created }, parts } as SessionMessage;
}

describe("extractAllTaskIds", () => {
  it("collects all sidekick and scout entries grouped by type, newest-first, with descriptions", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "old sidekick", prompt: "first" }, `<task id="ses_side_old" state="completed">old</task>`, { start: 100, end: 110 })]),
      msg([realToolPart("task", { subagent_type: "scout", description: "scout work", prompt: "scout" }, `<task id="ses_scout" state="completed">scout</task>`, { start: 200, end: 210 })]),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "new sidekick", prompt: "second" }, `<task id="ses_side_new" state="completed">new</task>`, { start: 300, end: 310 })]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [
        { task_id: "ses_side_new", description: "new sidekick", last_used_at: 310 },
        { task_id: "ses_side_old", description: "old sidekick", last_used_at: 110 },
      ],
      scout: [{ task_id: "ses_scout", description: "scout work", last_used_at: 210 }],
    });
  });

  it("handles mixed types in the same message list", () => {
    const messages = [
      msg([
        realToolPart("task", { subagent_type: "sidekick", description: "side", prompt: "work" }, `<task id="ses_side" state="completed">side</task>`, { start: 10, end: 20 }),
        realToolPart("task", { subagent_type: "scout", description: "scout", prompt: "scout" }, `<task id="ses_scout" state="completed">scout</task>`, { start: 30, end: 40 }),
      ]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [{ task_id: "ses_side", description: "side", last_used_at: 20 }],
      scout: [{ task_id: "ses_scout", description: "scout", last_used_at: 40 }],
    });
  });

  it("returns an empty object for empty messages", () => {
    expect(extractAllTaskIds([])).toEqual({});
  });

  it("handles real-shape ToolPart state.output JSON string and XML output", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "json output", prompt: "work" }, { task_id: "ses_json" }, { start: 50, end: 60 })]),
      msg([realToolPart("task", { subagent_type: "scout", description: "xml output", prompt: "scout" }, `<task id="ses_xml" state="completed">xml</task>`, { start: 70, end: 80 })]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [{ task_id: "ses_json", description: "json output", last_used_at: 60 }],
      scout: [{ task_id: "ses_xml", description: "xml output", last_used_at: 80 }],
    });
  });

  it("deduplicates repeated task_id entries and keeps the latest last_used_at", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "initial run", prompt: "work" }, `<task id="ses_repeat" state="completed">old</task>`, { start: 100, end: 110 })]),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "resumed run", prompt: "resume" }, `<task id="ses_repeat" state="completed">new</task>`, { start: 400, end: 410 })]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [{ task_id: "ses_repeat", description: "resumed run", last_used_at: 410 }],
    });
  });

  it("sorts each group by last_used_at descending instead of message order", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "newest timestamp first", prompt: "work" }, `<task id="ses_newest" state="completed">newest</task>`, { start: 900, end: 910 })]),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "oldest timestamp second", prompt: "work" }, `<task id="ses_oldest" state="completed">oldest</task>`, { start: 100, end: 110 })]),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "middle timestamp last", prompt: "work" }, `<task id="ses_middle" state="completed">middle</task>`, { start: 500, end: 510 })]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [
        { task_id: "ses_newest", description: "newest timestamp first", last_used_at: 910 },
        { task_id: "ses_middle", description: "middle timestamp last", last_used_at: 510 },
        { task_id: "ses_oldest", description: "oldest timestamp second", last_used_at: 110 },
      ],
    });
  });

  it("uses state.time.end, then state.time.start, then message time.created for last_used_at", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", description: "end wins", prompt: "work" }, `<task id="ses_end" state="completed">end</task>`, { start: 100, end: 200 })], 1000),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "start fallback", prompt: "work" }, `<task id="ses_start" state="completed">start</task>`, { start: 300 })], 2000),
      msg([realToolPart("task", { subagent_type: "sidekick", description: "message fallback", prompt: "work" }, `<task id="ses_message" state="completed">message</task>`, null)], 400),
    ];

    expect(extractAllTaskIds(messages)).toEqual({
      sidekick: [
        { task_id: "ses_message", description: "message fallback", last_used_at: 400 },
        { task_id: "ses_start", description: "start fallback", last_used_at: 300 },
        { task_id: "ses_end", description: "end wins", last_used_at: 200 },
      ],
    });
  });

  it("skips non-task tool calls", () => {
    const messages = [
      msg([realToolPart("session_history", { subagent_type: "sidekick", description: "not task" }, { task_id: "ses_skip" })]),
    ];

    expect(extractAllTaskIds(messages)).toEqual({});
  });
});
