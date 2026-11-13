# GitHub as the storage backend

Configure storage at **Admin → Settings → Tenant storage** (`/admin/settings/storage`). Each tenant independently selects **database** or **GitHub**. A Git tenant uses canonical YAML in its bound repository as its source of truth; a database tenant keeps direct authoring and its content is never overwritten by Git synchronization. The GitOps authoring workspace is at **Admin → Workflows → GitOps** (`/admin/workflows/gitops`; `/gitops` redirects there). PGlite/PostgreSQL retains identity, configuration, private drafts, job state and a rebuildable read projection. Existing schema, version, lineage and generated-schema screens read that projection.

Authors use the GitOps workspace's canonical YAML editor. **Save private draft → Submit PR → GitHub review/merge → synchronization** is the content lifecycle. Saving an entry already in review updates the same PR. Existing direct database content writers are blocked in Git mode; the dashboard banner links to GitOps authoring.

## Copyable configuration

Copy the organization-neutral template and edit its blank installation-specific fields:

```bash
cp gitops.config.example.yaml gitops.config.yaml
npm run gitops:config -- validate
```

`gitops.config.yaml` is gitignored. The application, database tools and GitOps worker read it on startup; use `GITOPS_CONFIG_FILE` for another path. Restart processes after changing runtime values. Existing environment variables, including values loaded from `.env.local`/`.env`, take precedence over the YAML runtime settings. With no file, existing behavior is unchanged. Set `GITOPS_CONFIG_FILE=""` to disable automatic discovery for an isolated process. Local YAML files and PEM keys are excluded from Docker build contexts; mount the configuration at runtime when using an image. `application.contentStorage` / `CONTENT_STORAGE` is only a one-time default for legacy tenants whose mode has not been initialized. New tenants default to database storage. Change the selected tenant using Settings or explicit `scope.contentStorage` in the apply command; restarting with a different environment value does not change an explicit tenant choice.

The file controls the application origin and legacy storage default, per-tenant storage selection, database provider/location, GitHub host/App references, repository/root/source branch, tenant/product selection, owners, ordered environment mappings, artifact targets, product overrides and worker intervals/batch size. `github.app.name` is a registration suggestion; App creation, installation and human authorization still happen on GitHub. Callback and worker URLs derive from the effective application origin; an explicit worker URL can override that default.

Required before applying: `repository.url`, `repository.installationId`, `scope.tenantId` and `scope.operatorEmail` (an existing enabled application account). `scope.productIds: []` selects existing products in that tenant; list IDs to limit the product workflows receiving the shared defaults. The tenant binding also makes the default workflow available to its other products. Product-specific owners, stages, targets and repository overrides can be set in `products`. Existing product source bindings are preserved when no source override is provided.

Set `scope.contentStorage: git` to activate Git for that tenant before creating its initial import PR, or use `database` for private content. Omitting this field preserves the current tenant choice. This field is applied explicitly through the same tenant-administrator guard as Settings. Initial workflow configuration is editable before bootstrap; once an import is in progress, merge or discard it before changing that configuration. Newly bootstrapped products inherit the saved tenant workflow defaults.

An App must already be configured in the UI, or supply both App IDs and the referenced secret environment variables. `github.app.privateKeyFile` accepts a PEM file relative to the YAML file; otherwise `github.app.privateKeyEnv` names the environment variable containing the PEM. Client/webhook secrets and the worker token are also environment references; secret values are not stored in YAML or printed by validation. Keep an existing encryption key unchanged when credentials already exist.

Validation is offline and opens no database. Applying is explicit:

```bash
# Migrate first. For PGlite, stop the web application before either maintenance command.
npm run db:deploy
npm run gitops:config -- apply
# For another configuration path:
npm run gitops:config -- validate --config ./deployment/gitops.yaml
GITOPS_CONFIG_FILE=./deployment/gitops.yaml npm run gitops:config -- apply
```

