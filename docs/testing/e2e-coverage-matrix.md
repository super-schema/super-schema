# Browser suite: coverage matrix

What the browser suite (`tests/e2e`, run by `docs/testing/e2e.md`) covers, by route and feature area: the specs that exercise it, the tier tags those tests carry, and what is
known not to work or not to be covered (an id of `known-defects.md`, or a plain statement). It is the answer to "is X tested in a browser before a release?".

Three things keep it honest, all checked by `tests/unit/e2e-coverage-matrix.test.ts`: every `*.spec.ts` of `tests/e2e` is named here (a new spec without a row fails), every page
of `tests/e2e/fixtures/routes.ts` is named here, every `KD-nnn` cited is an entry of `known-defects.md`, and the per-spec table at the end is the output of
`node scripts/e2e-counts.mjs --specs` (it fails when a test is added or removed and the table was not regenerated). The numbers are read from `playwright test --list`, never typed.

Tiers (the tags on a test: `@smoke`, `@regression`, `@slow`, `@external`; `@visual` for the screenshots; `docs/testing/e2e.md` "The tiers"):

- **smoke**: `@smoke`, on Chromium, Firefox and WebKit; every pull request.
- **regression**: everything except `@slow` and `@external`, Chromium (+ the `a11y` project, and `serial-after`); sharded in CI.
- **nightly**: everything: adds `@slow` and `@external` (the release check `npm run test:e2e:release`). `@external` tests need the network (schemastore.org) or the second app the runner starts.
- **visual**: the nine screenshots, only inside the Playwright Docker image (`npm run test:e2e:visual`).
- **corpus** (not Playwright): `npm run test:corpus`, every case of the corpus against every enabled target with the LocalCloud emulators and `javac`.

## By area

