# Tenant storage and onboarding

Status: implemented. Validation evidence: [GitOps verification](../../testing/gitops-storage-verification.md).

Each tenant selects `database` or `git` as the canonical content backend. Database tenants keep ordinary authoring. Git tenants use private change sets and GitHub PRs; the application database remains the identity/configuration store and read projection. `DB_PROVIDER` still selects the shared physical database for the deployment.

Existing nullable tenant modes are initialized once from the legacy deployment default. New tenants explicitly default to database storage. A Git binding alone never changes a tenant's source of truth or permits indexing over a database tenant's content.

Enforcement lives at the database row boundary so nested/bulk writes, raw SQL, reference children and FK cascades receive the same tenant decision. Projection rebuilding receives a transaction-local capability, cleared on commit/rollback. Storage cutover is serialized against content writes through tenant row locks.

Settings supports reading the active tenant's storage, configuring its Git repository/folder and ordered product workflow, and creating a new tenant with either backend. Tenant administrators manage their own storage; only platform administrators create tenants or configure the shared GitHub App. Git setup exposes repository, GitHub identity, bootstrap PR and index readiness. Contracts stay readable while setup is pending; direct writes are blocked after entering Git mode. A return to database mode is refused once Git source history or published change sets exist; exporting Git back to database remains an explicit migration.

Tenant repository folders must not overlap another tenant's reserved root. Settings and the portable configuration command share the same guards. Existing unrelated environment/field-editor changes are preserved.

Acceptance: real migrated database tests for mixed tenant isolation, nested/bulk/raw writes and projection permissions; onboarding/RBAC and root isolation tests; component and desktop/mobile browser checks; TypeScript, lint and production build. Commit only this task's changes.
