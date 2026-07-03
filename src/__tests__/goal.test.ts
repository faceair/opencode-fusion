import { describe, expect, test } from "bun:test";
import { compactionInjectContext } from "../taskid.js";

describe("compactionInjectContext", () => {
  test("returns empty array without task IDs", () => {
    expect(compactionInjectContext()).toEqual([]);
    expect(compactionInjectContext(null, null)).toEqual([]);
  });

  test("sidekick task_id only", () => {
    const ctx = compactionInjectContext({ task_id: "ses_side123", description: "sidekick work" });
    expect(ctx).toHaveLength(1);
    expect(ctx[0]).toContain("Subagent task_ids — preserve in summary");
    expect(ctx[0]).toContain('Sidekick task_id: ses_side123 (last dispatch: "sidekick work")');
    expect(ctx[0]).toContain('"## Critical Context"');
    expect(ctx[0]).not.toContain("Reviewer task_id");
  });

  test("reviewer task_id only", () => {
    const ctx = compactionInjectContext(null, { task_id: "ses_rev123", description: "reviewer review" });
    expect(ctx[0]).toContain("Subagent task_ids — preserve in summary");
    expect(ctx[0]).toContain('Reviewer task_id: ses_rev123 (last dispatch: "reviewer review")');
    expect(ctx[0]).not.toContain("Sidekick task_id");
  });

  test("both sidekick and reviewer task_ids", () => {
    const ctx = compactionInjectContext(
      { task_id: "ses_side456", description: "sidekick work" },
      { task_id: "ses_rev456", description: "reviewer review" },
    );
    expect(ctx[0]).toContain("Subagent task_ids — preserve in summary");
    expect(ctx[0]).toContain('Sidekick task_id: ses_side456 (last dispatch: "sidekick work")');
    expect(ctx[0]).toContain('Reviewer task_id: ses_rev456 (last dispatch: "reviewer review")');
  });

  test("omits last dispatch when description is null", () => {
    const ctx = compactionInjectContext({ task_id: "ses_side789", description: null });
    expect(ctx[0]).toContain("Sidekick task_id: ses_side789");
    expect(ctx[0]).not.toContain("last dispatch");
  });
});