`apply` loads the configured operator's actual RBAC assignments and verifies branches/destinations before saving settings through the existing services. It creates no repositories, branches, bootstrap PRs or content exports. In Git mode, product workflow edits become private change sets requiring the normal PR review/merge. Indexed repository/root/source-branch changes continue to require an explicit migration. The file's binding, App and workflow settings are applied by this command; editing those fields alone does not overwrite the stored settings on startup. UI changes remain effective until another explicit apply.

## Activate

Use the supported Node version (`>=22.22.2 <25`) and the normal TypeSpec sibling-package build prerequisites in [developer-guide.md](developer-guide.md).

1. Back up the application database. For PGlite, stop processes using its directory before maintenance. Run `npm run db:generate` and `npm run db:deploy`. The additive tenant migration is `20261114000000_tenant_content_storage`; a build does not migrate the database.
2. Open **Admin → Settings → Tenant storage**. A tenant administrator manages the active tenant; a platform administrator can also choose **New tenant**. Set the server's public origin (`AUTH_URL` or `NEXTAUTH_URL`) and preserve its stable `SECRETS_ENCRYPTION_KEY`.
3. For a private database tenant, choose **PostgreSQL** (or **Embedded PostgreSQL**, according to `DB_PROVIDER`). A new tenant gets its own initial domain/product and creator administrator membership. No GitHub connection is required. `DB_PROVIDER` selects the deployment's physical database; tenants select which system owns their content.
4. For Git, configure the shared GitHub App (platform administrator). Register callback `{AUTH_URL}/api/gitops/callback` and webhook `{AUTH_URL}/api/gitops/webhook`. Enter App ID, PEM private key, client ID, client secret and webhook secret. Secrets are encrypted and not returned to the browser. This App is separate from application sign-in.
5. Give the App **Contents: write**, **Pull requests: write**, **Checks: read**, **Commit statuses: read**, and **Metadata: read**. Subscribe to push, pull request, review, check run/check suite, status and installation events. Install it on the chosen repository. Branch protection and the linked user's repository permissions remain authoritative.
6. Choose the repository URL, installation ID, existing source branch and repository root. Empty means the entire repository; a folder such as `contracts/catalog` confines managed files to that folder. Different tenants must reserve separate, non-overlapping roots. Edit owners and the environment order, branches and output paths, then **Verify & save repository**. Every configured branch must exist. Saving installs the **GitOps · same repository** default product workflow. Artifact overrides remain configurable in the GitOps workspace.
7. For an existing database tenant, choose **Use GitHub storage**. The application freezes direct content writes before export, preventing changes from being lost during cutover. Existing content remains readable. A new Git tenant starts in this setup state automatically.
8. **Connect GitHub**, then **Create initial PRs**. Review and merge each product's import PR in GitHub. The import includes full stored entity/event history, hierarchy and shared definitions. Repository verification and tenant creation do not silently publish contracts.
9. Run the worker below and choose **Index repository**. Refresh the status until **Git active** appears. Merged contracts are visible in the schema UI and GitOps workspace. Continue authoring using private drafts and PRs. Environment promotion follows the product's configured sequence.

Returning to database storage is allowed only before Git history, published source PRs or open drafts exist. After cutover it requires an explicit content migration; the settings UI blocks an unsafe switch. The application database remains required for identities, permissions, settings, encrypted credentials, private drafts, job receipts and the read projection.

```dotenv
GITOPS_WORKER_TOKEN=<server-only random secret of at least 32 characters>
GITOPS_WORKER_URL=http://localhost:3000/api/gitops/process
```

```bash
npm run gitops:worker
# One drain for a scheduler or an operational check:
npm run gitops:worker -- --once
```

Keep the worker running alongside the web application. Signed webhooks enqueue jobs; polling reconciles enabled Git-tenant bindings every five minutes. Manual synchronization also queues a job. Jobs have leases, retries and visible failure state. No GitHub calls occur while loading the workspace.

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
