# GitOps storage implementation

Status: implemented; final validation is recorded in [the verification record](../../testing/gitops-storage-verification.md). Extends the approved 2026-11-02 design and its phase-1 implementation.

## Accepted requirement (2026-11-10)

Enabling GitOps supplies a default Git workflow on the bound GitHub repository. Product settings define the ordered environment lifecycle; names and branches are configurable, including development, staging, QA and production. Moving to the next environment opens a reviewable PR on that same repository. GitHub review and merge are the approval gates. No application deployment is implied by a merged schema PR.

Storage root: the binding may own the repository root (`basePath: ""`) or one folder. Every source, artifact and environment write must stay under that root. In folder mode CODEOWNERS and validation integration are generated as local setup fragments; GitHub repository-level files outside the root are never changed implicitly.

## Implementation and acceptance gates

1. Git provider, encrypted GitHub App and separate user linking; real remote verification and user-authored source PRs.
2. Lossless canonical documents, full-history bootstrap, reference/release validation and rebuildable tenant-scoped projection.
3. Private product change sets, atomic commits, updates to the same PR, stale-base detection and structured conflict resolution.
4. Signed and deduplicated webhooks, durable leased jobs, polling/manual sync and visible freshness/index errors.
5. Promotion PRs and generated CODEOWNERS; released documents stay immutable.
6. Automatic same-repository workflow, product environment stages, target delivery with provenance and rolling snapshot PRs.
7. Settings/authoring/status UI, reusable validation action, unit and migrated-database integration tests, hosted GitHub protocol verification and an operating guide.

Database mode retains its existing behavior. In Git mode published content tables are read projections; content writes require the canonical authoring path or the internal projection scope. Existing outbound deployment settings and unrelated working-tree edits are preserved.

Validation must distinguish automated protocol/database/UI coverage from hosted repository acceptance. Do not mark an untested milestone complete.
