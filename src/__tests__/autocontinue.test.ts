import { describe, expect, test } from "bun:test";
import {
  isInterruptedAssistantMessage,
  shouldSkipAutoContinueForMessages,
} from "../autocontinue.js";

describe("isInterruptedAssistantMessage", () => {
  test("matches OpenCode Esc interruptions on the assistant message", () => {
    expect(isInterruptedAssistantMessage({
      info: {
        role: "assistant",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
      parts: [{ type: "step-start" }],
    })).toBe(true);
  });

  test("matches interrupted tool parts produced during abort cleanup", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "assistant" },
      parts: [{
        type: "tool",
        tool: "task",
        state: {
          status: "error",
          error: "Tool execution aborted",
          metadata: { interrupted: true },
        },
      }],
    })).toBe(true);
  });

  test("does not treat normal assistant errors as user interrupts", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "assistant", finish: "error" },
      parts: [{
        type: "tool",
        state: { status: "error", error: "Command failed" },
      }],
    })).toBe(false);
  });

  test("does not treat user messages mentioning interrupts as interruptions", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "user" },
      parts: [{ type: "text", text: "是识别用户的 interrupted 行为" }],
    })).toBe(false);
  });
});

describe("shouldSkipAutoContinueForMessages", () => {
  test("skips when the latest message is an interrupted assistant turn", () => {
    expect(shouldSkipAutoContinueForMessages([
      { info: { role: "user" }, time: { created: 1 }, parts: [{ type: "text", text: "do work" }] },
      {
        info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
        time: { created: 2 },
      },
    ])).toBe(true);
  });

  test("preserves normal auto-continue when the interrupted turn is not latest", () => {
    expect(shouldSkipAutoContinueForMessages([
      {
        info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
        time: { created: 1 },
      },
      { info: { role: "user" }, time: { created: 2 }, parts: [{ type: "text", text: "继续" }] },
    ])).toBe(false);
  });

  test("orders messages by created time when available", () => {
    expect(shouldSkipAutoContinueForMessages([
      {
        info: { role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
        time: { created: 1 },
      },
      { info: { role: "assistant", finish: "stop" }, time: { created: 2 } },
    ])).toBe(false);
  });
});
