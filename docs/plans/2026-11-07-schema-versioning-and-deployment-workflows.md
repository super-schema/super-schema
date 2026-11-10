# Schema versioning and deployment workflows

Status: implemented 2026-11-07. The [deployment workflow operating guide](../deployment-workflows.md) is the canonical shipped contract and setup reference.

## Responsibilities

| Concern | Schemas | Deployments |
| --- | --- | --- |
| Generation | Generate/regenerate artifacts and apply supported overrides | Use saved, published bytes |
| Versions | Drafts first, published newest first; inspect content and references | Pin an exact published artifact |
| Actions | Publish schema; Deploy… navigates with the selected format/version | Save workflow, validate, preview, explicitly execute |
| Status | Draft / Published; older does not mean retired | Method-specific receipts, durable attempts and errors |
| History | Generated artifact history | Delivery history plus separate manual environment records |

The entity Versions tab retains entity publication history. Entity versions, emitted artifact versions, destination SemVer and registry subject versions remain distinct. Regeneration updates an existing draft or creates a new artifact version after publication; published payloads are not rewritten.

## Implemented stages

| Stage | Result | Evidence |
| --- | --- | --- |
| 1. Contracts and lifecycle | Frozen bundle/file manifest/hash; primary file attribution; API envelope; publication separated from handoff | Artifact tests, schema lifecycle tests, closure authorization tests |
| 2. Durable foundation | Tenant connections, saved workflows, runs and attempts; encrypted credentials; configuration revisions; atomic claims, leases and bounded retries | Actual SQL migrations and Prisma operations on PGlite; concurrency, restart recovery, role revocation and idempotency tests |
| 3. Tab separation | Horizontal schema version tabs; exact-version Deploy… navigation; Git PR/API endpoint/Schema registry method tabs; save/preview/execute and history | Component tests and real Chromium checks at 1512/760/390 pixels, light/dark |
| 4. API delivery | Authenticated and optionally HMAC-signed JSON POST; 2xx receipts; idempotency-aware retry policy | Actual local HTTP receiver verifies pinned bytes, signature and repeated delivery |
| 5. Git PR | Real GitHub tree/commit/ref/PR/status API; one fixed hierarchy; approved Event Schema Central preparation; complete branch reconciliation | Controlled GitHub protocol tests; Avro and JSON Schema contract bundles pass the destination's full checks in disposable checkouts |
| 6. Registry | Avro/JSON Schema/Protobuf references, compatibility, dependency order, lookup/register and actual subject versions | Controlled registry protocol and reference mapping tests |
| 7. Migration and closure | Legacy credentials import; fake Git execution disabled; exact-version manual assertions; tenant-wide delivery overview; operating guide and worker command | Authorization scans, credential/audit checks, legacy service/UI regression coverage |

## Accepted scope

The first release has independent delivery methods, not a general workflow designer. Git supports GitHub and allowlisted GitHub Enterprise hosts, arbitrary organizations/repositories on those hosts, and fixed Super Schema slug identities. There are no configurable organization mappings or arbitrary profile scripts. The generic layout adds a format directory under the destination contract version to avoid collisions between generated outputs.

The Event Schema Central option prepares companion files through trusted repository tooling. It supports existing parent hierarchies, Topic or reusable Entity contracts, create/new snapshot/explicit snapshot update, and fails when a dependency layout cannot be represented faithfully. Promotion and parent onboarding stay with that repository.

Receipts establish PR submission, API handoff, or registry availability. They do not assert runtime deployment. Legacy markers have an unknown environment; manual records remain manual. Unsupported formats, partial closures, unsafe paths, moved bases and failed validation block delivery.

## Rollout requirements and remaining external verification

Apply the migration to the deployed database, configure credentials and destinations, and run the independent authenticated worker. Existing local database contents were not migrated during implementation verification. The Event Schema Central remote base must contain its modern contract/tooling migration; an uncommitted local working tree does not establish that.

Hosted PR creation in the intended repositories and acceptance by a live registry require configured external services. Controlled adapter tests do not claim those live results. See the operating guide for exact environment variables, commands, receipts and verification boundaries.