| Area | Routes and features | Specs (distinct tests) | Tier tags | Known gaps |
| --- | --- | --- | --- | --- |
| Authentication | `/login` (success, failure, `callbackUrl`, a forged cookie), `/register`, the user menu and sign-out, the middleware's redirect and its 401s | `auth.spec.ts` (36), `sample.spec.ts` (1) | smoke 6, rest regression | Google sign-in is external and not tested. Open registration, the first administrator and the seeded password are real risks, not tests: KD-038 |
| Page sweep and the shell | every page of `fixtures/routes.ts`: `/schemas`, `/glossary`, `/lineage`, `/governance`, `/compliance`, `/deployments`, `/admin`, `/admin/settings`, `/admin/domains`, `/admin/emitters`, `/admin/health`, `/admin/classifications`, `/governance/retention`, `/notifications`, `/schemas/type-mappings`, `/schemas/enterprise`; the layout at several widths; the not-found page inside the shell | `smoke-pages.spec.ts` (20), `layout.spec.ts` (5), `dashboard-not-found.spec.ts` (2) | smoke 7, rest regression | `/dev/design-system` is a development page and is not tested in the browser |
| Hierarchy | domain, product and entity create, edit, delete (the deletion dialog and its impact counts), what the forms refuse, the tenant-level (Enterprise) entity, every explorer node and link | `hierarchy-crud.spec.ts` (12), `navigation.spec.ts` (5), `entity-field-edit.spec.ts` (3) | smoke 1, `navigation` 2 `@slow`, rest regression | The tenant is a cookie: KD-034 |
| Entities and their tabs | Governance (retention), Alerts, API, Deployments, TypeSpec, the field studio, the right panel, the primary-key dialog, the staged emit dialog, the field edit panel | `entity-tabs.spec.ts` (15), `entity-field-edit.spec.ts` (3) | regression | KD-001 and KD-004 (overrides that nothing applies, and the dialog that cannot open), KD-005 (unrendered components), KD-006, KD-008, KD-010, KD-011 |
| Publish, versions and life cycle | the Publish dialog (bumps, blockers), the Versions tab, deprecate and retire | `entity-publish-versions.spec.ts` (7) | smoke 1, rest regression | KD-003 (no diff between versions), KD-033 (generate and publish rewrite the whole `metadata`) |
| References and closures | a reference picked qualified, the file set an entity generates with the entities it references, drafts, pins, an ambiguous bare name | `reference-lifecycle.spec.ts` (9) | smoke 1, rest regression | KD-029 (a union of entities is not followed), KD-031 (a reference to a missing entity) |
| Importers | JSON Schema (paste, file, URL, a user's `user event` schema, external `$ref`s, classification, the primary-key prompt), Avro, Protobuf, OpenAPI, BigQuery DDL, TypeSpec multi-model, file drop, the Standards Library, Natural Language with the AI unconfigured | `importers.spec.ts` (10), `schema-lifecycle.spec.ts` (1), `jsonschema-user-event.spec.ts` (2), `jsonschema-browser-verification.spec.ts` (9), `jsonschema-url-import.spec.ts` (1) | smoke 2, `@external` 2 (the network URL import, the git-mode `any` second app), rest regression | Natural Language with a configured AI provider is not run (none in a release run). KD-011 (decimal precision), KD-032 (an enum's symbols are in two places) |
| Schemas and the eight targets | generate every target of the catalog (JSON Schema, OpenAPI, Avro, Protobuf, Java, BigQuery, PostgreSQL, Spanner) for authored and imported entities, edit, sync the TypeSpec source, regenerate; the corpus covers the matrix of 306 cases x 8 targets against the emulators | `jsonschema-lifecycle.spec.ts` (16), `authored-lifecycle.spec.ts` (4), `schema-lifecycle.spec.ts` (1); the corpus: `npm run test:corpus` | `jsonschema-lifecycle` 16 `@slow`, rest regression; corpus: by hand before a release | KD-001, KD-029, KD-031, KD-032; the emitters of the sibling `typespec` repository are `file:` dependencies (`docs/testing/e2e.md`, "CI prerequisites") |
| Events (AsyncAPI) | the builder (server, channel, message, operation), Save and reload, Docs, redirects of the old URLs, publish and versions, Used by, external references from another event, the AsyncAPI 3.0 import, the leave guard, example validation, product contacts | `events-builder.spec.ts` (5), `events-publish.spec.ts` (5), `events-external-refs.spec.ts` (4), `events-import.spec.ts` (3), `events-leave-guard.spec.ts` (4), `events-example-validation.spec.ts` (1), `product-contacts.spec.ts` (5) | regression; `events-external-refs` 4 `@slow` (run in `serial-after`) | none recorded |
| Governance | the dashboard, approve and reject with a comment, History, a user without the Steward or Admin role, the impact report, Retention Policies | `governance-compliance.spec.ts` (27, shared with Compliance) | regression | KD-015 (a refused decision is not explained), KD-022 (nothing produces a request), KD-023 (who may see requests), KD-034 |
| Compliance | Query, Gaps, Audit Trail and its CSV export, the tenant being viewed | `governance-compliance.spec.ts` (27, shared with Governance) | regression | KD-016 (the Audit Trail reads every tenant's rows), KD-034 |
| Administration | Users and roles (assign, remove, the last admin), Domains, Emitters, Health, Classifications, Settings | `admin.spec.ts` (23) | regression | KD-014 (levels in page state), KD-021 (the Enabled toggle is not wired; Health compiler and emitter checks look at what is installed), KD-035 (role changes are not audited) |
| Glossary | concepts (create, search, narrow by domain, the detail panel), the seeded concepts | `glossary-lineage.spec.ts` (12, shared with Lineage) | regression | KD-017 (the detail panel never lists the linked fields), KD-018 (the domain tabs are the domains of what is listed) |
| Lineage | the graph of the tenant being viewed: an entity for every relationship, an edge for each | `glossary-lineage.spec.ts` (12, shared with Glossary) | regression | none recorded |
| Notifications | the bell (unread count, Mark all as read, opening one) and the history page (paging, filters) | `discovery.spec.ts` (21, shared with the palette) | smoke 1, rest regression | KD-019 (Next is enabled on an exactly full last page) |
| Command palette, shortcuts, tenant switcher | `Mod+K`, the search, `Entity -> field`, recents, `/` and `Mod+N`, switching the tenant | `discovery.spec.ts` (21, shared with Notifications) | regression | KD-020 (the palette finds fields among the first 100), KD-034 (the tenant is a cookie) |
| Type mappings | `/schemas/type-mappings`: pick a logical type, read each technology's physical type | `type-mappings.spec.ts` (5) | regression | KD-013 (no row for OpenAPI 3, JSON Schema and the Java POJO) |
| Domain assets | Data Types (enums, scalars, unions), APIs (services and operations), Properties (traits), at domain, product and Enterprise level | `domain-assets.spec.ts` (12) | regression | none recorded |
| REST API v1 and webhooks | health, schemas, emit, validate, event specs, notifications, webhooks, who may call what, bad requests, the rate limit | `api-v1.spec.ts` (70), and the unit tests of the routes | smoke 1, rest regression | KD-024 (a key cannot create a webhook), KD-025 (a session is a viewer), KD-026 (the schemas routes are not tenant scoped), KD-027 (the list returns signing secrets), KD-028 (the rate limit); KD-036 (the characterizations pass because the defect is there) |
| Accessibility | an axe scan (WCAG 2.1 A and AA) of every route and of the dialogs and palette states that matter, against a recorded baseline | `a11y.spec.ts` (28), project `a11y` | regression (inside the regression and nightly tiers) | only the dark theme is scanned (`docs/testing/a11y.md`); the baseline was measured with Chrome on macOS: KD-037 |
| Visual regression | nine pages, compared to screenshots made in the Playwright image | `visual.spec.ts` (9), project `visual`, image only | `visual` tier, by hand and the `e2e-visual` job | the snapshots were made on arm64, CI is x86-64: KD-037 |
| Not tested in a browser | Git export (no UI exists), `/dev/design-system` (development only), Google sign-in (external), real Spanner and BigQuery (only the emulators, in the corpus), Firefox and WebKit beyond the smoke tests | | | |

## Per-spec table

Generated by `node scripts/e2e-counts.mjs --specs` (the `visual` runs are the Playwright image's; the others are this machine's; the login project is not counted). Regenerate and paste it
when a test is added or removed: the unit test compares the two.

<!-- counts:begin -->
| Spec | Tests | Tags | smoke runs | regression runs | nightly runs | visual runs |
| --- | --- | --- | --- | --- | --- | --- |
| a11y.spec.ts | 28 | @regression 28 | 0 | 28 | 28 | 0 |
| admin.spec.ts | 23 | @regression 23 | 0 | 23 | 23 | 0 |
| api-v1.spec.ts | 70 | @regression 70, @smoke 1 | 1 | 70 | 70 | 0 |
| auth.spec.ts | 36 | @regression 36, @smoke 5 | 5 | 36 | 36 | 0 |
| authored-lifecycle.spec.ts | 4 | @regression 4 | 0 | 4 | 4 | 0 |
| dashboard-not-found.spec.ts | 2 | @regression 2 | 0 | 2 | 2 | 0 |
| discovery.spec.ts | 21 | @regression 21, @smoke 1 | 1 | 21 | 21 | 0 |
| domain-assets.spec.ts | 12 | @regression 12 | 0 | 12 | 12 | 0 |
| entity-field-edit.spec.ts | 3 | @regression 3 | 0 | 3 | 3 | 0 |
| entity-publish-versions.spec.ts | 7 | @regression 7, @smoke 1 | 1 | 7 | 7 | 0 |
| entity-tabs.spec.ts | 15 | @regression 15 | 0 | 15 | 15 | 0 |
| events-builder.spec.ts | 5 | @regression 5 | 0 | 5 | 5 | 0 |
| events-example-validation.spec.ts | 1 | @regression 1 | 0 | 1 | 1 | 0 |
| events-external-refs.spec.ts | 4 | @regression 4, @slow 4 | 0 | 0 | 4 | 0 |
| events-import.spec.ts | 3 | @regression 3 | 0 | 3 | 3 | 0 |
| events-leave-guard.spec.ts | 4 | @regression 4 | 0 | 4 | 4 | 0 |
| events-publish.spec.ts | 5 | @regression 5 | 0 | 5 | 5 | 0 |
| glossary-lineage.spec.ts | 12 | @regression 12 | 0 | 12 | 12 | 0 |
| governance-compliance.spec.ts | 27 | @regression 27 | 0 | 27 | 27 | 0 |
| hierarchy-crud.spec.ts | 12 | @regression 12, @smoke 1 | 1 | 12 | 12 | 0 |
| importers.spec.ts | 10 | @regression 10 | 0 | 10 | 10 | 0 |
| jsonschema-browser-verification.spec.ts | 9 | @external 2, @regression 9 | 0 | 7 | 9 | 0 |
| jsonschema-lifecycle.spec.ts | 16 | @regression 16, @slow 16 | 0 | 0 | 16 | 0 |
| jsonschema-url-import.spec.ts | 1 | @regression 1 | 0 | 1 | 1 | 0 |
| jsonschema-user-event.spec.ts | 2 | @regression 2, @smoke 1 | 1 | 2 | 2 | 0 |
| layout.spec.ts | 5 | @regression 5, @smoke 2 | 2 | 5 | 5 | 0 |
| navigation.spec.ts | 5 | @regression 5, @slow 2 | 0 | 3 | 5 | 0 |
| product-contacts.spec.ts | 5 | @regression 5 | 0 | 5 | 5 | 0 |
| reference-lifecycle.spec.ts | 9 | @regression 9, @smoke 1 | 1 | 9 | 9 | 0 |
| sample.spec.ts | 1 | @regression 1, @smoke 1 | 1 | 1 | 1 | 0 |
| schema-lifecycle.spec.ts | 1 | @regression 1, @smoke 1 | 1 | 1 | 1 | 0 |
| smoke-pages.spec.ts | 20 | @regression 20, @smoke 5 | 5 | 20 | 20 | 0 |
| type-mappings.spec.ts | 5 | @regression 5 | 0 | 5 | 5 | 0 |
| visual.spec.ts | 9 | @regression 9, @visual 9 | 0 | 0 | 0 | 9 |
<!-- counts:end -->

## The last full run

<!-- final-run:begin -->
<!-- final-run:end -->
