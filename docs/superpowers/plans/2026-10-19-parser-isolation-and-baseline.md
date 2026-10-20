# Parser isolation and baseline fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (P) Bound the time the AsyncAPI parser (and the YAML read of an imported document) can block the Node server: run them in a warm child process with a hard timeout, so a hostile ~1 MiB document costs one killed child and a clean "too complex" error instead of ~10 s of a blocked event loop. (B) Fix, skip with a capability guard, or delete the 8 long-standing baseline test failures (`db-emitter-parity` x4, `schemas-tab` x3, `e2e-critical-flows` x1), all of which are the DB DDL targets (Spanner, Postgres, BigQuery).

**Architecture:** (P) A server-only runner (`src/lib/event-specs/validation/parser-runner.ts`) owns a small pool of long-lived child processes; each runs a plain CommonJS worker bundled with esbuild (`--packages=external`, the same technique `package.json` already uses for `db:*` scripts) and answers JSON jobs (`validate` a document, `parseSource` a text). The runner enforces a per-job timeout (kill + respawn), a queue limit, memory limits and clean shutdown. `AsyncApiParserValidator.validate` and the importer call the runner instead of the parser. `next.config.ts` ships the worker and its packages in the `output: "standalone"` build. (B) `@typespec/db` (a `file:` dependency on the sibling repo whose `packages/db` has lost its source) is vendored from a complete copy; the generated DB sources and the emitter invocations are repaired as far as this repo can; anything that needs a change in the sibling repo is reported, not edited.

**Tech Stack:** Node 26 child_process, esbuild (already a devDependency), Next 16 (`output: "standalone"`, `serverExternalPackages`, `outputFileTracingIncludes`), `@asyncapi/parser` 3.6.4, TypeSpec 1.10, Vitest, Playwright.

**Spec:** `docs/events/REVIEW.md` §6 gap 1 (the parser cannot be interrupted: ~10 s synchronous cost, YAML error floods 5-9 s at 1 MiB), user decisions 2026-10-19: "yes" to the child-process isolation and "yes" to fixing or deleting the baseline failures.

## Global Constraints

- No new dependencies and never `npm install` (registry policy: 403 for some packages). `esbuild` is already installed. Editing `package.json` / `package-lock.json` by hand is allowed where a brief says so.
- Never throw out of a service; user-visible errors are plain text, no stack traces, no server paths (see `isParserCrashDiagnostic`).
- Commit messages are normal; NO `Co-Authored-By`, NO "Generated with" (user rule).
- Do not touch the user's uncommitted files in the main checkout (`.gitignore`, `.mcp.json`, `AGENTS.md`, `_bmad-output/**`, `.ignore`, `docs/superpowers/plans/2026-10-15-fix-events-bugs.md`) and do NOT modify the sibling repository `/Users/jsenjaliya/src/my/typespec` (it holds the user's work in progress): reading and copying FROM it is allowed.
- Tools: Gortex MCP is down; the user approved Read/Grep/Glob/Bash as the fallback for the events work (memory `events-asyncapi-program.md` line 26; re-confirmed 2026-10-19).

## Review Focus

- The event loop of the server stays responsive (measured lag < 200 ms) while a hostile document is being validated, and the document is cut at the timeout with a clean error.
- A killed or crashed child never leaves an orphan process, never hangs a request, and is replaced; the next request works.
- The isolation works in EVERY way the app is run: vitest, `npm run dev` (Turbopack), `next build` + `next start`, and the standalone output (`node .next/standalone/server.js`).
- Normal documents behave exactly as before (same diagnostics, same results), at a small latency cost.
- The baseline tests are either really fixed, or skipped by a capability probe with an honest reason, or deleted with a reason; none is silently weakened.

---

### Task P: Parser isolation in a child process
**Files:** see `WP-P-brief.md` in the ledger directory.

### Task B: The 8 baseline failures
**Files:** see `WP-B-brief.md` in the ledger directory.
