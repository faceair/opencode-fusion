import { chmod, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

export type GoalStatus = "active" | "paused" | "complete" | "unmet";

export interface Goal {
  sessionID: string;
  objective: string;
  plan: string | null;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completionEvidence: string | null;
  blocker: string | null;
  closedAt: number | null;
  autoTurns: number;
  lastContinuationAt: number | null;
}

interface GoalState {
  version: 5;
  goals: Record<string, Goal>;
  lastCleanupAt?: number;
}

const MAX_PLAN_CHARS = 4000;
const CLEANUP_INTERVAL = 30 * 24 * 3600;
const GOAL_TTL = 30 * 24 * 3600;

function defaultStateFile(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : join(homedir(), ".local", "share"));
  return join(dataHome, "opencode-fusion", "goals.json");
}

function statePath(): string {
  return process.env.FUSION_GOAL_STATE_PATH || defaultStateFile();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeGoal(sessionID: string, objective: string, plan?: string): Goal {
  const now = nowSeconds();
  return {
    sessionID,
    objective,
    plan: plan ? plan.slice(0, MAX_PLAN_CHARS) : null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    completionEvidence: null,
    blocker: null,
    closedAt: null,
    autoTurns: 0,
    lastContinuationAt: null,
  };
}

async function readState(): Promise<GoalState> {
  try {
    const raw = await readFile(statePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 5) return { version: 5, goals: {} };
    return parsed as GoalState;
  } catch {
    return { version: 5, goals: {} };
  }
}

async function writeState(state: GoalState): Promise<void> {
  const now = nowSeconds();
  if (!state.lastCleanupAt || now - state.lastCleanupAt > CLEANUP_INTERVAL) {
    const expired = new Set<string>();
    for (const [id, g] of Object.entries(state.goals)) {
      const age = now - (g.closedAt ?? g.updatedAt);
      if (age > GOAL_TTL) expired.add(id);
    }
    if (expired.size > 0) {
      for (const id of expired) delete state.goals[id];
    }
    state.lastCleanupAt = now;
  }
  const filePath = statePath();
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  try {
    await rename(tmp, filePath);
  } catch {
    try { await unlink(tmp); } catch {}
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  }
  try {
    await chmod(filePath, 0o600);
  } catch {}
}

export async function getGoal(sessionID: string): Promise<Goal | null> {
  const state = await readState();
  return state.goals[sessionID] ?? null;
}

export async function createGoal(
  sessionID: string,
  objective: string,
  plan?: string,
): Promise<Goal> {
  const state = await readState();
  const existing = state.goals[sessionID];
  if (existing && existing.status !== "complete" && existing.status !== "unmet") {
    throw new Error(
      `Active goal already exists for session ${sessionID}. Complete it first.`,
    );
  }
  const goal = makeGoal(sessionID, objective, plan);
  state.goals[sessionID] = goal;
  await writeState(state);
  return goal;
}

export async function completeGoal(
  sessionID: string,
  evidence: string,
): Promise<Goal> {
  const state = await readState();
  const goal = state.goals[sessionID];
  if (!goal) throw new Error(`No goal for session ${sessionID}`);
  goal.status = "complete";
  goal.completionEvidence = evidence;
  goal.closedAt = nowSeconds();
  goal.updatedAt = goal.closedAt;
  await writeState(state);
  return goal;
}

export async function markGoalUnmet(
  sessionID: string,
  blocker: string,
): Promise<Goal> {
  const state = await readState();
  const goal = state.goals[sessionID];
  if (!goal) throw new Error(`No goal for session ${sessionID}`);
  goal.status = "unmet";
  goal.blocker = blocker;
  goal.closedAt = nowSeconds();
  goal.updatedAt = goal.closedAt;
  await writeState(state);
  return goal;
}

// 0 = unlimited auto-continue
export async function reserveContinuation(
  sessionID: string,
  maxAutoTurns: number,
  minIntervalSeconds: number,
): Promise<Goal | null> {
  const state = await readState();
  const goal = state.goals[sessionID];
  if (!goal) return null;
  if (goal.status !== "active") return null;
  const now = nowSeconds();
  if (goal.lastContinuationAt && now - goal.lastContinuationAt < minIntervalSeconds) {
    return null;
  }
  if (maxAutoTurns > 0 && goal.autoTurns >= maxAutoTurns) return null;
  goal.autoTurns += 1;
  goal.lastContinuationAt = now;
  goal.updatedAt = now;
  await writeState(state);
  return goal;
}

const GOAL_MARKER = "opencode-fusion goal mode";

export function systemReminder(goal: Goal | null, todos: { content: string; status: string }[]): string {
  if (!goal) return "";
  const elapsed = nowSeconds() - goal.createdAt;
  const activeMilestones = todos
    .filter((t) => t.status === "in_progress")
    .map((t) => `  ▶ ${t.content}`);
  const pendingMilestones = todos
    .filter((t) => t.status === "pending")
    .map((t) => `  ○ ${t.content}`);
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const todoSection = todos.length > 0
    ? `\nMilestones (${completedCount}/${todos.length} done):\n${activeMilestones.concat(pendingMilestones).join("\n") || "  (all done)"}`
    : "";

  const planSection = goal.plan
    ? `\nPlan: ${goal.plan.slice(0, 300)}`
    : "";

  return `[${GOAL_MARKER}]
Current goal (status: ${goal.status}, elapsed: ${elapsed}s, auto-turns: ${goal.autoTurns})
Objective: ${goal.objective}${planSection}${todoSection}

Continue working toward this objective. Use update_goal to close it with evidence when complete, or with a blocker when unmet.`;
}

export function compactionContext(goal: Goal): string {
  return `[Active goal — preserved during compaction]
Objective: ${goal.objective}
${goal.plan ? `Plan: ${goal.plan}\n` : ""}Status: ${goal.status}
Auto-turns: ${goal.autoTurns}`;
}

export function continuationPrompt(goal: Goal): string {
  return `Continue working toward the current goal: ${goal.objective}

Review your progress so far, identify the next concrete step, and execute it. If the goal is complete, call update_goal with status "complete" and evidence. If blocked, call update_goal with status "unmet" and the blocker.`;
}
