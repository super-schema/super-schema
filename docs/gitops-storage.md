# GitHub as the storage backend

GitOps storage is available at **Admin → Settings → GitOps storage**, or `/gitops`. With `CONTENT_STORAGE=git`, canonical YAML in the bound GitHub repository is the source of truth. PGlite/PostgreSQL retains identity, configuration, private drafts, job state and a rebuildable read projection. Existing schema, version, lineage and generated-schema screens read that projection.

Authors use the GitOps workspace's canonical YAML editor. **Save private draft → Submit PR → GitHub review/merge → synchronization** is the content lifecycle. Saving an entry already in review updates the same PR. Existing direct database content writers are blocked in Git mode; the dashboard banner links to GitOps authoring.

## Activate

Use the supported Node version (`>=22.22.2 <25`) and the normal TypeSpec sibling-package build prerequisites in [developer-guide.md](developer-guide.md).

1. Back up the application database. For PGlite, stop every process using its directory before migration or backup. Run `npm run db:generate` and `npm run db:deploy` with the intended database settings. The additive GitOps migration is `20261112000000_gitops_storage`; building the app does not migrate it.
2. Keep `CONTENT_STORAGE=database` while configuring the GitHub App, tenant binding and product workflows at `/gitops`. Set the public origin in `AUTH_URL` (or `NEXTAUTH_URL`) and a stable `SECRETS_ENCRYPTION_KEY`. Credentials are encrypted and never returned to the settings form.
3. Register/install a GitHub App on the storage repository. Use callback `{AUTH_URL}/api/gitops/callback`, webhook `{AUTH_URL}/api/gitops/webhook`, and the same webhook secret in GitHub and Super Schema. Configure App ID, PEM private key, client ID and client secret in the platform settings. Source PRs use the separately linked human account; indexing and artifact PRs use installation credentials. This is separate from the application's sign-in provider. GitHub documents the [App user authorization and PKCE flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
4. Give the App repository **Contents: read/write**, **Pull requests: read/write**, **Checks: read**, **Commit statuses: read**, and **Metadata: read**. Subscribe to push, pull request, pull request review, check run/check suite and installation changes. Install it on the repository and enter that installation ID. Repository permissions and branch protection still apply to the linked author.
5. Select the tenant repository URL, existing canonical branch and root folder. Verify/save the binding. Use **Connect GitHub** for every author. The repository must have an initial commit and the configured branches; Super Schema does not create repositories or environment branches.
6. Select each product. Configure its ordered environments, existing branches and owners; the first environment uses the canonical source branch. Tenant deployment settings provide the available environment names. Saving the binding creates a **GitOps · same repository** deployment workflow automatically; an empty target override list uses the enabled schema targets on this repository.
7. Use **Initialize / export product**, submit the bootstrap PR and merge it. Bootstrap carries the complete stored entity/event version history, hierarchy and shared definitions. Pause database authoring during this cutover.
8. Set `CONTENT_STORAGE=git`, restart the app, and run the worker below. Use **Sync now**. Check `SYNCED`, repository entries, schema history and generated artifacts before resuming authoring.

```dotenv
CONTENT_STORAGE=git
GITOPS_WORKER_TOKEN=<server-only random secret of at least 32 characters>
GITOPS_WORKER_URL=http://localhost:3000/api/gitops/process
```

```bash
npm run gitops:worker
# One drain for a scheduler or an operational check:
npm run gitops:worker -- --once
```

Keep the worker running alongside the web application. Signed webhooks enqueue jobs; polling reconciles enabled bindings every five minutes. Manual synchronization also queues a job. Jobs have leases, retries and visible failure state. No GitHub calls occur while loading the workspace.

## Repository root and layout

An empty root owns the repository root. `contracts/catalog` owns only that folder. Every source, artifact, owner fragment and environment write is confined to the configured root. Application operations close PRs when discarded; they do not delete repositories or existing branches.

```text
<root>/tenant.yaml
<root>/domains/<domain>/domain.yaml
<root>/domains/<domain>/products/<product>/product.yaml
<root>/domains/<domain>/products/<product>/entities/<entity>/1.0.0_snapshot/entity.yaml
<root>/domains/<domain>/products/<product>/events/<event>/1.0.0_snapshot/event.yaml
<root>/artifacts/<product>/<object>/<version>/<target>/...
<root>/environments/<product>/<environment>.json
```

