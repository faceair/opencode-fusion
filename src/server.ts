import { z } from "zod";
import type { Plugin, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";

import * as goal from "./goal.js";
import { shouldSkipAutoContinueForMessages, type AutoContinueMessage } from "./autocontinue.js";
import { normalizeRecallLimit, normalizeRecallOffset, normalizeRecallRole, RECALL_ROLES, recallMessages, type RecallMessage } from "./recall.js";
import { extractSidekickTaskId, extractReviewerTaskId, compactionInjectContext } from "./taskid.js";
import { SIDEKICK_SYSTEM_PROMPT } from "./sidekick.js";
import { REVIEWER_SYSTEM_PROMPT } from "./reviewer.js";
import { FUSION_SYSTEM_PROMPT } from "./fusion.js";

interface AgentConfig {
  model?: string;
  variant?: string;
  options?: Record<string, unknown>;
}

interface FusionOptions {
  sidekick?: AgentConfig;
  reviewer?: AgentConfig;
}

function parseOptions(opts: PluginOptions | undefined) {
  const o = (opts ?? {}) as FusionOptions;
  return {
    sidekick: o.sidekick ?? {},
    reviewer: o.reviewer ?? {},
  };
}

function isIdleEvent(event: any): boolean {
  if (event.type === "session.idle") return true;
  const status = event.properties?.status;
  return (
    event.type === "session.status" &&
    typeof status === "object" &&
    status !== null &&
    status.type === "idle"
  );
}

function sessionIDFromEvent(event: any): string | undefined {
  const direct = event.properties?.sessionID;
  if (typeof direct === "string") return direct;
  const info = event.properties?.info;
  if (info && typeof info === "object" && typeof info.sessionID === "string")
    return info.sessionID;
  return;
}

const activeContinuations = new Set<string>();

const plugin: Plugin = async (input, options) => {
  const { sidekick, reviewer } = parseOptions(options);
  const client = input.client as OpencodeClient;

  const recallTools = {
    recall_history: {
      description:
        "Recall prior messages from the current OpenCode session. Use after compaction or when you need exact earlier context. Optional query does a simple case-insensitive keyword filter over message text/tool names. Optional role filters by message type (e.g. role=user returns only user messages). By default tool outputs are summarized; set include_tool_output=true when you need exact tool results. Use offset to page backwards from the most recent messages (e.g. after a compaction, offset=10 limit=10 returns the 10 messages just before the most recent 10), which is useful for retrieving context adjacent to a compaction boundary without a search query. role, query, offset, and limit all compose: role+query both must match, then offset pages backwards over the matched set.",
      args: {
        query: z.string().min(1).max(500).optional().describe("Optional case-insensitive keyword filter."),
        role: z.enum(RECALL_ROLES).optional().describe("Optional message-type filter: user, assistant, system, shell, synthetic, agent-switched, model-switched, compaction."),
        limit: z.number().int().min(1).max(80).optional().describe("Maximum matching messages to return; default 20, max 80."),
        offset: z.number().int().min(0).max(500).optional().describe("Number of most recent matched messages to skip before taking the limit window. 0 (default) returns the most recent matches; increasing offset pages backwards in time. Useful for retrieving messages adjacent to a compaction boundary."),
        include_tool_output: z.boolean().optional().describe("Include tool output content. Default false to keep recall quiet."),
      },
      async execute(args: any, context: any) {
        const limit = normalizeRecallLimit(args.limit);
        const offset = normalizeRecallOffset(args.offset);
        const role = normalizeRecallRole(args.role);
        let raw: any;
        try {
          raw = await client.session.messages({
            path: { id: context.sessionID },
            query: { limit: Math.max(limit * 4 + offset * 2, 80) },
          } as any);
        } catch (error) {
          throw new Error(
            `Failed to recall OpenCode session history for session ${context.sessionID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const data = (raw?.data ?? raw) as RecallMessage[];
        return JSON.stringify(
          recallMessages(data, {
            query: args.query,
            limit,
            offset,
            role,
            includeToolOutput: args.include_tool_output === true,
          }),
          null,
          2,
        );
      },
    },
  };

  const goalTools = {
    get_goal: {
      description:
        "Get the current goal for this session, including status, plan, and milestone progress from the OpenCode todo list. Use before continuing an existing objective, after compaction, or whenever goal state is uncertain.",
      args: {},
      async execute(_args: any, context: any) {
        const g = await goal.getGoal(context.sessionID);
        let todos: any[] = [];
        try {
          const result = await client.session.todo({
            path: { id: context.sessionID },
          }) as any;
          todos = (result.data ?? result) as any[];
        } catch {}
        return JSON.stringify({ goal: g, milestones: todos }, null, 2);
      },
    },

    set_goal: {
      description:
        "Set a goal for the current session. Fails if a non-complete goal already exists. After set_goal, immediately use todowrite to create concise, actionable milestones and keep them updated as work progresses.",
      args: {
        objective: z.string().min(1).max(4000).describe("One sentence stating the concrete target outcome. Do not include approach, step lists, implementation details, or verification commands."),
        plan: z.string().max(4000).optional().describe("Short plan preserved across compaction. Prefer three compact sections: 背景 (context/constraints), 方案 (approach outline, not step-by-step), 完成标准 (what counts as done). Keep each section 1-3 lines."),
      },
      async execute(args: any, context: any) {
        const g = await goal.createGoal(context.sessionID, args.objective, args.plan);
        return JSON.stringify({ goal: g }, null, 2);
      },
    },

    update_goal: {
      description:
        "Close the current goal. Use status 'complete' only when the objective is achieved and verified; include concrete evidence such as changed files, commands/results, and reviewer outcome when relevant. Use status 'unmet' only when the objective cannot be achieved or is blocked; include the concrete blocker or missing prerequisite. Do not close a goal merely because work is stopping, and complete/cancel milestones before closing when possible.",
      args: {
        status: z.enum(["complete", "unmet"]).describe("complete = achieved; unmet = blocked or impossible."),
        evidence: z.string().min(1).max(4000).optional().describe("Required when status is complete. State the verified evidence: key files/behavior changed, exact validation commands and pass results, and review evidence if applicable."),
        blocker: z.string().min(1).max(4000).optional().describe("Required when status is unmet. State the concrete blocker, impossibility, or external prerequisite, plus the next action needed if known."),
      },
      async execute(args: any, context: any) {
        if (args.status === "complete") {
          const g = await goal.completeGoal(context.sessionID, args.evidence ?? "");
          return JSON.stringify(
            { goal: g, report: `Goal achieved. Evidence: ${g.completionEvidence}.` },
            null,
            2,
          );
        }
        const g = await goal.markGoalUnmet(context.sessionID, args.blocker ?? "");
        return JSON.stringify(
          { goal: g, report: `Goal unmet. Blocker: ${g.blocker}.` },
          null,
          2,
        );
      },
    },
  };

  const taskTools = {
    get_task_ids: {
      description:
        "Get the currently saved sidekick and reviewer task_ids for this session by scanning message history. Use after compaction if task_ids are missing from the summary, or whenever you need to verify the active subagent session handles before dispatching. Returns null for a subagent type if no task tool call is found.",
      args: {},
      async execute(_args: any, context: any) {
        try {
          const raw = await client.session.messages({
            path: { id: context.sessionID },
            query: { limit: 80 },
          } as any);
          const data = (raw?.data ?? raw) as RecallMessage[];
          return JSON.stringify({
            sidekick: extractSidekickTaskId(data),
            reviewer: extractReviewerTaskId(data),
          }, null, 2);
        } catch (error) {
          return JSON.stringify({
            sidekick: null,
            reviewer: null,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2);
        }
      },
    },
  };

  async function sendContinuation(sessionID: string, prompt: string) {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: prompt }] },
    });
  }

  async function shouldSkipAutoContinue(sessionID: string): Promise<boolean> {
    try {
      const raw = await client.session.messages({
        path: { id: sessionID },
        query: { limit: 20 },
      } as any);
      const messages = (raw?.data ?? raw) as AutoContinueMessage[];
      return shouldSkipAutoContinueForMessages(messages);
    } catch (error) {
      await input.client.app?.log?.({
        body: {
          service: "opencode-fusion",
          level: "warn",
          message: "Failed to inspect latest user message before auto-continue",
          extra: { error: error instanceof Error ? error.message : String(error) },
        },
      });
      return false;
    }
  }

  const hooks: Hooks = {
    async config(config) {
      const agent = (config.agent ?? {}) as Record<string, any>;
      agent.fusion = {
        description:
          "Fusion workflow agent. Decision and review owner that delegates execution to sidekick and review to reviewer.",
        mode: "primary",
        prompt: FUSION_SYSTEM_PROMPT,
      };
      agent.sidekick = {
        description:
          "Execution and discovery agent. Handles bounded implementation, codebase discovery, and mechanical verification delegated by the fusion primary agent.",
        mode: "subagent",
        ...(sidekick.model ? { model: sidekick.model } : {}),
        ...(sidekick.variant ? { variant: sidekick.variant } : {}),
        ...(Object.keys(sidekick.options ?? {}).length > 0 ? { options: sidekick.options } : {}),
        prompt: SIDEKICK_SYSTEM_PROMPT,
      };
      agent.reviewer = {
        description:
          "Independent review on bounded technical decisions where a second opinion is more valuable than immediate implementation. Read-only — it never implements or modifies files.",
        mode: "subagent",
        ...(reviewer.model ? { model: reviewer.model } : {}),
        ...(reviewer.variant ? { variant: reviewer.variant } : {}),
        ...(Object.keys(reviewer.options ?? {}).length > 0 ? { options: reviewer.options } : {}),
        prompt: REVIEWER_SYSTEM_PROMPT,
        permission: { edit: "deny" },
      };
      config.agent = agent;
    },

    tool: {
      ...goalTools,
      ...recallTools,
      ...taskTools,
    } as any,

    async "experimental.compaction.autocontinue"(input, output) {
      const g = await goal.getGoal(input.sessionID);
      if (g?.status === "active") {
        output.enabled = false;
      }
    },

    async "experimental.session.compacting"(hookInput, output) {
      try {
        const raw = await client.session.messages({
          path: { id: hookInput.sessionID },
          query: { limit: 80 },
        } as any);
        const data = (raw?.data ?? raw) as RecallMessage[];
        output.context.push(
          ...compactionInjectContext(
            extractSidekickTaskId(data),
            extractReviewerTaskId(data),
          ),
        );
      } catch (error) {
        await input.client.app?.log?.({
          body: {
            service: "opencode-fusion",
            level: "error",
            message: "Compaction task_id injection failed",
            extra: { error: error instanceof Error ? error.message : String(error) },
          },
        });
      }
    },

    async event({ event }) {
      if (!isIdleEvent(event)) return;
      const sessionID = sessionIDFromEvent(event);
      if (!sessionID) return;
      if (activeContinuations.has(sessionID)) return;

      activeContinuations.add(sessionID);
      try {
        const currentGoal = await goal.getGoal(sessionID);
        if (currentGoal?.status !== "active") return;
        if (await shouldSkipAutoContinue(sessionID)) return;
        await sendContinuation(sessionID, goal.continuationPrompt(currentGoal));
      } catch (error) {
        await input.client.app?.log?.({
          body: {
            service: "opencode-fusion",
            level: "error",
            message: "Auto-continue failed",
            extra: { error: error instanceof Error ? error.message : String(error) },
          },
        });
      } finally {
        activeContinuations.delete(sessionID);
      }
    },
  };

  return hooks;
};

export default {
  id: "opencode-fusion",
  server: plugin,
};
