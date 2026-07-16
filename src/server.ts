import { z } from "zod";
import type { Plugin, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";

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
import FUSION_SYSTEM_PROMPT from "./prompts/fusion.md";
import SIDEKICK_SYSTEM_PROMPT from "./prompts/sidekick.md";

interface AgentConfig {
  model?: string;
  variant?: string;
  options?: Record<string, unknown>;
}

interface FusionOptions {
  sidekick?: AgentConfig;
}

function parseOptions(opts: PluginOptions | undefined) {
  const o = (opts ?? {}) as FusionOptions;
  return {
    sidekick: o.sidekick ?? {},
  };
}

const plugin: Plugin = async (input, options) => {
  const { sidekick } = parseOptions(options);
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

  const hooks: Hooks = {
    async config(config) {
      const agent = (config.agent ?? {}) as Record<string, any>;
      agent.fusion = {
        description:
          "Fusion workflow agent. Decision owner that delegates bounded execution and discovery to sidekick.",
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
          get_task_ids: "deny",
        },
      };
      config.agent = agent;
    },

    tool: {
      ...historyTools,
      ...taskTools,
    } as any,
  };

  return hooks;
};

export default {
  id: "opencode-fusion",
  server: plugin,
};
