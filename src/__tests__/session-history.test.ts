import { describe, expect, test } from "bun:test";
import {
  aroundMessages,
  normalizeSessionHistoryAround,
  normalizeSessionHistoryKinds,
  normalizeSessionHistoryLimit,
  normalizeSessionHistoryOffset,
  normalizeSessionHistoryRole,
  searchMessages,
} from "../session-history.js";

describe("searchMessages", () => {
  test("returns recent messages without filters", () => {
    const result = searchMessages([
      { id: "m1", type: "user", time: { created: 1 }, text: "first" },
      { id: "m2", type: "assistant", time: { created: 2 }, parts: [{ type: "text", text: "second" }] },
    ], { limit: 1, offset: 0, role: null, includeToolOutput: false });

    expect(result.totalMessages).toBe(2);
    expect(result.returnedMessages).toBe(1);
    expect(result.messages[0]?.id).toBe("m2");
    expect(result.messages[0]?.text).toContain("second");
  });

  test("filters by keyword and can include tool output", () => {
    const result = searchMessages([
      { id: "m1", type: "user", text: "unrelated" },
      { id: "m2", type: "assistant", parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/main.ts" }, output: "needle output" } }] },
    ], { query: "needle", limit: 10, offset: 0, role: null, includeToolOutput: true });

    expect(result.matchedMessages).toBe(1);
    expect(result.messages[0]?.text).toContain("read");
    expect(result.messages[0]?.text).toContain("needle output");
  });

  test("hides tool output unless requested", () => {
    const result = searchMessages([
      { id: "m1", type: "assistant", parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { cmd: "echo secret" }, output: "secret output" } }] },
    ], { limit: 10, offset: 0, role: null, includeToolOutput: false });

    expect(result.messages[0]?.text).toContain("bash");
    expect(result.messages[0]?.text).not.toContain("secret output");
  });

  test("filters by kind", () => {
    const result = searchMessages([
      { id: "u1", type: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "hi" }] },
      { id: "t1", type: "assistant", parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "done" } }] },
      { id: "e1", type: "assistant", parts: [{ type: "tool", tool: "bash", state: { status: "error", input: {}, error: "boom" } }] },
      { id: "r1", type: "assistant", parts: [{ type: "reasoning", text: "thinking" }] },
    ], { kind: ["tool_output", "reasoning"], limit: 10, offset: 0, role: null, includeToolOutput: false });

    expect(result.messages.map((m) => m.id)).toEqual(["t1", "r1"]);
  });

  test("filters by tool_name", () => {
    const result = searchMessages([
      { id: "b1", type: "assistant", parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }] },
      { id: "r1", type: "assistant", parts: [{ type: "tool", tool: "read", state: { status: "completed" } }] },
    ], { toolName: "read", limit: 10, offset: 0, role: null, includeToolOutput: false });

    expect(result.messages.map((m) => m.id)).toEqual(["r1"]);
    expect(result.tool_name).toBe("read");
  });

  test("filters by time range", () => {
    const result = searchMessages([
      { id: "m1", type: "user", time: { created: 100 }, text: "old" },
      { id: "m2", type: "user", time: { created: 200 }, text: "mid" },
      { id: "m3", type: "user", time: { created: 300 }, text: "new" },
      { id: "m4", type: "user", text: "unknown" },
    ], { timeAfter: 100, timeBefore: 300, limit: 10, offset: 0, role: null, includeToolOutput: false });

    expect(result.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  test("query and kind both must match", () => {
    const result = searchMessages([
      { id: "u1", type: "user", parts: [{ type: "text", text: "needle" }] },
      { id: "t1", type: "assistant", parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { q: "needle" } } }] },
    ], { query: "needle", kind: ["tool_output"], limit: 10, offset: 0, role: null, includeToolOutput: false });

    expect(result.messages.map((m) => m.id)).toEqual(["t1"]);
  });

  test("offset pages backwards in chronological order", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: `m${i + 1}`, type: "user", text: `msg ${i + 1}` }));
    const result = searchMessages(msgs, { limit: 2, offset: 2, role: null, includeToolOutput: false });
    expect(result.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  test("role=user returns only user messages", () => {
    const result = searchMessages([
      { id: "u1", type: "user", text: "hello" },
      { id: "a1", type: "assistant", parts: [{ type: "text", text: "hi" }] },
      { id: "u2", type: "user", text: "again" },
    ], { limit: 10, offset: 0, role: "user", includeToolOutput: false });

    expect(result.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
  });
});

describe("aroundMessages", () => {
  test("returns before, anchor, and after messages", () => {
    const result = aroundMessages([
      { id: "m1", type: "user", text: "one" },
      { id: "m2", type: "assistant", text: "two" },
      { id: "m3", type: "user", text: "three" },
      { id: "m4", type: "assistant", text: "four" },
    ], "m3", 1, 1, false, "ses_test");

    expect(result.anchorMessageId).toBe("m3");
    expect(result.sessionID).toBe("ses_test");
    expect(result.messages.map((m) => [m.id, m.matched])).toEqual([["m2", false], ["m3", true], ["m4", false]]);
  });

  test("returns an error when anchor is missing", () => {
    const result = aroundMessages([{ id: "m1", type: "user", text: "one" }], "missing", 1, 1, false);
    expect(result.error).toContain("Message not found");
    expect(result.messages).toEqual([]);
  });
});

describe("normalizers", () => {
  test("normalizes role", () => {
    expect(normalizeSessionHistoryRole("user")).toBe("user");
    expect(normalizeSessionHistoryRole("Assistant")).toBe("assistant");
    expect(normalizeSessionHistoryRole("system")).toBeNull();
  });

  test("normalizes kind", () => {
    expect(normalizeSessionHistoryKinds(["tool_output", "bad", "TOOL_OUTPUT"])).toEqual(["tool_output"]);
    expect(normalizeSessionHistoryKinds(undefined)).toBeNull();
  });

  test("clamps numeric inputs", () => {
    expect(normalizeSessionHistoryOffset(999)).toBe(500);
    expect(normalizeSessionHistoryLimit(999)).toBe(80);
    expect(normalizeSessionHistoryAround(999)).toBe(50);
  });
});
