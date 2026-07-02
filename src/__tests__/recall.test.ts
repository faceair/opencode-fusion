import { describe, expect, test } from "bun:test";
import { normalizeRecallLimit, normalizeRecallOffset, normalizeRecallRole, recallMessages } from "../recall.js";

describe("recallMessages", () => {
  test("returns recent messages without a query", () => {
    const result = recallMessages([
      { id: "m1", type: "user", time: { created: 1 }, text: "first" },
      { id: "m2", type: "assistant", time: { created: 2 }, parts: [{ type: "text", text: "second" }] },
    ], { limit: 1, offset: 0, role: null, includeToolOutput: false });

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
    ], { query: "needle", limit: 10, offset: 0, role: null, includeToolOutput: true });

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
    ], { limit: 10, offset: 0, role: null, includeToolOutput: false });

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
    ], { query: "needle", limit: 10, offset: 0, role: null, includeToolOutput: true });

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
    ], { limit: 10, offset: 0, role: null, includeToolOutput: false });

    expect(result.messages[0]?.text).toContain("task");
    expect(result.messages[0]?.text).not.toContain("tsk_hidden");
    expect(result.messages[0]?.text).not.toContain("secret result");
  });

  test("offset=0 reproduces prior tail behavior (last N messages)", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i + 1}`,
      type: "user",
      time: { created: i + 1 },
      text: `msg ${i + 1}`,
    }));
    const result = recallMessages(msgs, { limit: 2, offset: 0, role: null, includeToolOutput: false });
    expect(result.returnedMessages).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
    expect(result.offset).toBe(0);
  });

  test("offset pages backwards in chronological order", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i + 1}`,
      type: "user",
      time: { created: i + 1 },
      text: `msg ${i + 1}`,
    }));
    // Skip the 2 most recent (m4, m5), take the 2 before (m2, m3).
    const result = recallMessages(msgs, { limit: 2, offset: 2, role: null, includeToolOutput: false });
    expect(result.returnedMessages).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(result.offset).toBe(2);
  });

  test("offset beyond available range returns empty messages without error", () => {
    const msgs = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i + 1}`,
      type: "user",
      text: `msg ${i + 1}`,
    }));
    const result = recallMessages(msgs, { limit: 10, offset: 100, role: null, includeToolOutput: false });
    expect(result.returnedMessages).toBe(0);
    expect(result.matchedMessages).toBe(3);
    expect(result.messages).toEqual([]);
  });

  test("offset works with keyword filter (pages back over matched set)", () => {
    // 6 messages: 3 contain "keep", 3 do not, interleaved.
    const msgs = [
      { id: "k1", type: "user", text: "keep A" },
      { id: "x1", type: "user", text: "skip" },
      { id: "k2", type: "user", text: "keep B" },
      { id: "x2", type: "user", text: "skip" },
      { id: "k3", type: "user", text: "keep C" },
      { id: "x3", type: "user", text: "skip" },
    ];
    // Matched (chronological): k1, k2, k3. offset=1 skips k3, returns k1..k2.
    const result = recallMessages(msgs, { query: "keep", limit: 10, offset: 1, role: null, includeToolOutput: false });
    expect(result.matchedMessages).toBe(3);
    expect(result.returnedMessages).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["k1", "k2"]);
  });

  test("role=user returns only user messages", () => {
    const msgs = [
      { id: "u1", type: "user", text: "hello" },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "hi" }] },
      { id: "u2", type: "user", text: "again" },
      { id: "a2", type: "assistant", parts: [{ type: "text", text: "bye" }] },
    ];
    const result = recallMessages(msgs, { limit: 10, offset: 0, role: "user", includeToolOutput: false });
    expect(result.matchedMessages).toBe(2);
    expect(result.returnedMessages).toBe(2);
    expect(result.role).toBe("user");
    expect(result.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(result.messages.every((m) => m.role === "user")).toBe(true);
  });

  test("role=assistant returns only assistant messages", () => {
    const msgs = [
      { id: "u1", type: "user", text: "hello" },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "hi" }] },
      { id: "u2", type: "user", text: "again" },
    ];
    const result = recallMessages(msgs, { limit: 10, offset: 0, role: "assistant", includeToolOutput: false });
    expect(result.matchedMessages).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual(["a1"]);
  });

  test("role+query both must match", () => {
    const msgs = [
      { id: "u1", type: "user", text: "find me" },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "find me too" }] },
      { id: "u2", type: "user", text: "find me as well" },
    ];
    // role=user AND query="find" → only u1, u2.
    const result = recallMessages(msgs, { query: "find", limit: 10, offset: 0, role: "user", includeToolOutput: false });
    expect(result.matchedMessages).toBe(2);
    expect(result.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  test("role+offset pages backwards over role-matched set", () => {
    const msgs = [
      { id: "u1", type: "user", text: "msg 1" },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "resp 1" }] },
      { id: "u2", type: "user", text: "msg 2" },
      { id: "a2", type: "assistant", parts: [{ type: "text", text: "resp 2" }] },
      { id: "u3", type: "user", text: "msg 3" },
    ];
    // role=user matched: u1, u2, u3. offset=1 skips u3, limit=1 returns u2.
    const result = recallMessages(msgs, { limit: 1, offset: 1, role: "user", includeToolOutput: false });
    expect(result.matchedMessages).toBe(3);
    expect(result.returnedMessages).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual(["u2"]);
  });

  test("role=null applies no role filter (preserves prior behavior)", () => {
    const msgs = [
      { id: "u1", type: "user", text: "a" },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "b" }] },
    ];
    const result = recallMessages(msgs, { limit: 10, offset: 0, role: null, includeToolOutput: false });
    expect(result.matchedMessages).toBe(2);
    expect(result.role).toBeNull();
  });

  test("role matches compaction message type", () => {
    const msgs = [
      { id: "u1", type: "user", text: "before" },
      { id: "c1", type: "compaction", summary: "compacted", recent: "kept" },
      { id: "u2", type: "user", text: "after" },
    ];
    const result = recallMessages(msgs, { limit: 10, offset: 0, role: "compaction", includeToolOutput: false });
    expect(result.matchedMessages).toBe(1);
    expect(result.messages[0]?.id).toBe("c1");
    expect(result.messages[0]?.text).toContain("Compaction summary");
  });
});

describe("normalizeRecallRole", () => {
  test("returns known roles lowercased", () => {
    expect(normalizeRecallRole("user")).toBe("user");
    expect(normalizeRecallRole("USER")).toBe("user");
    expect(normalizeRecallRole("Assistant")).toBe("assistant");
    expect(normalizeRecallRole("compaction")).toBe("compaction");
    expect(normalizeRecallRole("agent-switched")).toBe("agent-switched");
  });

  test("returns null for unknown, empty, or non-string values", () => {
    expect(normalizeRecallRole(undefined)).toBeNull();
    expect(normalizeRecallRole(null)).toBeNull();
    expect(normalizeRecallRole("")).toBeNull();
    expect(normalizeRecallRole("   ")).toBeNull();
    expect(normalizeRecallRole("unknown")).toBeNull();
    expect(normalizeRecallRole("admin")).toBeNull();
  });
});

describe("normalizeRecallOffset", () => {
  test("clamps invalid, negative, and large values", () => {
    expect(normalizeRecallOffset(undefined)).toBe(0);
    expect(normalizeRecallOffset(0)).toBe(0);
    expect(normalizeRecallOffset(-5)).toBe(0);
    expect(normalizeRecallOffset(999)).toBe(500);
    expect(normalizeRecallOffset(NaN)).toBe(0);
  });
});

describe("normalizeRecallLimit", () => {
  test("clamps invalid and large values", () => {
    expect(normalizeRecallLimit(undefined)).toBe(20);
    expect(normalizeRecallLimit(0)).toBe(1);
    expect(normalizeRecallLimit(999)).toBe(80);
  });
});
