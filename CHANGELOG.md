# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Fusion/Sidekick prompts aligned with the current bounded-responsibility
  contract.** Fusion owns global decisions and the final gate while Sidekick
  implements settled, self-contained responsibilities with one live writer per
  file and explicit session reuse.

### Removed

- **Goal mode.** `get_goal`, `set_goal`, `update_goal` tools, goal state
  persistence (`goal.ts`), auto-continue (`autocontinue.ts`), the
  `experimental.compaction.autocontinue` hook, and the idle-event continuation
  loop have been removed. The plugin no longer tracks goals or auto-continues
  sessions.
- **todowrite evidence gate.** The `accept.ts` module, `tool.definition` and
  `tool.execute.before` hooks that enforced an `evidence` field on
  `todowrite` completions have been removed.
- **Reviewer agent.** The plugin now registers only Fusion and Sidekick;
  reviewer configuration, prompts, exports, permissions, tests, and
  documentation have been removed.

## [0.4.0] - 2026-07-05

### Changed

- **Fusion prompt refactored to principle-driven.** Replaced rigid workflows
  (Final Gate, reviewer loop with continue/pivot/stop/blocked labels,
  first-principles as a separate section) with concise principles that let
  the model exercise judgment. Role boundaries reframed from "read vs not-read"
  to "judgment vs execution" — fusion reads code when a decision requires it,
  delegates mechanical writing to sidekick. (`84638fc`, `c6377aa`, `3c82e6a`,
  `9bf2820`)
- **Three dispatch patterns, not a rigid pipeline.** Gathering facts / Executing
  changes / Verification replace the fixed two-phase Discovery → Implementation
  flow. Reviewer can now review code diffs to surface blind spots, not just
  provide adversarial judgment. (`3c82e6a`)
- **Final Gate merged into Verification.** Final Gate section removed — its
  checklist (ownership/lifecycle/state/API contracts/invariants) was arbitrary
  and not generalizable. Unique content (structural assumptions check, gap
  handling, user escalation) absorbed into the Verification bullet. (`9bf2820`)
- **Reuse + parallel merged into dispatch strategy.** Reuse principle moved
  from the intro tool-mechanics paragraph into How You Work, making reuse and
  parallel one decision space. Intro paragraph is now purely tool mechanics.
  Redundant merge/no-merge parallel instructions removed. (`9bf2820`)
- **When You Act Yourself simplified.** Five justifications rewritten from a
  permission system to "delegation is counterproductive — state why". (`3c82e6a`)
- **READMEs rewritten.** Updated to reflect current prompt practices: removed
  Final Gate, reviewer loop, and first-principles section descriptions; reframed
  role boundaries; added `serviceTier` to options table. (`57fc620`)

### Added

- **`last_used_at` in `get_task_ids`.** Entries now include the Unix ms
  timestamp of the last dispatch message, enabling time-based sorting for
  handle recovery after compaction. (`ff8a55b`)

## [0.3.0] - 2026-07-04

### Added

- **Parallel investigation mode.** Fusion can now dispatch sidekick with
  `background: true` to investigate independently while fusion pursues its own
  line, then merge evidence and cross-check for contradictions. Reviewer can be
  consulted in parallel for independent hypotheses. (`6ebe50b`)
- **`get_task_ids` tool.** Deterministic fallback that scans message history and
  returns all subagent `task_id`s grouped by type, newest-first, with the last
  dispatch description. Used to recover task_ids after compaction when the
  pre-compaction injection is insufficient. (`2140940`, `f691875`)
- **`session_history` tool.** Replaces `recall_history` with a richer API:
  `operation: "search"` (query, kind, tool_name, role, time_after/time_before,
  limit, offset) and `operation: "around"` (anchor message_id with before/after
  context window). (`a9812be`)
- **Auto-continue react cap.** Goal state now tracks a `react` counter;
  auto-continue marks the goal unmet and warns when `MAX_GOAL_REACT=12` is
  exceeded. Goal state migrated v6 → v7. (`a9812be`)
- **Image interpretation delegation.** Fusion prompt now delegates image
  interpretation to sidekick when fusion cannot directly view images.
  (`f05e928`)
- **Evidence anchoring and stuck-state escalation.** Fusion prompt now enforces
  grounding claims in verifiable evidence and explicit escalation when stuck
  (revising the same point, going in circles). (`c0deb66`)
- **Full-scope implementation enforcement.** Fusion prompt now requires
  enumerating required behaviors as a checklist when dispatching sidekick, and
  reading changed code before accepting completion. (`7313408`)

### Changed

- **Subagent tool surface shrunk.** Goal and task_id tools (`get_goal`,
  `set_goal`, `update_goal`, `get_task_ids`) are now denied for sidekick and
  reviewer via per-agent permissions. (`5ea926e`)
- **READMEs rewritten.** Install-first structure, plain language, sidekick
  diagram, cost data; fusion.md reviewer loop and milestone→todo refactored.
  (`b96583d`, `32c4116`)
- **task_id passing clarified in prompts.** `task_id` must be passed via the
  `task` tool's parameter field, not embedded in prompt prose. (`e969bb7`)

### Removed

