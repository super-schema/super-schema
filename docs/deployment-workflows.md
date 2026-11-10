# Schema publication and deployment workflows

Implemented 2026-11-07. This is the operating guide for the schema deployment workflow. The earlier [tab plan](plans/2026-11-07-schema-versioning-and-deployment-workflows.md) and [Git assessment](plans/2026-11-07-git-deployment-repository-profiles.md) explain the original gaps.

## Use the two tabs

**Schemas** generates and inspects artifacts. Its horizontal version tabs put drafts first, then published versions newest first. The sidebar summarizes the latest published version, falling back to the latest draft. Older versions are historical; their order does not establish retirement. **Publish schema** freezes an artifact for delivery. Regenerating an existing draft updates that draft; regenerating after publication creates a new artifact version.

Select a published version and click **Deploy…** to open **Deployments** with that exact format and version. This only navigates, using `tab=deployments&schemaFormat=<format>&schemaVersion=<number>`. Draft delivery is blocked on the server. An unavailable explicit selection is never silently replaced by the latest version.

**Deployments** has **Git PR**, **API endpoint**, and **Schema registry** tabs. Create a connection, save a named workflow, choose a published artifact, validate and review the preview, then execute explicitly. Workflow edits invalidate the preview. The preview expires after 30 minutes; changing a connection or workflow requires a new preview.

Artifact versions, source entity versions, destination contract SemVer, and registry subject versions are separate identities. Deployment never regenerates or rewrites the selected schema. A full file manifest and root file are frozen with a content hash. Partial/redacted bundles and references generated from unpublished entities cannot be delivered.

## Results and history

| Method | Successful receipt | Meaning |
| --- | --- | --- |
| Git PR | `pr-opened`, branch, commit SHA, PR number and URL | A real PR was submitted for review. Refresh PR status contacts GitHub. |
| API endpoint | `delivered` for other 2xx, `accepted` for 202, HTTP status | The receiving API accepted the handoff and owns subsequent work. |
| Schema registry | `registered`, subject, schema ID and subject version for each registered file | Schemas are available in that registry. |

Receipts do not assert that an application is running the schema. No method merges a PR, provisions infrastructure, or deploys application code. The global Deployments page shows recent receipts and separately lists recorded environments. Existing environment records remain manual assertions, with comparisons against the latest generated output. They are not live platform inspection. Recording a new assertion requires an exact published artifact version. Legacy scalar `deployed` markers appear as provenance with an unknown environment; no receipt or environment is invented for them.

## Install and run

The application uses the new `DeploymentConnection`, `DeploymentWorkflow`, `DeploymentRun`, and `DeploymentAttempt` tables. Generate the client and apply migrations to the configured database before using the feature:

```bash
npm run db:generate
npm run db:deploy
```

PGlite applies the same migration SQL as PostgreSQL. Use the normal database startup/upgrade procedure in [database.md](database.md); do not open the same PGlite directory in a second process. These changes were verified on a freshly migrated in-memory PGlite database. Subsequent [local activation](deployment-activation.md) backed up and migrated the existing database, then started the app and worker.

