# opencode-fusion

[中文](README.zh.md)

An [OpenCode](https://opencode.ai) plugin. Expensive model makes decisions, cheap model does the work, a third model reviews independently.

Inspired by Cognition's [Devin Fusion](https://cognition.com/blog/devin-fusion) — the sidekick architecture comes from them.

## Installation

Add the npm plugin to your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugin": [
    [
      "@faceair/opencode-fusion",
      {
        "sidekick": {
          "model": "provider/model-name",
          "variant": "medium"
        },
        "reviewer": {
          "model": "provider/model-name"
        }
      }
    ]
  ],
  "default_agent": "fusion"
}
```

Restart OpenCode after saving the config. OpenCode installs npm plugins automatically at startup.

Set the environment variable for background subagents (enables parallel investigation mode):

```sh
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
```

Add this to your shell config (e.g. `~/.config/fish/config.fish` or `~/.bashrc`) so it persists across sessions.

| Option | Agent | Description |
|--------|-------|-------------|
| `model` | sidekick, reviewer | Model in `provider/model-id` format |
| `variant` | sidekick, reviewer | Reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `options` | sidekick, reviewer | Provider-specific options (e.g. `serviceTier`) |

If `model` is omitted, the agent inherits the session's current model. If you don't want Fusion as your default agent, omit `default_agent` and select the `fusion` agent manually when needed.

## What it solves

A few common problems when using a single-model agent for engineering work:

- Frontier model time gets spent running tests and reading files — wasting money. Switch everything to a cheap model and decision quality drops. Cognition's data shows the sidekick architecture cuts cost 35% while maintaining frontier performance; delegating test suites to sidekick saves 62%, mechanical removal tasks save 32%.
- One model writes the code, reviews the code, and approves the code. No independent perspective, edge cases get missed.
- "Ask another model" tools lose context cache on every cross-model call, and you pay the full prompt cost again. On a long task, this adds up fast.
- Long tasks stall mid-way waiting for you to type "continue". Goals auto-continue until the objective is done or a concrete blocker stops progress.
- Context compaction wipes working memory. Goals persist to disk and survive restarts; subagent `task_id`s are recovered after compaction.

## How it works

Three agents, each with its own model and cached context:

```
┌─────────────────────────────────────────────────┐
│  fusion (expensive model)                       │
│  owns: decisions, judgment, final verification  │
│                                                 │
│  delegates via task() ──────────────┐           │
│  consults via task() ───────────┐   │           │
│                                ▼   ▼           │
│                    ┌──────────────┐ ┌─────────┐ │
│                    │ reviewer     │ │ sidekick│ │
│                    │ (read-only)  │ │ (cheap) │ │
│                    │ adversarial  │ │ execute ││
│                    │ review       │ │ discover││
│                    │ + diff audit │ │ verify  ││
│                    └──────────────┘ └─────────┘ │
└─────────────────────────────────────────────────┘
```

**fusion** is the main agent you talk to. It owns judgment and decisions — reads code when a decision requires it, makes architectural calls, and does the final verification of changed code before accepting it. It delegates mechanical execution by default, but never lets delegation block it from looking at implementation details when necessary to make a decision.

**sidekick** is the execution partner. It reads code, gathers facts, writes implementation, runs tests, and diagnoses failures in its own cached context. It excels at local execution but lacks global architectural foresight — fusion owns the judgment, sidekick owns the mechanical work within boundaries fusion sets.

**reviewer** is the independent critic — read-only, non-binding. It reviews code changes and diffs to surface issues fusion missed, and provides adversarial judgment when fusion's thinking is stuck or uncertain. It's a critic, not an approver — fusion consults it to find blind spots, not to get permission.

Both sidekick and reviewer keep their own persistent, cached context. Delegation doesn't trigger cache misses — that's the key difference from "ask another model" tools. fusion calls them via the `task` tool, gets back a `task_id`, and reuses it on follow-ups to continue the same thread. Tasks in the same domain go to the same sidekick to reuse cached context; parallel investigations run in separate sessions.

### How fusion decides

Fusion doesn't follow a rigid workflow. It aligns dispatch to the nature of the task:

- **Gathering facts** — ask sidekick for specific references, definitions, caller locations, invariants. Not solutions. Audit the fact chain before deciding.
- **Executing changes** — provide interface contracts, dependencies, and a behavior checklist. Don't write implementation internals — that's sidekick's space.
- **Verification** — read the actual changed code, not the diff summary. Find what's missing: unhandled edge cases, behaviors requested but quietly omitted, critical paths with no test. For non-trivial changes, dispatch reviewer to review the diff independently.

These are common patterns, not a rigid pipeline. When serial dispatch is too slow, fusion parallelizes — how to split the work is its call.

### When to consult reviewer

- **Before a high-risk implementation**, when fusion's thinking is stuck, uncertain, or would benefit from an adversarial perspective.
- **During verification**, for any non-trivial change — reviewer reviews the diff independently and may catch blind spots fusion missed.

If fusion and reviewer disagree, fusion remains the decision owner. It doesn't loop between reviewer and sidekick looking for consensus — that's decision avoidance dressed up as diligence.

### Goal mode with auto-continue

Goals auto-continue until explicitly closed. The agent doesn't stop after one step and wait for you to type "continue". It keeps moving: updates todos via the built-in todo tool, delegates the next chunk to sidekick, reviews the result, and only closes the goal when the work is verified complete or a concrete blocker makes further progress impossible.

Goals persist to disk and survive context compaction and process restarts. Subagent `task_id`s are recovered via `get_task_ids` after compaction.

## Good fit for

- Long tasks that need to survive context compaction and process restarts without losing the plot
- Complex debugging where the obvious fix treats the symptom
- Multi-stage refactors with judgment-heavy decisions
- High-risk changes that need independent review before shipping
- Open-ended work where the next step can't be planned upfront

If you just want a lightweight chat assistant, this is probably overkill.

## License

[MIT](LICENSE)