- **Post-compaction task_id injection.** The `session.compacted` recovery logic,
  `activeCompactions` coordination, and `sentGoalContinuation` tracking removed
  in favor of pre-compaction context injection via
  `experimental.session.compacting`. (`2140940`, `92f64a9`)

### Fixed

- **Duplicate continuation after compact.** Promise coordination prevented the
  post-compaction recovery prompt from firing alongside auto-continue.
  (`0b804ea`)
- **Goal tools visible to subagents.** Server now uses `permission` instead of
  the deprecated `tools` field to hide goal tools from subagents. (`a083316`)

## [0.2.1] - 2026-07-03

### Changed

- **Compaction task_id recovery moved post-compaction.** task_id injection now
  runs on the `session.compacted` event (after summarization completes) instead
  of the pre-compaction `experimental.session.compacting` hook. Recovery prompts
  are sent as user messages extracted from pre-compaction history; when an active
  goal exists, the recovery prompt doubles as the continuation prompt and
  auto-continue skips that cycle to avoid duplicates. (`8998b75`)
- **Goal module slimmed.** `compactionContext` moved from `goal.ts` to `taskid.ts`
  (co-located with task_id extraction); `systemReminder` and the
  `experimental.chat.system.transform` hook removed; `reserveContinuation`
  throttle and `autoTurns` tracking removed. goal.ts now only contains goal CRUD
  and `continuationPrompt`. (`8998b75`, `3f8cfc6`)
- **KISS principle refined.** Fusion and sidekick prompts now explicitly
  discourage over-defensive code. (`160617d`)

### Fixed

- **Prompt cache prefix instability.** Dynamic goal fields were injected into the
  system prompt every turn, busting the prompt cache prefix. Goal state is now
  surfaced via tool results and recovery prompts instead of the system prompt.
  (`73322e4`)
- **task_id passing clarified.** Fusion prompt now specifies `task_id` must be
  passed via the `task` tool's parameter field, not embedded in the prompt text.
  (`ccb70c0`)

## [0.2.0] - 2026-07-02

### Added

- **Session recall tool.** New `recall_history` tool lets fusion recover prior
  messages after context compaction, with keyword query, role filter, offset
  paging, and optional tool-output inclusion. (`ccdc3b4`, `a8aff1b`)
- **Goal mode.** `set_goal` / `get_goal` / `update_goal` tools track objectives
  and milestones across turns, compaction, and auto-continue. (`dc0d451`)
- **Auto-continue.** New `autocontinue` module resumes the session after
  sidekick/reviewer task completion without requiring user input. (`dc0d451`)
- **Task ID extraction.** New `taskid` module parses subagent `task_id` from
  task tool output so fusion can reuse sidekick/reviewer sessions across
  follow-ups instead of starting fresh. (`2a4f07c`)
- **E2E test harness.** Real OpenCode runtime coverage with a fake-LLM harness
  and a replay test based on session `ses_0e0986e6`. (`16d10d8`)
- Unit tests for autocontinue, goal, recall, and taskid modules.

### Changed

- **Fusion prompt overhaul.** Single-source KISS definition, self-execute
  exceptions narrowed to four falsifiable conditions with a declaration
  requirement, Stop Rules consolidated into a routing table, Reviewer Decision
  Label Mapping, Sidekick labeled objection handling, and an Output skeleton.
  (`dc0d451`, `c092a90`)
- **Sidekick prompt tightened.** Aligned "smallest coherent change" terminology
  with fusion, removed redundant ask-back rules, tightened concurrent edit
  handling, distinguished prove-absence vs. locate empty results, added labeled
  objection mechanism. (`c092a90`)
- **Reviewer prompt tightened.** Folded Project Model and Evidence sections
  into Review Lenses, merged first-principles + contradictions into Review
  Stance, added Adversarial Review self-trigger, specified read-only command
  boundary. (`c092a90`)

### Fixed

- **Subagent context lost across compaction.** Sidekick/reviewer `task_id` is
  now extracted from session messages and injected into compaction context, so
  sessions are reused instead of restarted after compaction. (`d063a2f`)
- **Sidekick session reuse not enforced.** Job type or read/write constraint
  changes are now treated as follow-up info rather than a reason to open a new
  sidekick session. (`2a4f07c`)
- **Auto-continue fired after Esc abort.** The idle event triggered before
  abort completed, with no `finish` or `error` field on the message; detection
  now keys off missing `finish`, covering all abort timing windows. Removed
  redundant error/metadata detection paths (autocontinue 95 → 65 lines).
  (`2a4f07c`)

## [0.1.0] - 2026-07-01

### Added

- Initial release: multi-model fusion plugin for OpenCode.
- Three-agent architecture — fusion (frontier), sidekick (cheap, execute),
  reviewer (read-only, adversarial) — with dynamic per-step delegation.
- Sidekick delegation, reviewer loop, and goal-mode workflow orchestration.
- npm package `@faceair/opencode-fusion` with `bun` build and test pipeline.

[Unreleased]: https://github.com/faceair/opencode-fusion/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/faceair/opencode-fusion/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/faceair/opencode-fusion/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/faceair/opencode-fusion/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/faceair/opencode-fusion/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/faceair/opencode-fusion/releases/tag/v0.1.0
