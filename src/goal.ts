import { chmod, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

export type GoalStatus = "active" | "paused" | "complete" | "unmet";

export interface Goal {
  sessionID: string;
  objective: string;
  plan: string | null;
  status: GoalStatus;
  react: number;
  createdAt: number;
  updatedAt: number;
  completionEvidence: string | null;
  blocker: string | null;
  closedAt: number | null;
}

interface GoalState {
  version: 7;
  goals: Record<string, Goal>;
  lastCleanupAt?: number;
}

const GOAL_STATE_VERSION = 7;
const MAX_REACT = 12;

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
    react: 0,
    createdAt: now,
    updatedAt: now,
    completionEvidence: null,
    blocker: null,
    closedAt: null,
  };
}

async function readState(): Promise<GoalState> {
  try {
    const raw = await readFile(statePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === GOAL_STATE_VERSION) return parsed as GoalState;
    if (parsed.version === 6 && parsed.goals) {
      const migrated: GoalState = { version: GOAL_STATE_VERSION, goals: {} };
      for (const [id, g] of Object.entries(parsed.goals)) {
        const goal = g as Goal & { react?: number };
        migrated.goals[id] = { ...goal, react: goal.react ?? 0 };
      }
      await writeState(migrated);
      return migrated;
    }
    if (parsed.version !== GOAL_STATE_VERSION) return { version: GOAL_STATE_VERSION, goals: {} };
    return parsed as GoalState;
  } catch {
    return { version: GOAL_STATE_VERSION, goals: {} };
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

/** Increment the re-entry counter, returning the new count. */
export async function bumpReact(sessionID: string): Promise<number> {
  const state = await readState();
  const goal = state.goals[sessionID];
  if (!goal) return 0;
  goal.react += 1;
  goal.updatedAt = nowSeconds();
  await writeState(state);
  return goal.react;
}

export const MAX_GOAL_REACT = MAX_REACT;

export function continuationPrompt(goal: Goal): string {
  return `Continue working toward the current goal: ${goal.objective}

Review your progress so far, identify the next concrete step, and execute it. If the goal is complete, call update_goal with status "complete" and evidence. If blocked, call update_goal with status "unmet" and the blocker.`;
}
