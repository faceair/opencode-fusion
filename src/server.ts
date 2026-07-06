import { z } from "zod";
import type { Plugin, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";

import * as goal from "./goal.js";
import { shouldSkipAutoContinueForMessages, type AutoContinueMessage } from "./autocontinue.js";
import {
  aroundMessages,
  normalizeSessionHistoryAround,
  normalizeSessionHistoryKinds,
  normalizeSessionHistoryLimit,
  normalizeSessionHistoryOffset,
  normalizeSessionHistoryRole,
  searchMessages,
  SESSION_HISTORY_KINDS,
  SESSION_HISTORY_ROLES,
  type SessionMessage,
} from "./session-history.js";
import { extractAllTaskIds } from "./taskid.js";
import { SIDEKICK_SYSTEM_PROMPT } from "./sidekick.js";
import { REVIEWER_SYSTEM_PROMPT } from "./reviewer.js";
import { FUSION_SYSTEM_PROMPT } from "./fusion.js";
import { toolDefinitionHook as acceptDefHook, toolExecuteBeforeHook as acceptExecHook } from "./accept.js";

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

  const historyTools = {
    session_history: {
      description:
        "Inspect prior messages from the current OpenCode session. operation='search' lists or filters messages by query, role, kind, tool_name, time range, limit, and offset. operation='around' returns context before and after a message_id. By default tool outputs are summarized; set include_tool_output=true only when exact tool output is needed.",
      args: {
        operation: z.enum(["search", "around"]).optional().describe("search = search/list messages in current session (default); around = get context around a specific message_id."),
        query: z.string().min(1).max(500).optional().describe("Optional case-insensitive keyword filter."),
        kind: z.array(z.enum(SESSION_HISTORY_KINDS)).optional().describe("Optional part-kind filter. Matches messages containing at least one of: user_text, assistant_text, tool_input, tool_output, tool_error, reasoning."),
        tool_name: z.string().min(1).max(100).optional().describe("Optional filter to messages containing a specific tool name, e.g. bash or read."),
        role: z.enum(SESSION_HISTORY_ROLES).optional().describe("Optional message role filter: user or assistant."),
        time_after: z.number().optional().describe("Optional Unix ms timestamp; return messages created after this time."),
        time_before: z.number().optional().describe("Optional Unix ms timestamp; return messages created before this time."),
        limit: z.number().int().min(1).max(80).optional().describe("Maximum matching messages to return; default 20, max 80."),
        offset: z.number().int().min(0).max(500).optional().describe("Number of most recent matched messages to skip before taking the limit window. 0 (default) returns the most recent matches; increasing offset pages backwards in time. Useful for retrieving messages adjacent to a compaction boundary."),
        include_tool_output: z.boolean().optional().describe("Include tool output content. Default false to keep recall quiet."),
        message_id: z.string().min(1).optional().describe("Required when operation='around': anchor message ID."),
        before: z.number().int().min(0).max(50).optional().describe("For operation='around': number of messages before anchor; default 5."),
        after: z.number().int().min(0).max(50).optional().describe("For operation='around': number of messages after anchor; default 5."),
      },
      async execute(args: any, context: any) {
        const operation = args.operation === "around" ? "around" : "search";
        const limit = normalizeSessionHistoryLimit(args.limit);
        const offset = normalizeSessionHistoryOffset(args.offset);
        const role = normalizeSessionHistoryRole(args.role);
        let raw: any;
        try {
          raw = await client.session.messages({
            path: { id: context.sessionID },
            query: { limit: operation === "around" ? 200 : Math.max(limit * 4 + offset * 2, 80) },
          } as any);
        } catch (error) {
          throw new Error(
            `Failed to inspect OpenCode session history for session ${context.sessionID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const data = (raw?.data ?? raw) as SessionMessage[];
        if (operation === "around") {
          if (typeof args.message_id !== "string" || !args.message_id) {
            return JSON.stringify({ error: "message_id is required for operation='around'" }, null, 2);
          }
          return JSON.stringify(
            aroundMessages(
              data,
              args.message_id,
              normalizeSessionHistoryAround(args.before),
              normalizeSessionHistoryAround(args.after),
              args.include_tool_output === true,
              context.sessionID,
            ),
            null,
            2,
          );
        }
        return JSON.stringify(
          searchMessages(data, {
            query: args.query,
            kind: normalizeSessionHistoryKinds(args.kind) ?? undefined,
            toolName: args.tool_name,
            timeAfter: typeof args.time_after === "number" ? args.time_after : undefined,
            timeBefore: typeof args.time_before === "number" ? args.time_before : undefined,
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
        "Close the current goal. Use status complete when the objective is achieved. Use status unmet when the objective cannot be achieved or is blocked. Do not close a goal merely because work is stopping.",
      args: {
        status: z.enum(["complete", "unmet"]).describe("complete = achieved; unmet = blocked or impossible."),
      },
      async execute(args: any, context: any) {
        if (args.status === "complete") {
          const g = await goal.completeGoal(context.sessionID);
          return JSON.stringify(
            { goal: g, report: `Goal achieved: ${g.objective}` },
            null,
            2,
          );
        }
        const g = await goal.markGoalUnmet(context.sessionID);
        return JSON.stringify(
          { goal: g, report: `Goal unmet: ${g.objective}` },
          null,
          2,
        );
      },
    },
  };

  const taskTools = {
    get_task_ids: {
      description:
        "Get all saved subagent task_ids for this session by scanning message history, grouped by subagent type. Each entry includes task_id, description, and last_used_at (Unix ms). Entries are deduplicated by task_id and sorted by last_used_at descending (most recently used first). Use after compaction or whenever you need to verify active subagent session handles before dispatching. Absent types are omitted.",
      args: {},
      async execute(_args: any, context: any) {
        try {
          const raw = await client.session.messages({
            path: { id: context.sessionID },
            query: { limit: 80 },
          } as any);
          const data = (raw?.data ?? raw) as SessionMessage[];
          return JSON.stringify(extractAllTaskIds(data), null, 2);
        } catch (error) {
          return JSON.stringify({
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
        permission: {
          get_goal: "deny",
          set_goal: "deny",
          update_goal: "deny",
          get_task_ids: "deny",
        },
      };
      agent.reviewer = {
        description:
          "Independent review on bounded technical decisions where a second opinion is more valuable than immediate implementation. Read-only — it never implements or modifies files.",
        mode: "subagent",
        ...(reviewer.model ? { model: reviewer.model } : {}),
        ...(reviewer.variant ? { variant: reviewer.variant } : {}),
        ...(Object.keys(reviewer.options ?? {}).length > 0 ? { options: reviewer.options } : {}),
        prompt: REVIEWER_SYSTEM_PROMPT,
        permission: {
          edit: "deny",
          get_goal: "deny",
          set_goal: "deny",
          update_goal: "deny",
          get_task_ids: "deny",
        },
      };
      config.agent = agent;
    },

    tool: {
      ...goalTools,
      ...historyTools,
      ...taskTools,
    } as any,

    async "experimental.compaction.autocontinue"(input, output) {
      const g = await goal.getGoal(input.sessionID);
      if (g?.status === "active") {
        output.enabled = false;
      }
    },

    async "tool.definition"(input, output) {
      await acceptDefHook(input, output);
    },

    async "tool.execute.before"(input, output) {
      await acceptExecHook(input, output);
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
        const react = await goal.bumpReact(sessionID);
        if (react > goal.MAX_GOAL_REACT) {
          await goal.markGoalUnmet(sessionID);
          await input.client.app?.log?.({
            body: {
              service: "opencode-fusion",
              level: "warn",
              message: "Auto-continue stopped after max react cap",
              extra: { sessionID, react, maxReact: goal.MAX_GOAL_REACT },
            },
          });
          return;
        }
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
