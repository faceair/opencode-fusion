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
| `options` | sidekick, reviewer | Provider-specific options |

If `model` is omitted, the agent inherits the session's current model. If you don't want Fusion as your default agent, omit `default_agent` and select the `fusion` agent manually when needed.

## What it solves

A few common problems when using a single-model agent for engineering work:

- Frontier model time gets spent running tests and reading files — wasting money. Switch everything to a cheap model and decision quality drops. Cognition's data shows the sidekick architecture cuts cost 35% while maintaining frontier performance; delegating test suites to sidekick saves 62%, mechanical removal tasks save 32%.
- One model writes the code, reviews the code, and approves the code. No independent perspective, edge cases get missed.
- "Ask another model" tools lose context cache on every cross-model call, and you pay the full prompt cost again. On a long task, this adds up fast.
- Long tasks stall mid-way waiting for you to type "continue". Goals auto-continue until the objective is done or a concrete blocker stops progress.
- Context compaction wipes working memory. Goals persist to disk and survive restarts; subagent `task_id`s are recovered after compaction.

## How it works

Two parallel agents, each with its own tools and cached context. The main agent decides which work to give the sidekick and which to do itself:

![Sidekick architecture: a frontier main agent and a small sidekick agent running in parallel, each with its own cached context](https://cognition.com/_next/static/media/sidekick-diagram.153unbtaywtzg.png)

opencode-fusion adds a third read-only agent (reviewer) for independent review, plus a goal mode that keeps tasks moving. Three agents, each with its own model and context:

```
┌─────────────────────────────────────────────────┐
│  fusion (expensive model)                       │
│  owns: decisions, final review, goals           │
│                                                 │
│  delegates via task() ──────────────┐           │
│  consults via task() ───────────┐   │           │
│                                ▼   ▼           │
│                    ┌──────────────┐ ┌─────────┐ │
│                    │ reviewer     │ │ sidekick│ │
│                    │ (read-only)  │ │ (cheap) │ │
│                    │ risk review   │ │ execute ││
│                    │ + adversarial │ │ discover││
│                    │               │ │ verify  ││
│                    └──────────────┘ └─────────┘ │
└─────────────────────────────────────────────────┘
```

**fusion** is the main agent you talk to. It takes minimal actions — reads only what's necessary, makes the calls that need judgment, and delegates the rest by default. It owns understanding requirements, making decisions, and controlling delivery quality, doing the final review itself rather than letting sidekick do it.

**sidekick** handles the mechanical load: reading code, editing files, running tests, diagnosing failures. It returns locatable evidence and observations to fusion, not conclusions.

**reviewer** is read-only. It reviews high-risk changes before implementation and does independent code review before delivery. For changes touching untrusted input, persistence, or concurrency, it walks each input path from an attacker's perspective.

Both sidekick and reviewer keep their own persistent, cached context. Delegation doesn't trigger cache misses — that's the key difference from "ask another model" tools. fusion calls them via the `task` tool, gets back a `task_id`, and reuses it on follow-ups to continue the same thread.

### When to delegate to sidekick

This is not a single-prompt router that picks one model for the whole task. Fusion decides per-step which agent should do what:

- **Hand off slow verification.** Sidekick runs the test suite while fusion moves on to the next decision.
- **Take back judgment-heavy work.** When sidekick hits a decision point — API shape, error semantics, cross-module boundary — fusion takes it back instead of letting the cheap model guess.
- **Send targeted follow-ups.** Sidekick found something unexpected? Fusion sends a focused question back instead of re-reading the code itself.
- **Don't delegate when judgment is the deliverable.** Hard features that need subtle intent (e.g. cross-team search UI decisions) lose intent when delegated to a cheap model — the result comes out wrong.

### When to consult reviewer

Two scenarios:

**Before implementation**, when the change is high-risk: shared API contracts, cross-subsystem boundaries, lifecycle/concurrency/persistence semantics, security/credentials/privacy, production-critical paths, the same approach failing repeatedly, confidence still low after local verification.

**Before delivery**, for any non-trivial change, reviewer does a code review pass: correctness, completeness, regressions, architectural coherence. For high-risk changes, it also performs adversarial review — probing the diff from an attacker's perspective:

- *What if this input is 50MB instead of 5KB?*
- *What if a timestamp comes from the future?*
- *What if a background worker gets killed mid-task and retries?*
- *What if two users submit the same request simultaneously?*

Each finding traces the full path: entry point → processing → storage → output → side effects.

### Goal mode with auto-continue

Every delegated task gets a goal: one sentence for the objective, a short plan for background and approach. The goal persists to disk and survives two things that normally kill task momentum:

**Context compaction.** When OpenCode compacts the session (which happens automatically on long tasks), subagent `task_id`s are recovered via `get_task_ids` after compaction. The goal itself is recovered through tool-result history and the `get_goal` tool, keeping goal visibility consistent with the todo list.

**Process restart.** Goals are stored in a local JSON file. Kill the process, reboot your machine, come back tomorrow — `opencode run --continue` picks up the same session ID, and the goal is still there.

Goals auto-continue until explicitly closed. The agent doesn't stop after one step and wait for you to type "continue". It keeps moving: updates todos via the built-in todo tool, delegates the next chunk to sidekick, reviews the result, and only closes the goal when the work is verified complete or a concrete blocker makes further progress impossible.

### Reviewer loop for open-ended work

Some tasks can't be fully planned upfront: performance optimization, ambiguous root-cause investigation, architecture cleanup. These use a reviewer loop:

1. Complete a todo, bring evidence to reviewer
2. Reviewer decides the next step: `continue` (same direction), `pivot` (change direction), `stop` (no meaningful next step), `blocked` (missing evidence or prerequisite)
3. Execute the next step, loop back to reviewer
4. Until reviewer says `stop` and the work is verified, or `blocked` with a concrete blocker

### First principles

When a bug fix, architecture decision, or approach choice is on the table, agents reason from fundamental facts and constraints instead of reaching for the closest pattern in training data.

- *Symptom fix:* "The feed is broken, let me fix the fetcher." The same bug comes back next week.
- *Root cause fix:* "The traffic routing layer has a latent failure mode. The fetcher was just the first victim. Fix the routing." The bug class is eliminated.

## Good fit for

- Long tasks that need to survive context compaction and process restarts without losing the plot
- Complex debugging where the obvious fix treats the symptom
- Multi-stage refactors with judgment-heavy decisions
- High-risk changes that need independent review before shipping
- Open-ended work where the next step can't be planned upfront and a reviewer loop helps converge

If you just want a lightweight chat assistant, this is probably overkill.

## License

[MIT](LICENSE)
