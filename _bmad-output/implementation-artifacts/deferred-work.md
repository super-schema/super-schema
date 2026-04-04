# Deferred Work

## Deferred from: code review of 1-1-project-scaffolding (2026-04-03)

- **next-auth uses beta version with caret range** — `next-auth@^5.0.0-beta.30` is specified per story requirements. Monitor for stable v5 release and pin to stable when available. Caret range on beta may auto-upgrade to newer betas with breaking changes.

## Deferred from: Epic 2 Stories 2.5-2.10 (2026-04-03)

Core functionality implemented. Advanced features deferred:

- **2.5**: ValidationIndicator SVG ring + progress bar + canEmit() done. Ghost text suggestions in amber state deferred.
- **2.6**: Type/classification/field-name suggestion engines done (with tests). Ghost text UI in field row and dismissal tracking deferred.
- **2.7**: Field types organized by category. Array/Map/Object nested type picker UIs and inline sub-field editor deferred.
- **2.8**: Status transition validation + isReadOnly() done. Deprecation form, retirement banner, and sidebar strikethrough deferred.
- **2.9**: Command palette with Cmd+K done. Global keyboard shortcuts (Cmd+S, Cmd+N, Cmd+E, slash commands) deferred.
- **2.10**: React Flow lineage graph with custom entity nodes done. Dagre auto-layout, node click popover, domain filter deferred.

## Deferred from: code review of 2-11-typespec-field-studio (2026-04-03)

- **W1: No authorization check on field mutations** — Any authenticated user can update/delete any field by guessing the field ID. Pre-existing in actions.ts. RBAC authorization is story 8-1.
- **W2: No input sanitization on arbitrary decorator keys** — Only `decorators.typespec` is validated; other top-level keys in the decorators JSONB pass through unchecked. Pre-existing pattern.
- **W3: Inconsistent null-check operators in addFieldAction** — Mixed use of `!= null`, `!== undefined`, and truthy checks creates confusing semantics for optional field creation parameters. Pre-existing.
- **W4: domainPolicy unsafe type assertion on server** — `entity.domain` cast to `{ policyTemplate?: Record<string, unknown> }` without validation. If JSONB contains a non-object, downstream code throws at runtime. Pre-existing pattern across all page.tsx files.
- **D2: Versioning panel always visible instead of conditional (AC7)** — Panel should only render when domain has @versioned. Version data loading belongs to story 4-1.
- **D3: @doc markdown toolbar & rendered preview (AC6)** — Spec requires formatting toolbar and rendered markdown preview. Current edit/preview toggle is functional but shows raw text. Polish item.
