import { describe, expect, test } from "bun:test";
import {
  isInterruptedAssistantMessage,
  shouldSkipAutoContinueForMessages,
} from "../autocontinue.js";

describe("isInterruptedAssistantMessage", () => {
  test("treats assistant message without finish as interrupted", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "assistant", time: { created: 1 } },
      parts: [{ type: "step-start" }],
    })).toBe(true);
  });

  test("treats assistant message with finish=stop as not interrupted", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "assistant", finish: "stop" },
      parts: [{ type: "text", text: "done" }],
    })).toBe(false);
  });

  test("treats assistant message with finish=tool-calls as not interrupted", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "assistant", finish: "tool-calls" },
      parts: [{ type: "tool", tool: "task" }],
    })).toBe(false);
  });

  test("does not treat user messages as interrupted", () => {
    expect(isInterruptedAssistantMessage({
      info: { role: "user" },
      parts: [{ type: "text", text: "继续" }],
    })).toBe(false);
  });

  test("reads finish from top-level field when info lacks it", () => {
    expect(isInterruptedAssistantMessage({
      finish: "stop",
      info: { role: "assistant" },
    })).toBe(false);
  });
});

describe("shouldSkipAutoContinueForMessages", () => {
  test("skips when the latest message is an interrupted assistant turn", () => {
    expect(shouldSkipAutoContinueForMessages([
      { info: { role: "user" }, time: { created: 1 }, parts: [{ type: "text", text: "do work" }] },
      {
        info: { role: "assistant", time: { created: 2 } },
        time: { created: 2 },
        parts: [{ type: "step-start" }],
      },
    ])).toBe(true);
  });

  test("preserves auto-continue when the latest assistant message finished normally", () => {
    expect(shouldSkipAutoContinueForMessages([
      { info: { role: "user" }, time: { created: 1 }, parts: [{ type: "text", text: "do work" }] },
      {
        info: { role: "assistant", finish: "stop", time: { created: 2 } },
        time: { created: 2 },
      },
    ])).toBe(false);
  });

  test("preserves auto-continue when the interrupted turn is not latest", () => {
    expect(shouldSkipAutoContinueForMessages([
      {
        info: { role: "assistant", time: { created: 1 } },
        time: { created: 1 },
      },
      { info: { role: "user" }, time: { created: 2 }, parts: [{ type: "text", text: "继续" }] },
    ])).toBe(false);
  });

  test("orders messages by created time when available", () => {
    expect(shouldSkipAutoContinueForMessages([
      {
        info: { role: "assistant", time: { created: 1 } },
        time: { created: 1 },
      },
      {
        info: { role: "assistant", finish: "stop", time: { created: 2 } },
        time: { created: 2 },
      },
    ])).toBe(false);
  });
});

// E2E: reproduces the real message sequence from session
// ses_0e0986e6dffehMrDyNugMFHg4w where auto-continue fired after Esc.
// The aborted assistant message (created 1782938829555) had no finish
// field yet when the idle event triggered, because abort completion
// (1782938843206) lagged behind idle. The continuation prompt was
// created at 1782938843158 — 48ms before the aborted message completed.
describe("shouldSkipAutoContinueForMessages — e2e (ses_0e0986e6)", () => {
  const abortedNoFinish = {
    info: {
      role: "assistant",
      mode: "fusion",
      agent: "fusion",
      time: { created: 1782938829555, completed: 1782938843206 },
      // error not yet persisted at idle time
    },
    time: { created: 1782938829555 },
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "Reassessing project progress..." },
    ],
  };

  const abortedWithError = {
    info: {
      role: "assistant",
      mode: "fusion",
      agent: "fusion",
      time: { created: 1782938843165, completed: 1782938843760 },
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    },
    time: { created: 1782938843165 },
    parts: [{ type: "step-start" }],
  };

  const normalStop = {
    info: {
      role: "assistant",
      mode: "fusion",
      agent: "fusion",
      finish: "stop",
      time: { created: 1782938804988, completed: 1782938822275 },
    },
    time: { created: 1782938804988 },
    parts: [{ type: "text", text: "done" }],
  };

  const normalToolCalls = {
    info: {
      role: "assistant",
      mode: "fusion",
      agent: "fusion",
      finish: "tool-calls",
      time: { created: 1782938822315, completed: 1782938829551 },
    },
    time: { created: 1782938822315 },
    parts: [{ type: "tool", tool: "task", state: { status: "completed" } }],
  };

  const userMessage = (created: number, text: string) => ({
    info: { role: "user", time: { created } },
    time: { created },
    parts: [{ type: "text", text }],
  });

  test("skips auto-continue when latest assistant message has no finish (abort before error persisted)", () => {
    // Reproduces the exact failing scenario: idle fired at 1782938843158,
    // aborted message completed at 1782938843206 — API returned the message
    // without finish or error yet.
    expect(shouldSkipAutoContinueForMessages([
      userMessage(1782938822307, "Continue working toward..."),
      abortedNoFinish,
    ])).toBe(true);
  });

  test("skips auto-continue when latest assistant message has abort error but no finish", () => {
    // After abort completion, error is persisted but finish is still absent.
    expect(shouldSkipAutoContinueForMessages([
      userMessage(1782938843158, "Continue working toward..."),
      abortedWithError,
    ])).toBe(true);
  });

  test("preserves auto-continue after a normally completed assistant turn", () => {
    expect(shouldSkipAutoContinueForMessages([
      userMessage(1782938804977, "先解释一个事..."),
      normalStop,
    ])).toBe(false);
  });

  test("preserves auto-continue after a tool-calls assistant turn", () => {
    expect(shouldSkipAutoContinueForMessages([
      userMessage(1782938822307, "Continue working toward..."),
      normalToolCalls,
    ])).toBe(false);
  });

  test("full sequence: normal → abort(no finish) should skip", () => {
    // The real sequence around the bug: tool-calls completed, then user
    // sent continuation prompt, then assistant was aborted mid-generation.
    expect(shouldSkipAutoContinueForMessages([
      normalToolCalls,
      userMessage(1782938822307, "Continue working toward..."),
      abortedNoFinish,
    ])).toBe(true);
  });

  test("full sequence: abort(no finish) → abort(with error) both skip", () => {
    // Two consecutive aborts — the second one is latest and should still skip.
    expect(shouldSkipAutoContinueForMessages([
      abortedNoFinish,
      userMessage(1782938843158, "Continue working toward..."),
      abortedWithError,
    ])).toBe(true);
  });
});
