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
| Authentication | `/login` (success, failure, `callbackUrl`, a forged cookie, the lock after five wrong passwords, no identity-provider button by default, a provider's refusal worded like a wrong password), `/register` in `open` mode (a role-less account, the same answer for an existing address, `/no-access`), `/invite/<token>` and `/reset/<token>` (live, used, dead), the user menu and sign-out, the middleware's redirect and its 401s | `auth.spec.ts` (43), `sample.spec.ts` (1) | smoke 6, rest regression | A real sign-in through an identity provider is external and not tested (the decision, the callback, the adapter guard and the whole Auth.js flow against stubs are unit and PGlite tested: `docs/auth.md`). `invite` registration runs in a browser against the second app the runner starts (`access-matrix.spec.ts`, `@external`: the nightly tier, or `--second-app`); `closed` runs only at the unit level (the app under test is `open`: `tests/unit/app/register-actions.test.ts`), with no browser proof. The seeded development password is a real risk, not a test: KD-038 |
| Page sweep and the shell | every page of `fixtures/routes.ts`: `/schemas`, `/glossary`, `/lineage`, `/governance`, `/compliance`, `/deployments`, `/admin`, `/admin/settings`, `/admin/domains`, `/admin/emitters`, `/admin/health`, `/admin/classifications`, `/governance/retention`, `/notifications`, `/schemas/type-mappings`, `/schemas/enterprise`; the layout at several widths; the not-found page inside the shell | `smoke-pages.spec.ts` (20), `layout.spec.ts` (5), `dashboard-not-found.spec.ts` (2) | smoke 7, rest regression | `/dev/design-system` is a development page and is not tested in the browser |
| Hierarchy | domain, product and entity create, edit, delete (the deletion dialog and its impact counts), what the forms refuse, the tenant-level (Enterprise) entity, every explorer node and link | `hierarchy-crud.spec.ts` (12), `navigation.spec.ts` (5), `entity-field-edit.spec.ts` (3) | smoke 1, `navigation` 2 `@slow`, rest regression | The tenant is a cookie: KD-034 |
| Entities and their tabs | Governance (retention), Alerts, API, Deployments, TypeSpec, the field studio, the right panel, the primary-key dialog, the staged emit dialog, the field edit panel | `entity-tabs.spec.ts` (15), `entity-field-edit.spec.ts` (3) | regression | KD-001 and KD-004 (overrides that nothing applies, and the dialog that cannot open), KD-005 (unrendered components), KD-006, KD-008, KD-010, KD-011 |
| Publish, versions and life cycle | the Publish dialog (bumps, blockers), the Versions tab, deprecate and retire | `entity-publish-versions.spec.ts` (7) | smoke 1, rest regression | KD-003 (no diff between versions), KD-033 (generate and publish rewrite the whole `metadata`) |
| References and closures | a reference picked qualified, the file set an entity generates with the entities it references, drafts, pins, an ambiguous bare name | `reference-lifecycle.spec.ts` (9) | smoke 1, rest regression | KD-029 (a union of entities is not followed), KD-031 (a reference to a missing entity) |
| Importers | JSON Schema (paste, file, URL, a user's `user event` schema, external `$ref`s, classification, the primary-key prompt), Avro, Protobuf, OpenAPI, BigQuery DDL, TypeSpec multi-model, file drop, the Standards Library, Natural Language with the AI unconfigured | `importers.spec.ts` (10), `schema-lifecycle.spec.ts` (1), `jsonschema-user-event.spec.ts` (2), `jsonschema-browser-verification.spec.ts` (9), `jsonschema-url-import.spec.ts` (1) | smoke 2, `@external` 2 (the network URL import, the git-mode `any` second app), rest regression | Natural Language with a configured AI provider is not run (none in a release run). KD-011 (decimal precision), KD-032 (an enum's symbols are in two places) |
| Schemas and the eight targets | generate every target of the catalog (JSON Schema, OpenAPI, Avro, Protobuf, Java, BigQuery, PostgreSQL, Spanner) for authored and imported entities, edit, sync the TypeSpec source, regenerate; the corpus covers the matrix of 306 cases x 8 targets against the emulators | `jsonschema-lifecycle.spec.ts` (16), `authored-lifecycle.spec.ts` (4), `schema-lifecycle.spec.ts` (1); the corpus: `npm run test:corpus` | `jsonschema-lifecycle` 16 `@slow`, rest regression; corpus: by hand before a release | KD-001, KD-029, KD-031, KD-032; the emitters of the sibling `typespec` repository are `file:` dependencies (`docs/testing/e2e.md`, "CI prerequisites") |
| Events (AsyncAPI) | the builder (server, channel, message, operation), Save and reload, Docs, redirects of the old URLs, publish and versions, Used by, external references from another event, the AsyncAPI 3.0 import, the leave guard, example validation, the builder's layout at 1440 px and in a narrow pane, product contacts | `events-builder.spec.ts` (5), `events-publish.spec.ts` (5), `events-external-refs.spec.ts` (4), `events-import.spec.ts` (3), `events-leave-guard.spec.ts` (4), `events-example-validation.spec.ts` (1), `events-builder-layout.spec.ts` (2), `product-contacts.spec.ts` (5) | regression; `events-external-refs` 4 `@slow` (run in `serial-after`) | none recorded |
| Governance | the dashboard, approve and reject with a comment, History, an Author who may not decide, the impact report, Retention Policies | `governance-compliance.spec.ts` (27, shared with Compliance) | regression | KD-015 (a refused decision is not explained), KD-022 (nothing produces a request), KD-034 |
| Compliance | Query, Gaps, Audit Trail and its CSV export, the tenant being viewed, who may read it (no role 404, a Viewer 403, a Compliance Officer 200) | `governance-compliance.spec.ts` (27, shared with Governance) | regression | KD-034 |
| Administration | Users and roles (assign from the scope pickers, remove, status and last sign-in, the last admin's controls), Domains, Emitters, Health, Classifications, Settings | `admin.spec.ts` (23) | regression | KD-014 (levels in page state), KD-021 (the Enabled toggle is not wired; Health compiler and emitter checks look at what is installed) |
| Glossary | concepts (create, search, narrow by domain, the detail panel), the seeded concepts | `glossary-lineage.spec.ts` (12, shared with Lineage) | regression | KD-017 (the detail panel never lists the linked fields), KD-018 (the domain tabs are the domains of what is listed) |
| Lineage | the graph of the tenant being viewed: an entity for every relationship, an edge for each | `glossary-lineage.spec.ts` (12, shared with Glossary) | regression | KD-039 (the first view is fitted once, 50 ms after the start) |
| Notifications | the bell (unread count, Mark all as read, opening one) and the history page (paging, filters) | `discovery.spec.ts` (21, shared with the palette) | smoke 1, rest regression | KD-019 (Next is enabled on an exactly full last page) |
| Command palette, shortcuts, tenant switcher | `Mod+K`, the search, `Entity -> field`, recents, `/` and `Mod+N`, switching the tenant | `discovery.spec.ts` (21, shared with Notifications) | regression | KD-020 (the palette finds fields among the first 100), KD-034 (the tenant is a cookie) |
| Type mappings | `/schemas/type-mappings`: pick a logical type, read each technology's physical type | `type-mappings.spec.ts` (5) | regression | KD-013 (no row for OpenAPI 3, JSON Schema and the Java POJO) |
| Domain assets | Data Types (enums, scalars, unions), APIs (services and operations), Properties (traits), at domain, product and Enterprise level | `domain-assets.spec.ts` (12) | regression | none recorded |
| User management (`/admin`, `/invite/<token>`, `/reset/<token>`) | the invitation dialog (a tenant and a domain chosen from the lists), the one-time link opened in a fresh browser (name, password, sign-in, only the granted scope, a sibling domain's entity not found), revoking a pending invitation, disabling a person (their next request refused) and enabling again, a reset link, the last platform administrator's controls and the server's own refusal of the same acts, a tenant administrator's view (their tenant's people and places only, no platform tab, the role matrix), an AUTHOR's (no Admin link, the no-permission screen) | `user-management.spec.ts` (6) | regression | an account that accepted an invitation or used a reset link cannot be deleted (immutable audit rows point at it): the run's database is thrown away |
| Access control (who may see and do what: `docs/testing/access-control.md`) | a VIEWER, an AUTHOR, a STEWARD and a COMPLIANCE_OFFICER over a tenant (see, write, publish, approve, compliance), the ADMIN of tenant A against tenant B (switcher, `/api/tenants`, a forged cookie, B's entity by address and by id), an AUTHOR of one domain and of one product (the sibling's absence, not-found, a write refused), a user with no role (`/no-access`, nothing from `/api/*`), a user disabled while signed in, the refusal of an emission whose references the caller may not read (fixed: it used to include them), `AUTH_REGISTRATION=invite` against the second app; each in the screens, the endpoints and a server action POSTed by hand | `access-matrix.spec.ts` (11) | regression (the invite-mode test also `@external`) | the ladder is linear: a COMPLIANCE_OFFICER holds the author's and the steward's rights too (a decision, pinned by one assertion, not a defect); the controls of an act a person may not do are drawn and refused, not hidden; `closed` registration has no browser proof |
| REST API v1 and webhooks | health, schemas, emit, validate, event specs, notifications, webhooks, who may call what, bad requests, the rate limit | `api-v1.spec.ts` (71), and the unit tests of the routes | smoke 1, rest regression | KD-027 (a webhook URL has no policy), KD-028 (the rate limit is per process) |
| Accessibility | an axe scan (WCAG 2.1 A and AA) of every route and of the dialogs and palette states that matter (the Admin Users screen's dialogs, panel, role matrix, no-permission screen and a table with a disabled account and a pending invitation included), against a recorded baseline | `a11y.spec.ts` (36), project `a11y` | regression (inside the regression and nightly tiers) | only the dark theme is scanned (`docs/testing/a11y.md`); the baseline was measured with Chrome on macOS: KD-037 |
| Visual regression | nine pages, compared to screenshots made in the Playwright image | `visual.spec.ts` (9), project `visual`, image only | `visual` tier, by hand and the `e2e-visual` job | the snapshots were made on arm64, CI is x86-64: KD-037 |
| Not tested in a browser | Git export (no UI exists), `/dev/design-system` (development only), sign-in through an identity provider (external; the login page's provider buttons and the sign-in decision are unit tested, and a run shows none by default), real Spanner and BigQuery (only the emulators, in the corpus), Firefox and WebKit beyond the smoke tests | | | |

## Per-spec table

Generated by `node scripts/e2e-counts.mjs --specs` (the `visual` runs are the Playwright image's; the others are this machine's; the login project is not counted). Regenerate and paste it
when a test is added or removed: the unit test compares the two.

<!-- counts:begin -->
| Spec | Tests | Tags | smoke runs | regression runs | nightly runs | visual runs |
| --- | --- | --- | --- | --- | --- | --- |
| a11y.spec.ts | 36 | @regression 36 | 0 | 36 | 36 | 0 |
| access-matrix.spec.ts | 11 | @external 1, @regression 11 | 0 | 10 | 11 | 0 |
| admin.spec.ts | 23 | @regression 23 | 0 | 23 | 23 | 0 |
| api-v1.spec.ts | 71 | @regression 71, @smoke 1 | 1 | 71 | 71 | 0 |
| auth.spec.ts | 43 | @regression 43, @smoke 5 | 5 | 43 | 43 | 0 |
| authored-lifecycle.spec.ts | 4 | @regression 4 | 0 | 4 | 4 | 0 |
| dashboard-not-found.spec.ts | 2 | @regression 2 | 0 | 2 | 2 | 0 |
| discovery.spec.ts | 21 | @regression 21, @smoke 1 | 1 | 21 | 21 | 0 |
| domain-assets.spec.ts | 12 | @regression 12 | 0 | 12 | 12 | 0 |
| entity-field-edit.spec.ts | 3 | @regression 3 | 0 | 3 | 3 | 0 |
| entity-publish-versions.spec.ts | 7 | @regression 7, @smoke 1 | 1 | 7 | 7 | 0 |
| entity-tabs.spec.ts | 15 | @regression 15 | 0 | 15 | 15 | 0 |
| events-builder-layout.spec.ts | 2 | @regression 2 | 0 | 2 | 2 | 0 |
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
| user-management.spec.ts | 6 | @regression 6 | 0 | 6 | 6 | 0 |
| visual.spec.ts | 9 | @regression 9, @visual 9 | 0 | 0 | 0 | 9 |
<!-- counts:end -->

## The last full run

<!-- final-run:begin -->
The release check of 2026-10-25, on an Apple Silicon laptop, Node 20.19.4, Google Chrome 155 for the Chromium projects, from the commit that carries this table. **Firefox and WebKit were not installed on that
machine and could not be: their 40 smoke runs (20 tests x 2 browsers) were not run**, so the three-browser claim of the smoke tier is untested here.

| Run | Command | Result | Time |
| --- | --- | --- | --- |
| Unit tests | `npx vitest run tests/unit` | 654 files, 12,751 passed, 1 expected failure (the `it.fails` pin of KD-032); the first run had one load flake (a scan of `src` that timed out at 5 s with the whole suite running: fixed) | 154 s |
| Corpus | `npm run test:corpus` | 306 cases x 8 targets: 329 tests passed; every failure is a known one (json-schema 14, openapi3 14, avro 13, protobuf 10, java-pojo 15, postgresql 4, spanner 4, bigquery 9) | 543 s |
| Nightly tier, Chromium + `a11y` + `serial-after` | `node scripts/e2e-release.mjs --tier nightly --project chromium --project a11y --project serial-after` | **384 passed, 0 failed, 0 flaky, 0 skipped** (the two `@external` tests ran: the network import, and the git-mode `any` test on the second app), on two runs in a row. The first run of the day had 374 passed, 1 failed (the lineage Fit test, a load flake: its baseline is now the Fit button's own view, KD-039) and 9 `serial-after` tests that did not run because their dependency failed: the skipped-test gate listed them as NOT ALLOWED | 12 min 04 s and 11 min 40 s (the build 1 min 17 s) |
| Visual tier | `npm run test:e2e:visual` | 10 passed (nine screenshots and the login), in the Playwright image | 1 min 47 s |
| Smoke tier, Chromium only | `node scripts/e2e-release.mjs --tier smoke --project chromium` | 21 passed on every run (also with the bundled Chromium, three times). Two of four runs with Google Chrome and a fresh build then sat idle for 11 minutes after the last test before the Playwright process ended on its own (docs/testing/e2e.md, "A run that stalls") | 30 s to 12 min 45 s |

Expected failures that keep the run green (the `[KD-nnn ...]` tests of the guard): KD-014, KD-015, KD-017 and KD-019 each fail as stated (a fifth, the webhook creation by the API key, was fixed with the access-control work), and the run reports them as passed.

Known defects at this release (`docs/testing/known-defects.md`): **4 open**, each pinned by a test that fails as stated (KD-014, KD-015, KD-017, KD-019), 28 `no-test` (a gap or a design limit that nothing in the suite pins: KD-034, KD-036 to KD-039 are new this wave, KD-043, KD-044 and KD-047 came with the access-control work) and 3 `dead-code` (KD-004, KD-005, KD-022).
<!-- final-run:end -->
