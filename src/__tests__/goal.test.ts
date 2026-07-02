import { describe, expect, test } from "bun:test";
import { compactionContext, type Goal } from "../goal.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    sessionID: "ses_test",
    objective: "Test objective",
    plan: null,
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    completionEvidence: null,
    blocker: null,
    closedAt: null,
    autoTurns: 0,
    lastContinuationAt: null,
    ...overrides,
  };
}

describe("compactionContext", () => {
  test("base context without task IDs", () => {
    const ctx = compactionContext(makeGoal());
    expect(ctx).toContain("Active goal — preserved during compaction");
    expect(ctx).toContain("Test objective");
    expect(ctx).not.toContain("task_id");
  });

  test("includes plan when present", () => {
    const ctx = compactionContext(makeGoal({ plan: "背景: x\n方案: y\n完成标准: z" }));
    expect(ctx).toContain("Plan: 背景: x");
  });

  test("sidekick task_id only", () => {
    const ctx = compactionContext(makeGoal(), "ses_side123");
    expect(ctx).toContain("Sidekick task_id: ses_side123");
    expect(ctx).not.toContain("Reviewer task_id");
  });

  test("reviewer task_id only", () => {
    const ctx = compactionContext(makeGoal(), null, "ses_rev123");
    expect(ctx).toContain("Reviewer task_id: ses_rev123");
    expect(ctx).not.toContain("Sidekick task_id");
  });

  test("both sidekick and reviewer task_ids", () => {
    const ctx = compactionContext(makeGoal(), "ses_side456", "ses_rev456");
    expect(ctx).toContain("Sidekick task_id: ses_side456");
    expect(ctx).toContain("Reviewer task_id: ses_rev456");
  });

  test("null task IDs produce base context", () => {
    const ctx = compactionContext(makeGoal(), null, null);
    expect(ctx).not.toContain("task_id");
  });
});
