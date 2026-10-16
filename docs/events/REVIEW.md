# Events (AsyncAPI) — review guide

Status: **as built, 2026-10-17.** This is the map for reviewing the Events work: what it is, how to run it, the order in which to read the code, which decisions shaped it, and what is not done. Design history lives in `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (decisions E1–E9) and the plans in `docs/superpowers/plans/`.

## 1. What this is

An **Event** is one asset: an AsyncAPI 3 document edited in a visual builder. Servers, channels, messages (with payload entity), operations and message properties ("traits") live **inside** the event; there are no separate Message / Channel / Event Spec assets any more.

- **New Event** is the only event entry in the product's *New* menu. Events are listed flat on the product page.
- **Builder** (Design tab): vertical outline — Metadata, Servers, Channels, Messages, Operations, Message properties (Trait), Advanced. Every AsyncAPI 3.0 property is a ready-made, labelled field (generated from `@asyncapi/specs`, coverage is tested). Identifiers (keys) are generated and hidden behind a collapsed "Identifier".
- **Payload format**: a message picks an entity and a *Representation* — **Auto** (the entity's recorded source format, else the protocol default: Kafka → Avro, anything else → JSON Schema) or an explicit Avro / JSON Schema / Protobuf. The form says what Auto resolved to and why.
- **Message properties (Trait)**: reusable property sets. **Built in**: CloudEvents 1.0 and W3C Trace Context (created for every tenant, read-only everywhere, properties shown in the UI). **Library**: Tenant/Domain traits. **Local**: defined in the event with a Properties table. Added from one **+ Add** (applies to Message | Operation).
- **Right panel**: the AsyncAPI document as live YAML/JSON (CodeMirror 6): instant from the unsaved draft, then enriched with real payload schemas from the server. The **Docs** tab renders the documentation.
- **Product**: Engineering Lead, Manager and Team emails (`email` or `Name <email>`) on *Create New Product*.
- **Not built**: Publish / Versions UI, external-reference UI (the backend pieces exist), editing contacts of an existing product — see §6.

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
| 2 | Resolution & emission | `document/{resolve,representation,instant-asyncapi,edges,bump}.ts`, `src/lib/event-specs/*` | Document → resolved spec → AsyncAPI (assembler/serializer/validator are shared), Auto/explicit representation, bump rules, reference edges |
| 3 | Services & guards | `src/services/events/{event.service,event-snapshot,event-emit.service,event-guards,trait.service,bundled-traits.service}.ts` | Event CRUD with reference validation, snapshot → render → emit, edge-based "in use" guards for entities / traits / events / products |
| 4 | Built-in traits | `src/lib/events/bundled-traits.ts`, `scripts/db.ts` (`ensure`) | The two definitions, `propertySummary`, read-only enforcement, idempotent install per tenant |
| 5 | Database | `prisma/migrations/20261016…20261020*` | v2 enum + `resolvedSpec` column, product contacts, and the **guarded drop of the legacy catalog** (refuses to run, deleting nothing, if any legacy row exists) |
| 6 | Template catalog | `src/lib/events/templates/*`, `scripts/generate-asyncapi-templates.ts` | Per-object field templates and per-protocol binding templates, generated from `@asyncapi/specs`; stale-file and coverage tests |
| 7 | Builder UI | `src/features/events/builder/**` | `EventBuilder`, `use-event-draft` (dirty/problems/save), sections, `template/` (TemplateForm + typed controls + `JsonEditor`), shared `Identifier` / `auto-key` / `references` |
| 8 | Event page | `src/features/events/event-page/**` | Page, Docs tab, live code panel (`use-event-code`, `EventCodePanel`), loaders (tenant-scoped) |
| 9 | Library traits UI | `src/features/events/traits/**`, `workspace/TraitsTab.tsx` | Enterprise/Domain "Message properties (Trait)" tab and editor |
| 10 | Products | `src/lib/mailbox.ts`, `src/lib/product-contacts.ts`, `product-grid.tsx`, `product.service.ts` | Mailbox parsing (`Name <email>`), chip input, validation |

## 4. Tests

- Unit + integration: `npx vitest run tests/unit tests/integration` (integration uses the dev PostgreSQL from `.env`; tests use unique names and clean up).
- Browser: `npx playwright test tests/e2e/events-builder.spec.ts tests/e2e/navigation.spec.ts tests/e2e/dashboard-not-found.spec.ts` (needs the app on :3000 and the seeded admin; see `tests/e2e/helpers`).
- DB migrations on PGlite (no server needed): `tests/integration/db/*-pglite.test.ts`, including the guard migration (clean DB passes; every legacy-row case raises).
- Known baseline failures, unrelated to events: 4 × `db-emitter-parity` (broken `@typespec/db`), 3 × `schemas-tab`, 1 × `e2e-critical-flows` (bigquery). TypeSpec-CLI tests (`emission-pipeline`, `all-types-roundtrip`, `typespec-official/emitter.service`) can time out under heavy machine load and pass alone.

## 5. Decisions worth challenging

- **Self-contained document** (E1/E2): reuse is by copy; cross-product use is a pinned reference to a *published* event version. No shared Message/Channel catalog.
- **One version per event** (E3), entity pins per message; bump rules at event level (`document/bump.ts`).
- **Keys are generated** (R3); they are real document keys, so renames rewrite references (`renameKey`).
- **Format follows the message** (R4), not the channel; a channel's `format` is only an optional override.
- **Built-in traits are data, not code paths** (MP2): ordinary library traits with an `x-bundled` marker that the services honour; the marker never appears in emitted AsyncAPI.
- **Section naming** (MP1): the section is called "Message properties (Trait)" but also holds operation property sets, grouped. One constant file (`builder/labels.ts`) controls every label.
- **Squash vs history**: the first big merge to `main` was one squashed commit (no trailer); this round keeps the individual commits.

## 6. Known gaps / backlog

1. Publish / Versions / Used-by / Source tabs and the v2 publish service (the generic publish libs are kept for it).
2. External-reference picker (document + edges + resolution exist; no UI).
3. Edit an existing product's contacts (service and update action accept them; no UI).
4. In-app "unsaved changes" guard (only the browser unload warning today).
5. `codemirror-json-schema` (schema-aware JSON lint) not installed — it needs seven packages that could not be added safely; `JsonEditor` already takes a `schema` prop.
6. Cosmetic: the sticky Save bar clips form content behind it on short windows.
7. The old custom `CloudEvents-legacy` library trait and the `CloudEventsHeaders` entity remain in the dev DB while the user's `checkout-event` references them.
