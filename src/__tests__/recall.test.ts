import { describe, expect, test } from "bun:test";
import { normalizeRecallLimit, recallMessages } from "../recall.js";

describe("recallMessages", () => {
  test("returns recent messages without a query", () => {
    const result = recallMessages([
      { id: "m1", type: "user", time: { created: 1 }, text: "first" },
      { id: "m2", type: "assistant", time: { created: 2 }, parts: [{ type: "text", text: "second" }] },
    ], { limit: 1, includeToolOutput: false });

    expect(result.totalMessages).toBe(2);
    expect(result.returnedMessages).toBe(1);
    expect(result.messages[0]?.id).toBe("m2");
    expect(result.messages[0]?.text).toContain("second");
  });

  test("filters by keyword and can include tool output", () => {
    const result = recallMessages([
      { id: "m1", type: "user", text: "unrelated" },
      {
        id: "m2",
        type: "assistant",
        parts: [{
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "src/main.ts" },
            output: "needle output",
          },
        }],
      },
    ], { query: "needle", limit: 10, includeToolOutput: true });

    expect(result.matchedMessages).toBe(1);
    expect(result.messages[0]?.text).toContain("read");
    expect(result.messages[0]?.text).toContain("needle output");
  });

  test("hides tool output unless requested", () => {
    const result = recallMessages([
      {
        id: "m1",
        type: "assistant",
        parts: [{
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { cmd: "echo secret" },
            output: "secret output",
          },
        }],
      },
    ], { limit: 10, includeToolOutput: false });

    expect(result.messages[0]?.text).toContain("bash");
    expect(result.messages[0]?.text).not.toContain("secret output");
  });

  // Mirrors the real OpenCode ToolPart/ToolStateCompleted shape from
  // @opencode-ai/sdk types.gen.d.ts: tool field is `tool`, output lives
  // under `state.output` as a JSON string (no `state.content`).
  test("includes real-shape state.output when includeToolOutput is true", () => {
    const result = recallMessages([
      { id: "m1", type: "user", text: "unrelated" },
      {
        id: "m2",
        type: "assistant",
        parts: [{
          id: "part-1",
          sessionID: "sess-1",
          messageID: "m2",
          type: "tool",
          callID: "call-1",
          tool: "task",
          state: {
            status: "completed",
            input: { subagent_type: "sidekick", prompt: "do work" },
            output: JSON.stringify({ task_id: "tsk_recall", output: "needle result" }),
            title: "task",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        }],
      },
    ], { query: "needle", limit: 10, includeToolOutput: true });

    expect(result.matchedMessages).toBe(1);
    expect(result.messages[0]?.text).toContain("task");
    expect(result.messages[0]?.text).toContain("tsk_recall");
    expect(result.messages[0]?.text).toContain("needle result");
  });

  test("hides real-shape state.output when includeToolOutput is false", () => {
    const result = recallMessages([
      {
        id: "m1",
        type: "assistant",
        parts: [{
          id: "part-1",
          sessionID: "sess-1",
          messageID: "m1",
          type: "tool",
          callID: "call-1",
          tool: "task",
          state: {
            status: "completed",
            input: { subagent_type: "sidekick", prompt: "x" },
            output: JSON.stringify({ task_id: "tsk_hidden", output: "secret result" }),
            title: "task",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        }],
      },
    ], { limit: 10, includeToolOutput: false });

    expect(result.messages[0]?.text).toContain("task");
    expect(result.messages[0]?.text).not.toContain("tsk_hidden");
    expect(result.messages[0]?.text).not.toContain("secret result");
  });
});

describe("normalizeRecallLimit", () => {
  test("clamps invalid and large values", () => {
    expect(normalizeRecallLimit(undefined)).toBe(20);
    expect(normalizeRecallLimit(0)).toBe(1);
    expect(normalizeRecallLimit(999)).toBe(80);
  });
});
