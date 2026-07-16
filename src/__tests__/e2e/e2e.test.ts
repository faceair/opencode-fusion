// E2E tests for opencode-fusion plugin runtime flows.
//
// These spawn a real `opencode serve` subprocess with the fusion plugin
// loaded, drive a real session through the SDK client, and assert on
// session.messages() tool parts.
import { describe, expect, it } from "bun:test";
import { withFusionEnv, waitForToolComplete, findToolPart, type FusionEnv } from "./harness.js";
import { isTitleRequest } from "./fake-llm.js";

// Helper: create a session and send a prompt asynchronously, then poll for
// a tool to complete.
async function createAndPromptForTool(
  env: FusionEnv,
  message: string,
  toolName: string,
  opts?: { agent?: string; timeoutMs?: number },
): Promise<{ sessionID: string; toolPart: Record<string, unknown> }> {
  const session = await env.client.session.create({
    body: {
      title: "e2e test",
      agent: opts?.agent ?? "fusion",
      model: { providerID: "test", id: "test-model" },
    } as any,
  });
  const sessionID = (session.data as any)?.id;
  if (!sessionID) throw new Error("failed to create session");

  await env.client.session.promptAsync({
    path: { id: sessionID },
    body: {
      agent: opts?.agent ?? "fusion",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: message }],
    },
  } as any);

  const toolPart = await waitForToolComplete(env.client, sessionID, toolName, opts?.timeoutMs ?? 30_000);
  return { sessionID, toolPart };
}

async function getMessages(env: FusionEnv, sessionID: string, limit = 80) {
  const result = await env.client.session.messages({
    path: { id: sessionID },
    query: { limit },
  } as any);
  const data = (result.data ?? result) as any[];
  if (!Array.isArray(data)) throw new Error(`expected message array, got ${typeof data}`);
  return data;
}

describe("opencode-fusion e2e", () => {
  it("harness starts opencode serve and loads the fusion plugin", async () => {
    await withFusionEnv(async (env) => {
      // If the plugin loaded, the fusion/sidekick agents should be registered.
      const app = await (env.client as any).app.agents();
      const agents = (app.data ?? []) as Array<{ name: string; mode: string }>;
      const fusion = agents.find((a) => a.name === "fusion");
      expect(fusion).toBeDefined();
      expect(fusion?.mode).toBe("primary");

      const sidekick = agents.find((a) => a.name === "sidekick");
      expect(sidekick).toBeDefined();
      expect(sidekick?.mode).toBe("subagent");
    });
  }, 60_000);

  it("session.messages() tool parts use state.output string", async () => {
    await withFusionEnv(async (env) => {
      env.llm.tool("session_history", { operation: "search", limit: 5 });

      const { toolPart } = await createAndPromptForTool(env, "search session history", "session_history");

      const state = toolPart.state as Record<string, unknown>;
      expect(state.status).toBe("completed");
      expect(state.output).toBeDefined();
      expect(typeof state.output).toBe("string");
      expect(state.content).toBeUndefined();
    });
  }, 60_000);

  it("session_history search returns prior messages", async () => {
    await withFusionEnv(async (env) => {
      // Turn 1: send a text message to create history.
      env.llm.text("hello from the first turn");
      const session = await env.client.session.create({
        body: {
          title: "history test",
          agent: "fusion",
          model: { providerID: "test", id: "test-model" },
        } as any,
      });
      const sessionID = (session.data as any)?.id;
      if (!sessionID) throw new Error("failed to create session");

      await env.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: "fusion",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "say hello" }],
        },
      } as any);

      // Wait for the assistant text response.
      const start = Date.now();
      let gotResponse = false;
      while (Date.now() - start < 20_000) {
        const messages = await getMessages(env, sessionID);
        const hasResponse = messages.some(
          (m: any) => m.info?.role === "assistant" &&
            Array.isArray(m.parts) &&
            m.parts.some((p: any) => p.type === "text" && p.text === "hello from the first turn"),
        );
        if (hasResponse) {
          gotResponse = true;
          break;
        }
        await Bun.sleep(300);
      }
      expect(gotResponse).toBe(true);

      // Turn 2: call session_history search.
      env.llm.tool("session_history", { operation: "search", include_tool_output: true, limit: 10 });
      await env.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: "fusion",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "recall what we discussed" }],
        },
      } as any);

      const historyPart = await waitForToolComplete(env.client, sessionID, "session_history", 30_000);
      const state = historyPart.state as Record<string, unknown>;
      expect(state.status).toBe("completed");
      expect(typeof state.output).toBe("string");

      const historyOutput = state.output as string;
      expect(historyOutput).toContain("hello from the first turn");
    });
  }, 90_000);

  it("get_task_ids returns the sidekick task_id after a task tool call", async () => {
    await withFusionEnv(async (env) => {
      // Turn 1: call the task tool with subagent_type=sidekick.
      env.llm.tool("task", {
        description: "sidekick id lookup",
        prompt: "do something small",
        subagent_type: "sidekick",
      });
      const { sessionID } = await createAndPromptForTool(env, "delegate to sidekick", "task", { timeoutMs: 60_000 });

      const taskPart = await waitForToolComplete(env.client, sessionID, "task", 60_000);
      const taskState = taskPart.state as Record<string, unknown>;
      expect(taskState.status).toBe("completed");
      const taskOutput = taskState.output as string;
      const taskIdMatch = taskOutput.match(/<task\s+id="(ses_[^"]+)"/);
      expect(taskIdMatch).not.toBeNull();
      const taskId = taskIdMatch![1]!;

      // Turn 2: call get_task_ids and verify it recovers the sidekick handle.
      env.llm.tool("get_task_ids", {});
      await env.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: "fusion",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "recover task ids" }],
        },
      } as any);

      const getTaskIdsPart = await waitForToolComplete(env.client, sessionID, "get_task_ids", 30_000);
      const getTaskIdsState = getTaskIdsPart.state as Record<string, unknown>;
      expect(getTaskIdsState.status).toBe("completed");
      const output = JSON.parse(getTaskIdsState.output as string);
      expect(output.sidekick).toEqual([{ task_id: taskId, description: "sidekick id lookup", last_used_at: expect.any(Number) }]);
    });
  }, 90_000);
});
