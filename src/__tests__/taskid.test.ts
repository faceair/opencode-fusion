import { describe, expect, it } from "bun:test";
import { extractSidekickTaskId, extractReviewerTaskId } from "../taskid.js";
import type { RecallMessage } from "../recall.js";

function toolPart(name: string, input: unknown, output: unknown): unknown {
  return {
    type: "tool",
    tool: name,
    state: { status: "completed", input, output: typeof output === "string" ? output : JSON.stringify(output) },
  };
}

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

function msg(parts: unknown[]): RecallMessage {
  return { id: `msg-${Math.random()}`, type: "assistant", parts } as RecallMessage;
}

describe("extractSidekickTaskId", () => {
  it("extracts task_id from sidekick task output", () => {
    const messages = [
      msg([
        toolPart("task", { subagent_type: "sidekick", prompt: "do work" }, {
          task_id: "tsk_abc",
          output: "done",
        }),
      ]),
    ];
    const info = extractSidekickTaskId(messages);
    expect(info?.task_id).toBe("tsk_abc");
    expect(info?.description).toBeNull();
  });

  it("extracts task_id from follow-up input when output lacks it", () => {
    const messages = [
      msg([
        toolPart(
          "task",
          { subagent_type: "sidekick", task_id: "tsk_followup", prompt: "next step" },
          "ok",
        ),
      ]),
    ];
    const info = extractSidekickTaskId(messages);
    expect(info?.task_id).toBe("tsk_followup");
    expect(info?.description).toBeNull();
  });

  it("skips reviewer task calls", () => {
    const messages = [
      msg([
        toolPart("task", { subagent_type: "reviewer", prompt: "review" }, {
          task_id: "tsk_review",
        }),
      ]),
    ];
    expect(extractSidekickTaskId(messages)).toBeNull();
  });

  it("returns the latest sidekick task_id when multiple exist", () => {
    const messages = [
      msg([toolPart("task", { subagent_type: "sidekick", prompt: "first" }, { task_id: "tsk_old" })]),
      msg([toolPart("task", { subagent_type: "sidekick", prompt: "second" }, { task_id: "tsk_new" })]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("tsk_new");
  });

  it("returns null when no task calls exist", () => {
    const messages = [msg([{ type: "text", text: "hello" }])];
    expect(extractSidekickTaskId(messages)).toBeNull();
  });

  it("parses JSON string output containing task_id", () => {
    const messages = [
      msg([
        toolPart(
          "task",
          { subagent_type: "sidekick", prompt: "work" },
          '{"task_id": "tsk_json", "result": "ok"}',
        ),
      ]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("tsk_json");
  });

  it("skips non-task tool calls", () => {
    const messages = [
      msg([toolPart("recall_history", { query: "foo" }, '{"messages": []}')]),
    ];
    expect(extractSidekickTaskId(messages)).toBeNull();
  });

  it("handles task_id nested one level in output wrapper", () => {
    const messages = [
      msg([
        toolPart(
          "task",
          { subagent_type: "sidekick", prompt: "x" },
          { data: { task_id: "tsk_nested" } },
        ),
      ]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("tsk_nested");
  });

  it("returns null for empty messages", () => {
    expect(extractSidekickTaskId([])).toBeNull();
  });

  it("extracts task_id from real OpenCode ToolPart shape (state.output JSON string)", () => {
    const messages = [
      msg([
        realToolPart("task", { subagent_type: "sidekick", description: "sidekick work", prompt: "do work" }, {
          task_id: "tsk_real",
          output: "done",
        }),
      ]),
    ];
    const info = extractSidekickTaskId(messages);
    expect(info?.task_id).toBe("tsk_real");
    expect(info?.description).toBe("sidekick work");
  });

  it("extracts task_id from real shape with nested data wrapper", () => {
    const messages = [
      msg([
        realToolPart(
          "task",
          { subagent_type: "sidekick", prompt: "x" },
          { data: { task_id: "tsk_real_nested" } },
        ),
      ]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("tsk_real_nested");
  });

  it("returns latest task_id across real-shape sidekick calls", () => {
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", prompt: "first" }, { task_id: "tsk_real_old" })]),
      msg([realToolPart("task", { subagent_type: "sidekick", prompt: "second" }, { task_id: "tsk_real_new" })]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("tsk_real_new");
  });

  it("extracts task_id from real task tool XML output (<task id=\"ses_xxx\">)", () => {
    const xmlOutput = `<task id="ses_abc123" state="completed">\n<task_result>\nDone working\n</task_result>\n</task>`;
    const messages = [
      msg([
        realToolPart("task", { subagent_type: "sidekick", description: "sidekick xml", prompt: "do work" }, xmlOutput),
      ]),
    ];
    const info = extractSidekickTaskId(messages);
    expect(info?.task_id).toBe("ses_abc123");
    expect(info?.description).toBe("sidekick xml");
  });

  it("extracts latest task_id from multiple real XML outputs", () => {
    const xml1 = `<task id="ses_first" state="completed">\n<task_result>\nfirst\n</task_result>\n</task>`;
    const xml2 = `<task id="ses_second" state="completed">\n<task_result>\nsecond\n</task_result>\n</task>`;
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", prompt: "first" }, xml1)]),
      msg([realToolPart("task", { subagent_type: "sidekick", prompt: "second" }, xml2)]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("ses_second");
  });

  it("extracts task_id from XML output even when follow-up input also has task_id", () => {
    const xmlOutput = `<task id="ses_from_xml" state="completed">\n<task_result>\nresult\n</task_result>\n</task>`;
    const messages = [
      msg([
        realToolPart(
          "task",
          { subagent_type: "sidekick", task_id: "ses_from_input", prompt: "next" },
          xmlOutput,
        ),
      ]),
    ];
    // Output takes precedence (latest completed result)
    expect(extractSidekickTaskId(messages)?.task_id).toBe("ses_from_xml");
  });
});

describe("extractReviewerTaskId", () => {
  it("extracts task_id from reviewer task output", () => {
    const messages = [
      msg([
        toolPart("task", { subagent_type: "reviewer", prompt: "review" }, {
          task_id: "tsk_review",
        }),
      ]),
    ];
    const info = extractReviewerTaskId(messages);
    expect(info?.task_id).toBe("tsk_review");
    expect(info?.description).toBeNull();
  });

  it("skips sidekick task calls", () => {
    const messages = [
      msg([
        toolPart("task", { subagent_type: "sidekick", prompt: "work" }, {
          task_id: "tsk_side",
        }),
      ]),
    ];
    expect(extractReviewerTaskId(messages)).toBeNull();
  });

  it("extracts task_id from real task tool XML output", () => {
    const xmlOutput = `<task id="ses_rev123" state="completed">\n<task_result>\nreview done\n</task_result>\n</task>`;
    const messages = [
      msg([
        realToolPart("task", { subagent_type: "reviewer", description: "reviewer review", prompt: "review this" }, xmlOutput),
      ]),
    ];
    const info = extractReviewerTaskId(messages);
    expect(info?.task_id).toBe("ses_rev123");
    expect(info?.description).toBe("reviewer review");
  });

  it("returns latest reviewer task_id when multiple exist", () => {
    const xml1 = `<task id="ses_rev_old" state="completed">\n<task_result>\nfirst\n</task_result>\n</task>`;
    const xml2 = `<task id="ses_rev_new" state="completed">\n<task_result>\nsecond\n</task_result>\n</task>`;
    const messages = [
      msg([realToolPart("task", { subagent_type: "reviewer", prompt: "first" }, xml1)]),
      msg([realToolPart("task", { subagent_type: "reviewer", prompt: "second" }, xml2)]),
    ];
    expect(extractReviewerTaskId(messages)?.task_id).toBe("ses_rev_new");
  });

  it("extracts reviewer task_id from follow-up input when output lacks it", () => {
    const messages = [
      msg([
        toolPart(
          "task",
          { subagent_type: "reviewer", task_id: "tsk_rev_followup", prompt: "next review" },
          "ok",
        ),
      ]),
    ];
    const info = extractReviewerTaskId(messages);
    expect(info?.task_id).toBe("tsk_rev_followup");
    expect(info?.description).toBeNull();
  });

  it("returns null when no reviewer task calls exist", () => {
    const messages = [msg([{ type: "text", text: "hello" }])];
    expect(extractReviewerTaskId(messages)).toBeNull();
  });

  it("independently extracts sidekick and reviewer task_ids from mixed messages", () => {
    const sideXml = `<task id="ses_side_mixed" state="completed">\n<task_result>\nside\n</task_result>\n</task>`;
    const revXml = `<task id="ses_rev_mixed" state="completed">\n<task_result>\nrev\n</task_result>\n</task>`;
    const messages = [
      msg([realToolPart("task", { subagent_type: "sidekick", prompt: "work" }, sideXml)]),
      msg([realToolPart("task", { subagent_type: "reviewer", prompt: "review" }, revXml)]),
    ];
    expect(extractSidekickTaskId(messages)?.task_id).toBe("ses_side_mixed");
    expect(extractReviewerTaskId(messages)?.task_id).toBe("ses_rev_mixed");
  });
});
