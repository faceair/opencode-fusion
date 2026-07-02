# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/faceair/opencode-fusion/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/faceair/opencode-fusion/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/faceair/opencode-fusion/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/faceair/opencode-fusion/releases/tag/v0.1.0
