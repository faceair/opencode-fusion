import { describe, expect, test } from "bun:test";
import { normalizeRecallLimit, recallMessages } from "../recall.js";

describe("recallMessages", () => {
  test("returns recent messages without a query", () => {
    const result = recallMessages([
      { id: "m1", type: "user", time: { created: 1 }, text: "first" },
      { id: "m2", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "second" }] },
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
        content: [{
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { filePath: "src/main.ts" },
            content: [{ type: "text", text: "needle output" }],
            structured: {},
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
        content: [{
          type: "tool",
          name: "bash",
          state: {
            status: "completed",
            input: { cmd: "echo secret" },
            content: [{ type: "text", text: "secret output" }],
            structured: {},
          },
        }],
      },
    ], { limit: 10, includeToolOutput: false });

    expect(result.messages[0]?.text).toContain("bash");
    expect(result.messages[0]?.text).not.toContain("secret output");
  });
});

describe("normalizeRecallLimit", () => {
  test("clamps invalid and large values", () => {
    expect(normalizeRecallLimit(undefined)).toBe(20);
    expect(normalizeRecallLimit(0)).toBe(1);
    expect(normalizeRecallLimit(999)).toBe(80);
  });
});
