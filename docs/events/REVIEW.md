# Events (AsyncAPI) — review guide

Status: **as built, 2026-10-16** (completion round merged: publish and versions, used-by, external references, in-app leave guard, contacts editing). This is the map for reviewing the Events work: what it is, how to run it, the order in which to read the code, which decisions shaped it, and what is not done. Design history lives in `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (decisions E1–E9) and the plans in `docs/superpowers/plans/` (`2026-10-16-events-completion.md` is the latest).

## 1. What this is

An **Event** is one asset: an AsyncAPI 3 document edited in a visual builder. Servers, channels, messages (with payload entity), operations and message properties ("traits") live **inside** the event; there are no separate Message / Channel / Event Spec assets any more.

- **New Event** is the only event entry in the product's *New* menu. Events are listed flat on the product page.
- **Builder** (Design tab): vertical outline — Metadata, Servers, Channels, Messages, Operations, Message properties (Trait), Advanced. Every AsyncAPI 3.0 property is a ready-made, labelled field (generated from `@asyncapi/specs`, coverage is tested). Identifiers (keys) are generated and hidden behind a collapsed "Identifier".
- **Payload format**: a message picks an entity and a *Representation* — **Auto** (the entity's recorded source format, else the protocol default: Kafka → Avro, anything else → JSON Schema) or an explicit Avro / JSON Schema / Protobuf. The form says what Auto resolved to and why.
- **Message properties (Trait)**: reusable property sets. **Built in**: CloudEvents 1.0 and W3C Trace Context (created for every tenant, read-only everywhere, properties shown in the UI). **Library**: Tenant/Domain traits. **Local**: defined in the event with a Properties table. Added from one **+ Add** (applies to Message | Operation).
- **External references**: Channels and Messages each have a "from another event" card. A three-step picker (search published events of the tenant → pick a version, newest preselected → pick the channel or message) adds a reference pinned to **one published version**; the event itself is never offered. Each reference shows its source event, version and item, a status line ("v1.0 → v2.0 available", major called out) and **Update** / **Remove**. Update is always manual and is refused when an operation uses an item the latest version no longer has; Remove shows the impact first. Operations can use external channels and messages (marked "(external)").
- **Right panel**: the AsyncAPI document as live YAML/JSON (CodeMirror 6): instant from the unsaved draft, then enriched with real payload schemas from the server. The **Docs** tab renders the documentation.
- **Publish, Versions, Used by**: the header **Publish** button (enabled for a saved draft without problems) opens the shared raise-only dialog: the suggested bump, a lower one refused, every blocker listed once. **Publish cuts from the saved draft only.** The **Versions** tab lists the published versions, newest first, and shows the stored AsyncAPI document of the one you press **View** on, read-only as YAML or JSON (`?tab=versions&version=<label>`). **Used by** lists the events whose external references point at this one (draft and published references; the list is cut at 50 and says so).
- **Leaving with unsaved edits**: a dialog (*Save & leave / Discard & leave / Stay*) appears for link clicks, explorer rows, the command palette, the new-entity shortcut, the notification centre and the browser Back button; tab/section/item switches inside the page never prompt. Closing the tab or reloading still uses the browser's own warning.
- **Product**: Engineering Lead, Manager and Team emails (`email` or `Name <email>`) on *Create New Product* and, afterwards, **Edit contacts** on the product page.
- **Not built**: see §6.

## 2. Run it

```bash
npm run db:deploy            # applies migrations (also installs the built-in traits for every tenant)
npm run db:seed-events-demo  # idempotent demo data: Payments/Checkout + Risk/Fraud, entities, events incl. the showcase `order-platform`
npm run dev                  # http://localhost:3000 — Payments → Checkout → Events
```

In a **git worktree** with a symlinked `node_modules`, Turbopack refuses to start; use `npx next build --webpack` then `AUTH_TRUST_HOST=true npx next start -p 3000` (`next start` needs the trusted-host flag or logins bounce). In a normal checkout none of this applies.

## 3. Read it in this order

| # | Area | Where | What to look at |
|---|---|---|---|
| 1 | Document model | `src/lib/events/document/{types,parse,parse-objects,keys}.ts` | The v2 document (`documentVersion: 2`), one pure parser used by browser and server, key rules, JSON-pointer problems |
| 2 | Resolution & emission | `document/{resolve,representation,instant-asyncapi,edges,bump}.ts`, `src/lib/event-specs/*` | Document → resolved spec → AsyncAPI (assembler/serializer/validator are shared), Auto/explicit representation, bump rules, reference edges; `externalChannelCopy` in `resolve.ts` (an external channel keeps none of its source event's server/message references) |
| 3 | Services & guards | `src/services/events/{event.service,event-snapshot,event-emit.service,event-publish.service,event-publish-facts,external-refs.service,usage.service,event-guards,trait.service,bundled-traits.service,service-guards}.ts` | Event CRUD with reference validation, snapshot → render → emit, **publish** (prepare unlocked → transaction: `event_specs FOR UPDATE`, `entities FOR SHARE` sorted, re-verify, insert-only version, edges), external-reference loaders, used-by, edge-based "in use" guards for entities / traits / events / products |
| 4 | Built-in traits | `src/lib/events/bundled-traits.ts`, `scripts/db.ts` (`ensure`) | The two definitions, `propertySummary`, read-only enforcement, idempotent install per tenant |
| 5 | Database | `prisma/migrations/20261016…20261020*` | v2 enum + `resolvedSpec` column, product contacts, and the **guarded drop of the legacy catalog** (refuses to run, deleting nothing, if any legacy row exists). The completion round added no migration |
| 6 | Template catalog | `src/lib/events/templates/*`, `scripts/generate-asyncapi-templates.ts` | Per-object field templates and per-protocol binding templates, generated from `@asyncapi/specs`; stale-file and coverage tests |
| 7 | Builder UI | `src/features/events/builder/**` | `EventBuilder`, `use-event-draft` (dirty/problems/save), sections (incl. `ExternalRefPicker`, `ExternalRefsCard`, `use-external-ref-status`), `template/` (TemplateForm + typed controls + `JsonEditor`), shared `Identifier` / `auto-key` / `references` / `graph-parts` |
| 8 | Event page | `src/features/events/event-page/**`, `builder/{use-leave-guard.ts,UnsavedChangesDialog.tsx}`, `src/lib/navigation/before-navigate.ts`, `shared/{PublishVersionButton,EventVersionList,UsedByPanel}.tsx` | Page (header Publish button, four tabs), Docs tab, Versions tab (`VersionsTab`, `use-event-versions`), live code panel (`use-event-code`, `EventCodePanel`), the leave guard, loaders (tenant-scoped) |
| 9 | Library traits UI | `src/features/events/traits/**`, `workspace/TraitsTab.tsx` | Enterprise/Domain "Message properties (Trait)" tab and editor |
| 10 | Products | `src/lib/mailbox.ts`, `src/lib/product-contacts.ts`, `product-grid.tsx`, `components/EditProductContactsDialog.tsx`, `domain-workspace.tsx`, `product.service.ts` | Mailbox parsing (`Name <email>`), chip input, validation, the edit dialog (sends only the contact fields) |

## 4. Tests

- Unit + integration: `npx vitest run tests/unit tests/integration` (integration uses the dev PostgreSQL from `.env`; tests use unique names and clean up).
- Browser: `npx playwright test tests/e2e/events-builder.spec.ts tests/e2e/events-publish.spec.ts tests/e2e/events-external-refs.spec.ts tests/e2e/events-leave-guard.spec.ts tests/e2e/product-contacts.spec.ts tests/e2e/navigation.spec.ts tests/e2e/dashboard-not-found.spec.ts` (needs the app on :3000 and the seeded admin; see `tests/e2e/helpers`). The publish and external-reference specs use the real TypeSpec CLI and can be slow: run with `--workers=1` if they time out under load. `events-leave-guard` is Chromium-only (it relies on the Navigation API for the Back button).
- DB migrations on PGlite (no server needed): `tests/integration/db/*-pglite.test.ts`, including the guard migration (clean DB passes; every legacy-row case raises).
- Known baseline failures, unrelated to events: 4 × `db-emitter-parity` (broken `@typespec/db`), 3 × `schemas-tab`, 1 × `e2e-critical-flows` (bigquery). TypeSpec-CLI tests (`emission-pipeline`, `all-types-roundtrip`, `typespec-official/emitter.service`) can time out under heavy machine load and pass alone. Repo-wide ESLint has 36 older errors outside the events code (same on `main`).

## 5. Decisions worth challenging

- **Self-contained document** (E1/E2): reuse is by copy; cross-product use is a pinned reference to a *published* event version. No shared Message/Channel catalog.
- **One version per event** (E3), entity pins per message; bump rules at event level (`document/bump.ts`).
- **Keys are generated** (R3); they are real document keys, so renames rewrite references (`renameKey`).
- **Format follows the message** (R4), not the channel; a channel's `format` is only an optional override.
- **Built-in traits are data, not code paths** (MP2): ordinary library traits with an `x-bundled` marker that the services honour; the marker never appears in emitted AsyncAPI.
- **Section naming** (MP1): the section is called "Message properties (Trait)" but also holds operation property sets, grouped. One constant file (`builder/labels.ts`) controls every label.
- **Publish cuts from the saved draft only** and is blocked until every pin (including a library trait's headers entity) is pinned to a published version; the version row is insert-only and freezes the document, the draft, the library traits and the resolved spec, and records the effective payload format of every message (`compatReport.representations`), so a change that only comes from an entity's recorded source format reads as a change (MAJOR) at the next publish.
- **Entity delete is race-free against publish**: the "is it pinned by an event?" guards and the delete run in one transaction under a lock on the entity row (`deleteEntityGuarded` in `src/services/events/entity-pin-usage.ts`, used by both `deleteEntity` and the UI's `deleteEntityAction`); publish takes the same row `FOR SHARE`, so a publish and a delete serialize.
- **No "Source" tab**: the live Code panel is the source view; Versions → View shows a published version's code.
- **External references are pinned to one version and updated manually** — a status line says a newer version exists, nothing changes by itself. An external channel brings no messages of its own: its messages come from the operations that use it.
- **Leave guard**: the browser's Navigation API cannot stop Next's `router.push` (Next renders the new route first and calls `history.pushState` afterwards), so the guard intercepts link clicks and the shell code that navigates asks first through `canNavigate(href)` (`src/lib/navigation/before-navigate.ts`). Back/Forward is cancelled through the Navigation API (Chromium) or a history sentinel elsewhere. **Any new programmatic `router.push` must ask `canNavigate` first** or it will silently skip the guard.
- **Governance for MAJOR publishes is not wired for events** (it never was); `governanceRequestId` stays unused.
- **Squash vs history**: the first big merge to `main` was one squashed commit (no trailer); the cleanup and completion rounds were merged with their individual commits (`--no-ff`).

## 6. Known gaps / backlog

1. **AsyncAPI importer** ("Import existing…" in the New Event dialog) — `AsyncApi3Adapter.import()` is `NOT_IMPLEMENTED` (Epic 19).
2. **Infra provider** — only the optional `origin` seam exists; there is no provider registry or sync.
3. **Schema-aware JSON lint** — not built. `JsonEditor`'s `schema` prop is reserved and ignored, and no JSON Schema validator exists in the repo; `codemirror-json-schema` cannot be installed (the registry answers 403 by security policy) and `ajv` is only a transitive dependency. The JSON fields show parse errors and the builder's own problems.
4. **External-reference auto-update** — by design manual; there is no notification beyond the status line.
5. **Programmatic navigation** — covered sites: sidebar, command palette, new-entity shortcut, notification centre. Any new call site must use `canNavigate`. In browsers without the Navigation API, Back after a save can need one extra click (history sentinel).
6. **Role gating** — product create / update / delete (and the new Edit contacts) and event publish require a signed-in user of the tenant but do not check the role (`runProductAction` / `runMutation` resolve the role without enforcing it). Entity publish behaves the same.
7. **Sticky Save bar** — it overlays form content while scrolling by design; the clipping reported earlier was not reproducible at maximum scroll. If a focused control ends up under the bar, the fix is `scroll-padding-bottom` on `<main>` in `DashboardClientShell.tsx`.
8. **Copy leftovers** — "trait" still appears in a few problem messages for malformed hand-written documents (`parse-objects.ts`, `resolve.ts`, `event.service.ts`); the pinned-headers note is a literal rather than a `labels.ts` constant.
9. **Retire vs publish — product rule needed.** Publish ignores an entity's status, so a draft can pin (and publish) a *retired* entity. Nothing dangles, but decide whether publish should refuse pins on retired entities; retire's guard stays non-locking until then.
10. **Residual races** — publishing an *entity version* (`entity-version.service.ts`) does not lock the entity row, so the same guard-versus-edge window remains for the entity-to-entity reference guard; `deleteEntityGuarded` relies on READ COMMITTED (the default).
11. **Big scopes** — the cross-product delete guard excludes the scope's own events with an `IN` list; past roughly 1,600 events (at ~20 versions each) in ONE product/domain the query would exceed the driver's bind limit and the delete would be refused with a generic database error instead of the actionable message. Paging the scan would remove the limit.
12. **Wording leftovers** — "trait" still appears in the publish dialog blocker for an unpinned library trait (`event-publish-facts.ts`), the product-delete blocker ("1 trait"), the entity delete guard ("used by Trait"), bump reasons and `trait.service`/`name-registry` texts.
13. **Small UX leftovers** — a vetoed notification click that is then confirmed leaves the notification unread; the visible Publish hint shifts the header toolbar when it appears; `UsedByPanel` can say "first 0 references" in a rare truncated-but-empty case; the Publish dialog headline repeats the joined blocker messages above the folded list.