Shared definitions use their tenant/domain scope and kind collection. Manifests carry stable identities; product manifests also carry owners and workflow settings. IDs survive renames. Released files are byte immutable; a rename moves their bytes unchanged. `1.0.0_snapshot` becomes `1.0.0` through a promotion PR. New snapshots must exceed the last release and meet the semantic change classification.

The canonical schema supports entities, events, traits, enums, scalars, unions, services, interfaces, models and decorators. Frozen version rows and reference pins travel with the source; generated schema caches do not. Hand-edited YAML is validated before the read projection changes. Invalid files appear as index errors while the last successful projection remains readable.

## Review, release and environments

- Open an entry to inspect its source. Authors can save private drafts, create entries and submit a product change set. Draft content remains author-only in the application, including unsent edits to an existing PR; other readers see its GitHub link and status. GitHub PR links, checks, review state, conflicts and merge state are visible in the workspace.
- If the source or PR branch changes externally, use **Refresh draft**, inspect structured conflicts and save the resolved document before submitting again. A stale branch is never force pushed.
- **Promote version** prepares a separate release PR. Released dependencies must already exist before a dependent release can pass validation. A tombstone retires a snapshot; released history cannot be removed.
- After source merges, the worker renders real TypeSpec/AsyncAPI artifacts from the frozen canonical commit, opens target PRs and fills the existing Schemas UI caches. Snapshot deliveries update a rolling PR; release deliveries use version-specific PRs. Additional target bindings can select another approved repository and installation.
- **Promote to staging/QA/production** follows the product's configured order on the same repository. Each PR copies the product and shared canonical tree and records the exact canonical commit in an environment manifest. The previous environment must be merged for that exact source commit. Snapshot folders are removed when replaced by releases. Unrelated repository/artifact-only commits do not invalidate the product's readiness.
- Environment promotion records schema readiness. Runtime deployment and registry publication remain the repository's own automation. GitHub branch protection is the authority for required approvals/checks; the UI's review status is a summary.

Changing indexed source URL, root or source branch requires an explicit repository migration. Configure product repository overrides before bootstrapping. Workflow settings edited after cutover become changes to `product.yaml` and take effect after their PR merges.

## Ownership and CI

Repository-root mode opens a PR updating the managed block in `.github/CODEOWNERS`, preserving unrelated entries. Folder mode opens a PR for `<root>/.superschema/CODEOWNERS.fragment`; a repository administrator integrates it into the repository's recognized CODEOWNERS file. GitHub only enforces owners when the repository's rules require them.

The bundled validation action needs no application credentials or dependency install. Reference this implementation by an approved immutable revision, or vendor the action into the contract repository. A repository administrator installs the workflow outside the storage root when folder ownership is used.

```yaml
name: Validate schema contracts
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: super-schema/super-schema/.github/actions/gitops-validate@<approved-revision>
        with:
          root: contracts/catalog # use '' for repository-root mode
          base-ref: ${{ github.event.pull_request.base.sha }}
```

Local equivalent from this application checkout:

```bash
npm run gitops:build-validator
npm run gitops:validate -- --repo /path/to/contracts --root contracts/catalog --base-ref <base-commit>
```

The action also derives the base SHA from the pull-request event if `base-ref` is omitted. Local invocations without a base ref validate the current tree but cannot compare prior released bytes.

## Recovery and operations

Use **Rebuild projection from Git** to reapply validated canonical content without creating duplicate versions or changing stable version IDs. The database is still required for users, bindings, private drafts, encrypted credentials and delivery/job receipts; back it up. Rebuilding content is not a substitute for restoring those operational records.

Use the freshness/error banner and failed-job retry controls to recover from invalid YAML, revoked installation access, expired user authorization or transient GitHub failures. App credential changes require authors to reconnect. Never share a live PGlite directory between web and maintenance processes; the worker calls the web endpoint and does not open that directory itself.

See [the verification record](testing/gitops-storage-verification.md) for executed tests and the hosted proof. Live GitHub App installation, callback and webhook ingress require operator credentials and a reachable deployment; they were not exercised by the token-backed hosted proof.
