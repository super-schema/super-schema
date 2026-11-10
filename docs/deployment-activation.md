# Local deployment activation

Activated 2026-11-07 after the field-attribute task completed its handoff. The [workflow guide](deployment-workflows.md) describes the feature contract.

## Active locally

| Item | Verified state |
| --- | --- |
| Runtime | Node `v22.22.2`, installed in the existing NVM versions directory; global Node default unchanged |
| App | `http://127.0.0.1:3000`; health endpoint reports healthy database, compiler and eight installed emitter packages |
| Database | Existing PostgreSQL 18/PGlite data preserved; `20261107000000_deployment_workflows` applied |
| Worker | Independently running `npm run deployments:worker`; anonymous requests return 401, configured bearer token returns 200 |
| Deployment UI | Authenticated real schema page loads the saved workflow controls without initialization errors |
| Git connection | Tenant connection **Event Schema Central** uses `OnePayPal/event-schema-central`, base branch `jay-MS-5917`, with encrypted credentials; saved branch persisted after reload and Verify connection succeeded |

The database was stopped before backup and migration. Backup:

```text
data/backups/pglite-before-deployment-activation-20261108T020028Z/
```

The app and worker run in separate background process groups. Their launcher PIDs, runtime path and log paths are recorded in the gitignored file:

```text
data/deployment-activation/services.json
data/deployment-activation/app.log
data/deployment-activation/worker.log
```

`.env` contains the worker token/URL, Git host allowlist, approved Event Schema Central repository and local installed toolkit path. Its permissions are restricted to the owner. Existing authentication/encryption keys were preserved. No secret values belong in this document or a commit.

## Commands for a manual start

Use these after stopping any existing instance that owns this PGlite directory. Do not run a second database client/process against it.

```bash
cd /Users/jsenjaliya/src/apache/super-schema
source "$HOME/.nvm/nvm.sh"
nvm use 22.22.2
npm run db:generate
npm run db:deploy
npm run dev -- --hostname 127.0.0.1 --webpack
```

In a second terminal:

```bash
cd /Users/jsenjaliya/src/apache/super-schema
source "$HOME/.nvm/nvm.sh"
nvm use 22.22.2
npm run deployments:worker
```

The running processes already use those settings; starting another copy is unnecessary. `npm run deployments:worker -- --once` is the scheduler form of a worker drain. Webpack is used because this environment blocks Turbopack's CSS subprocess socket. Startup instrumentation keeps Node-only imports inside Next's runtime-specific branch, so development Edge bundles exclude `node:net`.

## External setup still required

The selected remote base is `jay-MS-5917`, verified at `9a746ab7f7115b72684a304e08b250e609f98c45`. No remote branch, commit or PR was created. The generic SuperSchema hierarchy profile can target this branch. The optional Event Schema Central contract-preparation profile additionally requires a remote base containing `event_schema_central_action/model.py` and matching manifests; the selected branch currently lacks that modern toolkit. Installing the local toolkit does not update the remote base.

No API endpoint or Schema Registry endpoint/credentials were supplied. Those destinations remain unconfigured. No delivery workflow was invented with an arbitrary schema/version or contract metadata, and no live registry registration or API handoff occurred.

## Dependency alignment

After Google Cloud reauthentication, `npm ci` succeeded against the configured corporate registry using a private, temporary npm configuration. Installed packages now match the lockfile: compiler/OpenAPI `1.17.0`, Protobuf `0.87.0`, Next `16.4.3`, and Vitest `5.0.5`. Prisma and parser-worker artifacts were regenerated. Package manifests and global npm registry configuration were preserved during alignment.

The updated dependencies exposed stale test fixtures: UUID schema fields now use the canonical `string` plus `uuid` format, and the OpenAPI TRACE fixture declares its required path parameter. Existing API UUID and emitted-format assertions remain intact. See the [verification record](testing/deployment-workflows-verification.md) for final validation.
