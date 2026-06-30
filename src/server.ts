import { z } from "zod";
import type { Plugin, PluginOptions, Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";

import * as goal from "./goal.js";
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

  const goalTools = {
    get_goal: {
      description:
        "Get the current goal for this session, including status, plan, and milestone progress from the OpenCode todo list.",
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
        "Set a goal for the current delegated task. Do not wait for the user to request a goal — create one proactively for every delegated task. Fails if a non-complete goal already exists. After set_goal, use todowrite to create milestones.",
      args: {
        objective: z.string().min(1).max(4000).describe("The concrete objective to start pursuing."),
        plan: z.string().max(4000).optional().describe("Background, approach, and key decisions. Preserved across compaction."),
      },
      async execute(args: any, context: any) {
        const g = await goal.createGoal(context.sessionID, args.objective, args.plan);
        return JSON.stringify({ goal: g }, null, 2);
      },
    },

    update_goal: {
      description:
        "Close the current goal. Use status 'complete' with evidence when the objective is achieved and verified. Use status 'unmet' with a blocker when the objective cannot be achieved or is blocked. Do not close a goal merely because work is stopping.",
      args: {
        status: z.enum(["complete", "unmet"]).describe("complete = achieved; unmet = blocked or impossible."),
        evidence: z.string().min(1).max(4000).optional().describe("Required when status is complete. Concrete evidence verified."),
        blocker: z.string().min(1).max(4000).optional().describe("Required when status is unmet. The concrete blocker or impossibility."),
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
    },

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
      output.context.push(goal.compactionContext(g));
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
