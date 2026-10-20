# Events open issues — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the small open issues left after the AsyncAPI importer and JSON validation round (`docs/events/REVIEW.md` §6): refuse keys the AsyncAPI parser cannot read (`hasOwnProperty`) at one choke point with a clear message and no stack trace, weigh the sampler's `required` walk, neutralise catastrophic regexes before a schema reaches the editor, fix the shared error-text join, and stop two Playwright specs from flaking in parallel runs.

**Architecture:** One shared constant of parser-unsafe keys (`src/lib/event-specs/own-property.ts`) is enforced in four places: the validator that every emitted document passes through (a guard that walks the finished document, plus sanitising of any parser crash diagnostic), the importer, the builder's key and entity-field editors (early feedback), and a sweep test over `Object.prototype` names through the real parser. The other items are independent one-file changes.

**Tech Stack:** TypeScript strict, Vitest, React Testing Library, Playwright, `@asyncapi/parser` 3.6.4 (inside it `@stoplight/json-ref-resolver` 3.1.6, whose crawler calls `target.hasOwnProperty(key)` on every object: a key named `hasOwnProperty` shadows it and throws), `openapi-sampler`, `codemirror-json-schema`.

**Spec:** `docs/events/REVIEW.md` §6 (gaps 1 and 3 and the list in `memory`), user decision 2026-10-19: **refuse rather than patch** the parser (it is a stable release outside our control, and published versions are insert-only, so a document the official parser cannot read must never be published).

## Global Constraints

- No new dependencies, never `npm install` (the registry returns 403 for some packages by security policy).
- A rejected document is refused with an error Result/diagnostic: never throw, never show an exception text, a stack trace or a server path to a user.
- Messages end with a full stop; user-facing labels live in the existing label files (`src/features/events/builder/labels.ts` for the builder).
- Commit messages are normal; NO `Co-Authored-By`, NO "Generated with" trailer (user rule).
- Do not touch the user's uncommitted files in the main checkout (`.gitignore`, `.mcp.json`, `AGENTS.md`, `_bmad-output/**`, `.ignore`, `docs/superpowers/plans/2026-10-15-fix-events-bugs.md`).

## Review Focus

- A key named `hasOwnProperty` anywhere in a document (channel/message/server/operation keys, JSON Schema property names from an entity field, bindings, `x-` extension keys, server variables, tags) must produce ONE clear error naming the key and its JSON pointer, never the parser's crash text.
- The same key authored in an entity field must be caught when the field is named, not only at emit.
- A parser crash for ANY reason must never reach the user as text with a stack or an absolute path.
- A long `required` list reused through many `$ref`s must not freeze "Generate from payload".
- A tenant-authored `pattern` such as `^(a+)+$` must never be handed to the browser's validator where it can freeze the tab on a short non-matching example.
- Everything that passed before (plain keys, normal patterns, the importer's refusals) must still pass.

---

### Task H1: Parser-unsafe keys — one constant, one choke point, no stack traces

**Files:** `src/lib/event-specs/own-property.ts`, `src/lib/event-specs/validation/asyncapi-parser-validator.ts`, `src/lib/events/import/source.ts`, `src/features/events/builder/{controls.tsx,security-schemes.ts}` (builder key editors), the entity field-name validation (find it), tests under `tests/unit/lib/event-specs`, `tests/unit/lib/events`, `tests/unit/components/events`, `tests/integration` as needed. Full requirements: `WP-H1-brief.md` in the ledger directory.

### Task H2: Small hardening items

**Files:** `src/lib/events/example-from-schema.ts`, `src/services/events/pin-json-schema.service.ts` (+ a new pure helper for the regex filter), `src/types/action-result.ts`, `tests/e2e/navigation.spec.ts`, `tests/e2e/events-external-refs.spec.ts`, their tests. Full requirements: `WP-H2-brief.md` in the ledger directory.
