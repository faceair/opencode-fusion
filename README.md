# opencode-fusion

[中文](README.zh.md)

A multi-model fusion plugin for [OpenCode](https://opencode.ai) that keeps frontier intelligence on the decisions that matter while cutting cost on the work that doesn't.

Inspired by [Devin Fusion](https://cognition.com/blog/devin-fusion) from Cognition — the sidekick architecture comes from their work. The goal mode and reviewer loop evolved from [my-codex](https://github.com/faceair/my-codex), an earlier Codex workflow configuration. This plugin brings these ideas together for OpenCode as an open-source plugin you can run locally with your own models.

## Why this exists

You've probably hit these problems with a single-model agent:

- **Cost.** A frontier model burning tokens on `grep`, `cat`, and `npm test` is money lit on fire. But routing everything to a cheap model means your architecture decisions get made by a model that doesn't understand the trade-offs.
- **Cache misses.** "Smart friend" tools let one model ask another for advice — but every cross-model call loses context cache, and you pay the full prompt cost again. On a long task, this adds up fast.
- **Blind spots.** One model writes the code, reviews the code, and approves the code. There's no independent perspective catching the edge case you didn't think of.
- **Stalling.** The agent finishes one step and stops. You type "continue". It does one more step and stops again. A two-hour task takes six hours of babysitting.
- **Amnesia.** Context compaction wipes the plan. The agent forgets what it was doing mid-refactor and starts over from scratch.

opencode-fusion is built around these problems.

## How it works

Three agents, each with its own model, context, and role:

```
┌─────────────────────────────────────────────────┐
│  fusion (frontier model)                        │
│  owns: plan, ambiguity, final review, goals     │
│                                                 │
│  delegates via task() ──────────────┐           │
│  consults via task() ───────────┐   │           │
│                                ▼   ▼           │
│                    ┌──────────────┐ ┌─────────┐ │
│                    │ reviewer     │ │ sidekick│ │
│                    │ (read-only)  │ │ (cheap) │ │
│                    │ architecture │ │ execute │ │
│                    │ + adversarial│ │ discover│ │
│                    │ review       │ │ verify  │ │
│                    └──────────────┘ └─────────┘ │
└─────────────────────────────────────────────────┘
```

### 1. Sidekick delegation

The frontier model stays in charge of judgment. A cheaper model handles the mechanical load.

This is not a single-prompt router that picks one model for the whole task. Fusion delegates **dynamically** — it decides per-step which agent should do what:

- **Hand off slow verification.** Sidekick runs the 90-second Playwright suite while fusion moves on to the next decision. Cost drops 60%+ on test-heavy tasks, zero quality loss.
- **Take back judgment-heavy work.** When sidekick hits a decision point — API shape, error semantics, cross-module boundary — fusion takes that milestone back instead of letting the cheap model guess.
- **Send targeted follow-ups.** Sidekick found something unexpected? Fusion sends it back with a focused question instead of re-reading the code itself.

Both agents keep their own persistent, cached context. Delegation doesn't trigger cache misses — that's the key difference from "ask another model" tools.

### 2. Independent reviewer

A third agent runs as a read-only subagent. It never edits files. Fusion consults it in two scenarios:

**Before implementation** — when the change is high-risk:
- shared API contracts, public interfaces, cross-subsystem boundaries
- lifecycle, concurrency, persistence, schema semantics
- security, credentials, privacy, production-critical paths
- the same approach has failed repeatedly
- confidence is still low after local verification

**Before delivery** — for any non-trivial change, reviewer does a code review pass: correctness, completeness, regressions, architectural coherence. For high-risk changes, it also performs **adversarial review** — probing the diff from an attacker's perspective:

- *What if this input is 50MB instead of 5KB?*
- *What if a timestamp comes from the future?*
- *What if a background worker gets killed mid-task and retries?*
- *What if two users submit the same request simultaneously?*

Each finding traces the full path: entry point → processing → storage → output → side effects. This is the kind of review that catches production incidents before they happen, not after.

### 3. Goal mode with auto-continue

Every delegated task gets a goal: one sentence for the objective, a short plan for background and approach. The goal persists to disk and survives two things that normally kill task momentum:

**Context compaction.** When OpenCode compacts the session (which happens automatically on long tasks), only subagent `task_id`s are preserved in the recovery context. The goal itself is recovered through tool-result history and the `get_goal` tool, keeping goal visibility consistent with the todo list.

**Process restart.** Goals are stored in a local JSON file. Kill the process, reboot your machine, come back tomorrow — `opencode run --continue` picks up the same session ID, and the goal is still there.

Goals **auto-continue** until explicitly closed. The agent doesn't stop after one step and wait for you to type "continue". It keeps moving: updates milestones via the built-in todo tool, delegates the next chunk to sidekick, reviews the result, and only closes the goal when the work is verified complete or a concrete blocker makes further progress impossible.

### 4. First principles + adversarial review

Two thinking modes are baked into the agent prompts — not as optional flags, but as default behavior:

**First principles.** When a bug fix, architecture decision, or approach choice is on the table, agents reason from fundamental facts and constraints instead of reaching for the closest pattern in training data. This is the difference between:

- *Symptom fix:* "The OpenAI feed is broken, let me fix the fetcher." (the bug comes back next week)
- *Root cause fix:* "The traffic routing layer has a latent failure mode. The fetcher was just the first victim. Let me fix the routing." (the bug class is eliminated)

**Adversarial review.** For changes that touch untrusted input, persistence, external content, or background workers, reviewer walks through each input path and asks: what happens if this is extreme, malformed, or hostile? Oversized payloads, future-dated data, infinite loops, race conditions, injection paths — traced from entry to impact, with a named fix for each finding.

## What this is good for

- **Long tasks** that need to survive context compaction and process restarts without losing the plot
- **Complex debugging** where the obvious fix treats the symptom, not the disease
- **Multi-stage refactors** with judgment-heavy decisions that shouldn't be delegated to a cheap model
- **High-risk changes** that benefit from an independent review before they ship
- **Open-ended work** — performance optimization, root-cause investigation, architecture cleanup — where the best next step can't be planned upfront and a reviewer loop helps converge

If you just want a lightweight assistant for quick one-off chats, this is probably more than you need.

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

| Option | Agent | Description |
|--------|-------|-------------|
| `model` | sidekick, reviewer | Model in `provider/model-id` format |
| `variant` | sidekick, reviewer | Reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `options` | sidekick, reviewer | Provider-specific options |

If `model` is omitted, the agent inherits the session's current model. If you do not want Fusion as your default agent, omit `default_agent` and select the `fusion` agent manually when needed.

## License

[MIT](LICENSE)