Configure the existing secret encryption key (`SECRETS_ENCRYPTION_KEY`, with the application's existing authentication-secret fallback). Connection credentials are encrypted at rest, never returned to the browser, and omitted from audit state. Tenant administrators configure connections (`deploy.configure`); stewards and higher roles can save/run workflows within their resource scope (`deploy.run`). Viewers can inspect authorized history. Execution reloads the creator's current account and roles and checks access to every referenced artifact before delivery.

The request schedules an immediate attempt. Run an independent drain for restart recovery and retries:

```dotenv
DEPLOYMENT_WORKER_TOKEN=<a strong server-only random secret>
DEPLOYMENT_WORKER_URL=http://localhost:3000/api/deployments/process
```

```bash
npm run deployments:worker
# Drain once, for a scheduler:
npm run deployments:worker -- --once
```

The worker calls the application's exact `POST /api/deployments/process` endpoint with its bearer token. It never opens the database itself. Remote worker URLs require HTTPS; HTTP is limited to loopback. Each drain processes up to five jobs sequentially. Run this drain continuously or schedule it independently of browser traffic. On platforms that terminate request work early, the durable drain recovers abandoned leases.

Runs have `PREVIEWED`, `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, or `UNKNOWN` status. Atomic claims and renewable leases prevent concurrent workers from owning the same job. Automatic retries use up to five attempts with backoff and supported rate-limit delays. Every attempt retains the same frozen plan and idempotency key. Git and registry unknown results can be reconciled from history. An uncertain API result is retried automatically only when the configured endpoint guarantees idempotency; otherwise it remains `UNKNOWN` for operator investigation. Do not create a new API intent until its previous outcome is understood.

## Git PR: one fixed hierarchy

Initial provider support is GitHub and explicitly allowed GitHub Enterprise hosts. Any owner/repository on those hosts can be configured; the code contains no Event Schema Central organization special case. GitLab and other hosting protocols require a future provider adapter.

Use an HTTPS repository URL (GitHub-style `git@host:owner/repo.git` URLs are normalized), the actual base branch, and either a GitHub token or GitHub App credentials. A token/App needs repository contents write and pull requests write permissions, plus access to the selected repository. An App connection supplies App ID, installation ID and PEM private key. **Verify connection** checks real remote repository write access.

```dotenv
# Default: github.com. Add GitHub Enterprise hosts explicitly when needed.
DEPLOYMENT_GIT_HOSTS=github.com,github.company.example
```

The generic artifact layout is opinionated and has no configurable identity/path mapping:

```text
schemas/<tenant-slug>/<domain-slug>/<product-slug>/<schema-slug>/<contractVersion>/<format>/
  <original artifact files and their relative directories>
  superschema-manifest.json
```

The format directory prevents independent outputs from colliding at the same contract version. Identity comes from saved Super Schema slugs. The entity must belong to a tenant/domain/product; destination segments must be lowercase kebab-case. Choose destination SemVer explicitly, such as `1.0.0_snapshot`. Source artifact `v4` does not imply destination `4.0.0`. Each format/version directory is immutable in generic exports; different bytes require a new destination version.

Preview reads the actual base commit, validates the complete file set, rejects unsafe paths, collisions, symlinks and oversized/incomplete trees, and performs no Git writes. Execution verifies the base is unchanged, creates a tree based on that commit, commits only the reviewed files, creates a deterministic feature branch, then opens a real PR. Recovery checks the branch parent, complete unrelated base content, intended file bytes and delivery marker before reusing it. It never force-pushes. A moved base or conflicting branch requires a new preview.

Platform administrators can import an existing legacy token/App configuration through **Manage Git PR connections**. It becomes a tenant connection. SSH credentials require a new token/App connection. Legacy bulk exports and fake status synchronization return `WORKFLOW_REQUIRED`; they cannot report fabricated commits or PRs.

## Event Schema Central contract bundles

Enable **Prepare an Event Schema Central contract bundle** on a Git workflow to use its companion-file contract at the same tenant/domain/product/schema hierarchy. This is a specialized preparation adapter, not a configurable organization/profile system. Existing tenant/domain/product policy must already be present in the destination. New parent onboarding is a separate repository change.

The target base must contain the modern `event_schema_central_action` tooling, prefixed hierarchy manifests and `.schema.avsc`/`.schema.json` payload convention. The inspected local Event Schema Central working tree has that contract; its locally cached `origin/main` did not. Land that migration or choose a matching base branch before delivery. The adapter checks the actual fetched base, not the user's local working tree.

Install an approved Event Schema Central toolchain with its `.venv`, Python requirements, Node dependencies, `git`, `make`, and Node available. Explicitly authorize repositories whose own validators may execute:

```dotenv
DEPLOYMENT_EVENT_REPOSITORIES=github.com/OnePayPal/event-schema-central
DEPLOYMENT_EVENT_TOOLKIT=/opt/event-schema-central-toolkit
```

The selected remote base is copied into a disposable directory. Dependencies come from the installed toolchain. The helper receives no publishing credential and a stripped environment. It runs as the application's OS user: deploy the application/toolchain with an appropriately isolated OS/container account and outbound policy. The allowlist is an explicit trust decision for repository-owned Python, Make and Node code. Workflow input cannot supply shell commands.

Choose **Event topic** or **Reusable entity**, then **Create contract**, **Add snapshot version**, or **Update snapshot**. Supply version metadata and a valid example. Topics require the repository's logical CloudEvent example; entities use a payload example. Optional shared topic configuration is changed only when supplied. Inherited payload format, naming, ownership and compatibility policy remain authoritative.

Only `_snapshot` targets are prepared. Released directories are immutable and promotion stays with the repository's release workflow. The selected payload bytes are preserved. The adapter adds the canonical payload filename, retains representable helper files, uses repository-owned AsyncAPI/SDK generation for topics, refreshes `product-manifest.json`, runs full `make check`, and checks evolution against the exact prospective tree. Failures stop PR creation. Only the selected contract and product manifest may be returned. A closure that needs independent reusable-entity mapping must be modeled explicitly in the destination; unsupported layouts fail rather than being flattened or rewritten.

Validation completed against disposable copies of `/Users/jsenjaliya/src/my/event-schema-central` for both the Avro `scm-case-created:2.0.0_snapshot` and Draft 2020-12 JSON Schema `user-link-tracked:1.0.0_snapshot` updates. Both passed the repository checks and evolution gate. The original checkout was preserved. Hosted PR creation still requires a configured destination connection and compatible remote base; no external PR was opened during implementation verification.

## API endpoint contract

Configure an HTTPS endpoint with no authentication, bearer authentication, or basic authentication. Optionally configure an HMAC signing secret. The transport pins DNS to public addresses, follows no redirects, and bounds request/response handling. The existing development-only `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` permits a local HTTP test receiver; production retains the public HTTPS destination policy.

The JSON POST body is:

```json
{
  "payloadVersion": "1",
  "event": "schema.deployment.requested",
  "runId": "run-id",
  "idempotencyKey": "delivery-intent-uuid",
  "entity": { "id": "entity-id", "name": "Account", "tenant": "paypal", "domain": "identity", "product": "accounts", "schema": "account" },
  "environment": "staging",
  "artifact": {
    "format": "avro", "version": 4, "sourceEntityVersion": 2,
    "contentHash": "sha256:...", "primaryFile": "Account.avsc",
    "files": [{ "path": "Account.avsc", "content": "exact published bytes" }]
  }
}
```

The request carries `Idempotency-Key`. With signing enabled, `X-Webhook-Signature` is `sha256=<hex HMAC-SHA256 of the exact body>`. Enable endpoint idempotency only if the receiver actually deduplicates this key. The receiver owns all subsequent actions. Arbitrary response bodies are not retained because they can echo credentials or sensitive data. No polling/callback protocol, custom response interpretation, or live deployment state is inferred.

## Confluent-compatible schema registry

Configure its HTTPS API base and bearer or basic credentials. Provide the root subject; map dependent file paths to their own subjects when the artifact has external references. The adapter supports Avro, JSON Schema and Protobuf, discovers reachable dependencies, rejects missing mappings/cycles, and registers dependencies before the root. Self-contained schemas do not require a subject for every redundant helper file.

Preview performs applicable compatibility checks. Execution checks each referenced schema with its resolved subject/version references, registers it or finds the identical existing schema, and records the registry's actual ID and subject version. Registration retries reconcile by schema lookup. A partial or lost response remains recoverable; already registered dependencies are reused. Registry registration does not create Kafka topics, promote Event Schema Central snapshots, or update producers and consumers.

## Verification and operating boundaries

See the [verification record](testing/deployment-workflows-verification.md) for completed checks and whole-repository failures, and the [activation record](deployment-activation.md) for running local services and remaining external setup.

The automated coverage includes byte/hash preservation, JSONB round trips, older-version selection, draft and closure access refusals, tenant isolation, credential sealing and audit redaction, revision/expiry checks, concurrent claims, lease recovery, retry behavior, GitHub REST tree/commit/PR reconciliation, HMAC/HTTP handoff with a real local receiver, registry references/compatibility/lookup protocol, and worker token authentication. Database tests apply the actual migration SQL. Chromium checks cover the real components at 1512, 760 and 390 pixels in light and dark themes.

Live credentials, a compatible remote contract base, the independent worker, and a real registry endpoint are operator configuration. Hosted GitHub PR and live registry acceptance are not claimed by the controlled protocol tests. The rollout retains all old manual environment history; it does not backfill invented external results.
