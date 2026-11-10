# Deployment workflow verification

Verified and activated 2026-11-07 in `/Users/jsenjaliya/src/apache/super-schema`, after the field-attribute task completed its handoff. See [Deployment workflows](../deployment-workflows.md) for the feature contract and [Local activation](../deployment-activation.md) for running services and remaining setup.

| Check | Result |
| --- | --- |
| Focused deployment, navigation, field-UI integration and access regressions | 330 checks passed across 19 files on supported Node 22 |
| Migration and persistence integration | 12 cases passed on real in-memory PGlite, including concurrent claims, frozen plans, current-role checks, retry/recovery and deletion cascades |
| Whole unit suite plus deployment database integration | 17,125 passed and one expected failure across 880 files with lockfile-aligned dependencies on Node 22 |
| Production build and TypeScript | Passed on Node `v22.22.2` using webpack; per-process `memory://` databases keep build workers independent of live data |
| ESLint on deployment sources and final integration changes | Passed |
| Actual deployment components in Chromium | 1512/760/390 pixels, light/dark, no page overflow or JavaScript errors; pinned older-version review/execute and method tabs work |
| Actual authenticated local app | Deployment controls load after migration/restart without initialization errors |
| Live Git access | Repository access verified; selected remote `jay-MS-5917` exists at `9a746ab7f7115b72684a304e08b250e609f98c45`; no remote writes |
| Live Git connection through app | Tenant connection uses encrypted credentials and base branch `jay-MS-5917`; Verify connection succeeds |
| Worker authentication and persistence | Independent worker running; anonymous request 401, configured token 200 with zero pending jobs |
| Event Schema Central Avro/JSON preparation | Full destination checks and prospective-tree evolution passed on disposable modern working-tree copies; payload bytes preserved |
| `git diff --check` | Passed |

The field-attribute task separately reported a passing production build, typecheck, scoped lint, 2,275 tests plus one expected failure, eight output-target checks and isolated browser accessibility checks. Its source changes were preserved. Final integration updated six stale assertions for its new Description/example UI contract and fixed an endless loading indicator after a deployment initialization error.

## Dependency and runtime alignment

After Google Cloud reauthentication, a clean `npm ci` installed 1,249 packages successfully without changing the package manifests. Compiler/OpenAPI now use `1.17.0`, Protobuf `0.87.0`, Next `16.4.3`, Prisma `7.10.1` and Vitest `5.0.5`. Credentials were supplied through a private temporary npm configuration; global npm settings were preserved.

The earlier emitter failures are resolved. UUID fixtures now store canonical string fields with `uuid` format, with emitted-format assertions preserved, and the OpenAPI TRACE fixture declares its required path parameter. Deployment format/version navigation now remounts the editor to invalidate stale reviewed plans; a regression checks that execution remains unavailable after navigation. The final whole-suite run passed 17,125 tests with one expected failure across 880 files.

Startup instrumentation uses Next's documented runtime-specific import branch so Edge development bundles exclude Node-only modules. Its three startup checks and 101 middleware/transport checks pass. Scoped ESLint passes with the installed version. The webpack production build passes; Turbopack's CSS subprocess is blocked by a socket restriction in this execution environment. Webpack reports the existing dynamic-import warning from `json-schema-ref-parser`, and Next reports the deprecated middleware filename.

Useful focused commands:

```bash
npm run test -- --run tests/unit/deployments tests/integration/db/deployment-workflows-pglite.test.ts tests/unit/components/deployment-workflows-tab.test.tsx
npm run test -- --run tests/unit/components/entity-workspace-ux.test.tsx tests/unit/components/documentation-panel-example-preview.test.tsx tests/unit/schemas/typespec-field-studio.test.ts
```

For a build that cannot open the live PGlite directory:

```bash
PGLITE_DATA_DIR=memory:// npm run build -- --webpack
```

## Data and external effects

The existing local database was stopped and backed up before applying `20261107000000_deployment_workflows`. The app and worker now use it on Node 22. No seed/reset was run. Authentication/encryption keys were preserved, and the generated worker secret was never printed.

Event Schema Central preparation used disposable copies of its modern local working tree: Avro `paypal.compliance.onescm.scm-case-created:2.0.0_snapshot` and JSON Schema `paypal.tracking.user-events.user-link-tracked:1.0.0_snapshot`. The actual application preparation adapter also passed the Avro case. Its original checkout/index was preserved.

GitHub branch/commit/PR behavior and registry registration are covered by controlled API protocol tests; HTTP handoff uses a real local receiver. Live Git repository access and the selected `jay-MS-5917` base are verified, but no hosted PR, live registry registration or external API handoff was performed. The generic hierarchical profile can target this branch. The optional Event Schema Central preparation profile requires its modern toolkit to be present on the remote base; API/registry destinations remain user-supplied setup.
