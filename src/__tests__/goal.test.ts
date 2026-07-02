import { describe, expect, test } from "bun:test";
import { compactionContext } from "../taskid.js";

describe("compactionContext", () => {
  test("returns empty string without task IDs", () => {
    expect(compactionContext()).toBe("");
    expect(compactionContext(null, null)).toBe("");
  });

  test("sidekick task_id only", () => {
    const ctx = compactionContext({ task_id: "ses_side123", description: "sidekick work" });
    expect(ctx).toContain("Subagent task_ids — recovered after compaction");
    expect(ctx).toContain('Sidekick task_id: ses_side123 (last dispatch: "sidekick work")');
    expect(ctx).not.toContain("Reviewer task_id");
  });

  test("reviewer task_id only", () => {
    const ctx = compactionContext(null, { task_id: "ses_rev123", description: "reviewer review" });
    expect(ctx).toContain("Subagent task_ids — recovered after compaction");
    expect(ctx).toContain('Reviewer task_id: ses_rev123 (last dispatch: "reviewer review")');
    expect(ctx).not.toContain("Sidekick task_id");
  });

  test("both sidekick and reviewer task_ids", () => {
    const ctx = compactionContext(
      { task_id: "ses_side456", description: "sidekick work" },
      { task_id: "ses_rev456", description: "reviewer review" },
    );
    expect(ctx).toContain("Subagent task_ids — recovered after compaction");
    expect(ctx).toContain('Sidekick task_id: ses_side456 (last dispatch: "sidekick work")');
    expect(ctx).toContain('Reviewer task_id: ses_rev456 (last dispatch: "reviewer review")');
  });

  test("omits last dispatch when description is null", () => {
    const ctx = compactionContext({ task_id: "ses_side789", description: null });
    expect(ctx).toContain("Sidekick task_id: ses_side789");
    expect(ctx).not.toContain("last dispatch");
  });
});
