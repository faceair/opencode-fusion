import { describe, expect, it } from "bun:test";
import { extractSidekickTaskId } from "../taskid.js";
import type { RecallMessage } from "../recall.js";

function toolPart(name: string, input: unknown, output: unknown): unknown {
  return {
    type: "tool",
    tool: name,
    state: { status: "completed", input, content: output },
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
    expect(extractSidekickTaskId(messages)).toBe("tsk_abc");
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
    expect(extractSidekickTaskId(messages)).toBe("tsk_followup");
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
    expect(extractSidekickTaskId(messages)).toBe("tsk_new");
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
    expect(extractSidekickTaskId(messages)).toBe("tsk_json");
  });

  it("handles parts in content field instead of parts", () => {
    const messages = [
      {
        id: "msg-1",
        type: "assistant",
        content: [toolPart("task", { subagent_type: "sidekick", prompt: "x" }, { task_id: "tsk_content" })],
      } as unknown as RecallMessage,
    ];
    expect(extractSidekickTaskId(messages)).toBe("tsk_content");
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
    expect(extractSidekickTaskId(messages)).toBe("tsk_nested");
  });

  it("returns null for empty messages", () => {
    expect(extractSidekickTaskId([])).toBeNull();
  });
});
