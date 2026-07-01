import { z } from "zod";
import type { Plugin, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";

import * as goal from "./goal.js";
import { shouldSkipAutoContinueForMessages, type AutoContinueMessage } from "./autocontinue.js";
import { normalizeRecallLimit, recallMessages, type RecallMessage } from "./recall.js";
import { extractSidekickTaskId } from "./taskid.js";
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

// 0 = unlimited auto-continue
const AUTO_CONTINUE = true;
const MAX_AUTO_TURNS = 0;
const MIN_INTERVAL = 3;

const activeContinuations = new Set<string>();

const plugin: Plugin = async (input, options) => {
  const { sidekick, reviewer } = parseOptions(options);
  const client = input.client as OpencodeClient;

  const recallTools = {
    recall_history: {
      description:
        "Recall prior messages from the current OpenCode session. Use after compaction or when you need exact earlier context. Optional query does a simple case-insensitive keyword filter over message text/tool names. By default tool outputs are summarized; set include_tool_output=true when you need exact tool results.",
      args: {
        query: z.string().min(1).max(500).optional().describe("Optional case-insensitive keyword filter."),
        limit: z.number().int().min(1).max(80).optional().describe("Maximum matching messages to return; default 20, max 80."),
        include_tool_output: z.boolean().optional().describe("Include tool output content. Default false to keep recall quiet."),
      },
      async execute(args: any, context: any) {
        const limit = normalizeRecallLimit(args.limit);
        let raw: any;
        try {
          raw = await client.session.messages({
            path: { id: context.sessionID },
            query: { limit: Math.max(limit * 4, 80) },
          } as any);
        } catch (error) {
          throw new Error(
            `Failed to recall OpenCode session history for session ${context.sessionID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const data = raw?.data ?? raw ?? [];
        if (!Array.isArray(data)) {
          throw new Error(
            `Failed to recall OpenCode session history for session ${context.sessionID}: expected message array, got ${typeof data}`,
          );
        }
        return JSON.stringify(
          recallMessages(data as RecallMessage[], {
            query: args.query,
            limit,
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
        "Get the current goal for this session, including status, plan, auto-continue state, and milestone progress from the OpenCode todo list. Use before continuing an existing objective, after compaction, or whenever goal state is uncertain.",
      args: {},
      async execute(_args: any, context: any) {
        const g = await goal.getGoal(context.sessionID);
        let todos: any[] = [];
        try {
          const result = await client.session.todo({
            path: { id: context.sessionID },
          }) as any;
          todos = result.data ?? result ?? [];
        } catch {}
        return JSON.stringify({ goal: g, milestones: todos }, null, 2);
      },
    },

    set_goal: {
      description:
        "Set a goal for the current delegated task or non-trivial self-executed execution task. Create it proactively before meaningful execution; do not wait for the user to request one. Fails if a non-complete goal already exists. After set_goal, immediately use todowrite to create concise, actionable milestones and keep them updated as work progresses.",
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
      const messages = raw?.data ?? raw ?? [];
      return Array.isArray(messages)
        ? shouldSkipAutoContinueForMessages(messages as AutoContinueMessage[])
        : false;
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
    } as any,

    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return;
      const g = await goal.getGoal(input.sessionID);
      if (!g) return;
      let todos: { content: string; status: string }[] = [];
      try {
        const result = await client.session.todo({
          path: { id: input.sessionID },
        }) as any;
        const raw = result.data ?? result ?? [];
        todos = Array.isArray(raw) ? raw.map((t: any) => ({ content: t.content, status: t.status })) : [];
      } catch {}
      const reminder = goal.systemReminder(g, todos);
      if (!reminder.trim()) return;
      if (output.system.some((block) => block.includes("opencode-fusion goal mode"))) return;
      if (output.system.length === 0) {
        output.system.push(reminder);
        return;
      }
      output.system[0] = `${output.system[0]}\n\n${reminder}`;
    },

    async "experimental.session.compacting"(input, output) {
      const g = await goal.getGoal(input.sessionID);
      if (!g) return;
      let sidekickTaskId: string | null = null;
      try {
        const raw = await client.session.messages({
          path: { id: input.sessionID },
          query: { limit: 80 },
        } as any);
        const data = raw?.data ?? raw ?? [];
        if (Array.isArray(data)) {
          sidekickTaskId = extractSidekickTaskId(data as RecallMessage[]);
        }
      } catch {}
      output.context.push(goal.compactionContext(g, sidekickTaskId));
    },

    async "experimental.compaction.autocontinue"(input, output) {
      const g = await goal.getGoal(input.sessionID);
      if (g?.status === "active") {
        output.enabled = false;
      }
    },

    async event({ event }) {
      const sessionID = sessionIDFromEvent(event);
      if (!AUTO_CONTINUE || !isIdleEvent(event)) return;
      if (!sessionID) return;
      if (activeContinuations.has(sessionID)) return;

      activeContinuations.add(sessionID);
      try {
        const currentGoal = await goal.getGoal(sessionID);
        if (currentGoal?.status !== "active") return;
        if (await shouldSkipAutoContinue(sessionID)) return;
        const g = await goal.reserveContinuation(sessionID, MAX_AUTO_TURNS, MIN_INTERVAL);
        if (!g) return;
        await sendContinuation(sessionID, goal.continuationPrompt(g));
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
