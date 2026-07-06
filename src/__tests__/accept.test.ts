import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Schema } from "effect";

import { toolDefinitionHook, toolExecuteBeforeHook } from "../accept.js";

function todo(status: string) {
  return { content: "check behavior", status, priority: "medium" };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-fusion-accept-test-"));
  process.env.FUSION_ACCEPT_LOG_PATH = join(dir, "accept-log.jsonl");
});

afterEach(async () => {
  delete process.env.FUSION_ACCEPT_LOG_PATH;
  await rm(dir, { recursive: true, force: true });
});

describe("accept gate — tool.definition hook", () => {
  it("replaces parameters for todowrite with schema that accepts evidence", async () => {
    const originalParams = Schema.Struct({ todos: Schema.Array(Schema.Unknown) });
    const output = { description: "original", parameters: originalParams };

    await toolDefinitionHook({ toolID: "todowrite" }, output);

    const parsed = Schema.decodeUnknownSync(output.parameters)({
      todos: [todo("completed")],
      evidence: "src/server.ts:222 hook wiring confirmed",
    }) as { todos: Array<{ status: string }>; evidence?: string };
    expect(parsed.evidence).toBe("src/server.ts:222 hook wiring confirmed");
    expect(parsed.todos[0]?.status).toBe("completed");
  });

  it("does not modify non-todowrite tools", async () => {
    const originalParams = Schema.String;
    const output = { description: "original", parameters: originalParams };

    await toolDefinitionHook({ toolID: "read" }, output);

    expect(output.parameters).toBe(originalParams);
    expect(output.description).toBe("original");
  });
});

describe("accept gate — tool.execute.before hook", () => {
  it("throws when todo is marked completed without evidence", async () => {
    const output = { args: { todos: [todo("completed")] } };

    await expect(toolExecuteBeforeHook({ tool: "todowrite", sessionID: "s1", callID: "c1" }, output)).rejects.toThrow(
      "evidence",
    );
  });

  it("throws when todo is marked completed with empty evidence", async () => {
    const output = { args: { todos: [todo("completed")], evidence: "" } };

    await expect(toolExecuteBeforeHook({ tool: "todowrite", sessionID: "s1", callID: "c1" }, output)).rejects.toThrow(
      "evidence",
    );
  });

  it("accepts completed todo with evidence, strips field, logs record", async () => {
    const output = {
      args: {
        todos: [todo("completed"), todo("pending"), todo("completed")],
        evidence: "src/goal.ts:135-145 completeGoal verified; bun test: pass",
      },
    };

    await toolExecuteBeforeHook({ tool: "todowrite", sessionID: "s1", callID: "c1" }, output);

    expect(output.args.evidence).toBeUndefined();
    expect(output.args.todos).toHaveLength(3);

    const log = await readFile(process.env.FUSION_ACCEPT_LOG_PATH!, "utf-8");
    const record = JSON.parse(log.trim());
    expect(record.sessionID).toBe("s1");
    expect(record.evidence).toContain("src/goal.ts");
    expect(record.completedCount).toBe(2);
    expect(typeof record.timestamp).toBe("number");
  });

  it("does not interfere when no todo is marked completed", async () => {
    const output = { args: { todos: [todo("pending"), todo("in_progress")] } };

    await toolExecuteBeforeHook({ tool: "todowrite", sessionID: "s1", callID: "c1" }, output);

    expect(output.args.todos[0]?.status).toBe("pending");
  });

  it("does not interfere with non-todowrite tools", async () => {
    const output = { args: { todos: [todo("completed")] } };

    await toolExecuteBeforeHook({ tool: "read", sessionID: "s1", callID: "c1" }, output);

    expect(output.args.todos[0]?.status).toBe("completed");
  });
});
