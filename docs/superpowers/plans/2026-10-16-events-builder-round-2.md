# Events builder — round 2: schema-driven AsyncAPI builder, code panel, product contacts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax. Each work package (WP) is dispatched to its own agent in its own worktree; the controller merges.

**Goal:** Fix what the first slice got wrong after the user's review (2026-10-16): (1) products need Engineering Lead, Manager and Team Emails; (2) the Event builder must expose **every** AsyncAPI 3.0 part as a ready-made template where the user only fills values, with no keys to type; (3) a message's payload format follows the chosen entity automatically or can be chosen explicitly; (4) the right-hand Detail Panel shows the AsyncAPI being built as code, live.

**Spec:** `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (this plan amends §7: builder UX, and Q7: "format on the channel" → format follows the message).
**Slice 1 state:** `docs/superpowers/plans/2026-10-15-events-self-contained-phase-b1-vertical-slice.md` (merged; builder shell, sections, event page).

## What the user said (verbatim in substance)

- *Product create:* Eng. Lead, Manager and Team email addresses; an address may carry the name (`Jane Doe <jane@acme.com>`), so no separate name field.
- *Events:* "an ability to create a new event which is an AsyncAPI specification, and all the parts available in AsyncAPI should be available for the user to add visually — horizontal or vertical tabs, let's think about what makes sense. We need a way where the **template is available**: for a server the user doesn't have to specify the key; those keys are already available. What are the possible keys for channel, servers, message traits…? All available keys should be available and the user just provides values."
- *Message:* "If the user selects just an entity, that automatically sets whether it's Avro or JSON based on the entity. Or the user can explicitly select [a representation] so that representation of the entity is used."
- *Detail panel:* "must be really used to show the preview of what is getting built in the code way."

## Decisions

| # | Decision |
|---|---|
| R1 | **Layout:** vertical outline for the document's parts (there are 8 and several are lists with counts, which a horizontal tab bar cannot hold), horizontal tabs only for *views*: **Design \| Docs**. The right Detail Panel is the live **Code** view. |
| R2 | **Template-driven forms.** Every property the AsyncAPI 3.0 spec defines for an object is shown as a labelled field with the spec's help text. Required and common ones come first; the rest sit under an expanded-on-demand "More properties" group that shows how many are set. Empty values are omitted from the output. The catalog is generated from / verified against `@asyncapi/specs` so "all available keys" is a tested claim, not a promise. |
| R3 | **No keys typed.** Identifiers (server/channel/message/operation/trait keys) are generated from what the user types (title, host, address, name…) and kept unique; the user never sees them unless they open "Identifier" under Advanced to rename (rename still rewrites references). |
| R4 | **Message representation.** A message picks an entity (+ version) and a *Representation*: **Auto** (default) \| Avro \| JSON Schema \| Protobuf. Auto resolves, in order: the entity's own recorded source format (if the code records one and it is Avro/JSON Schema/Protobuf) → the protocol default (Kafka → Avro, everything else → JSON Schema) → JSON Schema. The UI always shows what Auto resolved to and why. The channel no longer asks for a format (its `format` becomes an optional override, absent = follow the messages). |
| R5 | **Code panel.** The Detail Panel renders the AsyncAPI document as YAML (JSON toggle, copy). It is instant (built client-side from the unsaved draft, payload schemas shown as `Entity@version` placeholders) and enriched in the background by the server render with the real payload schemas. Diagnostics sit on top. The **Docs** tab keeps the rendered-documentation view. |
| R6 | **Traits** become a first-class section: message traits and operation traits, local (full templates) or picked from the Tenant/Domain library. |
| R7 | **Bindings** use protocol templates generated from the `@asyncapi/specs` binding schemas (Kafka, Google Pub/Sub, Pulsar and every other protocol the package ships), per target (server/channel/operation/message). Required binding keys (e.g. Pub/Sub `schemaSettings`) are marked required. |
| R8 | **Product contacts:** `engineeringLead`, `manager` (one mailbox each) and `teamEmails` (list); a mailbox is `email` or `Name <email>`. |
| R9 | **Run-the-right-build note:** the user tested `main` (port 3001) and saw the old UI. The new build is `feat/events-self-contained`. Until it is merged, it runs from the worktree (see "Running it" below). |

## Work packages

### Wave 1 (independent, run in parallel)

**WP-P — Product contacts.** Files: `prisma/schema.prisma` (+ additive migration), a pure lib `src/lib/mailbox.ts` (`parseMailbox`, `parseMailboxList`, `formatMailbox`), `src/services/product.service.ts` (+ create/update), server actions that create/update products, `src/app/(dashboard)/schemas/[domainSlug]/product-grid.tsx` ("Create New Product" dialog, ~L185-280) and the product edit/settings surface, product page header display, tests. Behavior: `Product.engineeringLead String?`, `Product.manager String?`, `Product.teamEmails String[] @default([])`. A mailbox parses `jane@acme.com`, `Jane Doe <jane@acme.com>`, `"Doe, Jane" <jane@acme.com>`; rejects anything else with a field-level message; list input accepts comma/semicolon/newline separated values and shows them as removable chips; duplicates (case-insensitive email) collapse; empty is allowed (all three optional). Display: name + `mailto:` link. No `db:deploy` by the agent.

**WP-T — Template catalog (pure lib).** Files: `src/lib/events/templates/{types,objects,bindings,keys,index}.ts`, tests `tests/unit/lib/events/templates/*`. Interfaces:
```ts
export type FieldKind = "text" | "markdown" | "url" | "email" | "enum" | "boolean" | "integer" | "stringList" | "keyValue" | "json" | "object" | "list" | "tags" | "reference" | "entityPin";
export interface FieldTemplate {
  key: string;                    // the AsyncAPI property name, e.g. "protocolVersion"
  label: string; kind: FieldKind; required?: boolean;
  help?: string;                  // plain-language, from the spec description
  placeholder?: string; example?: string;
  options?: Array<{ value: string; label: string; help?: string }>;   // kind "enum"
  suggestions?: string[];         // free-text with suggestions (protocols, content types, …)
  fields?: FieldTemplate[];       // kind "object" | "list": the item shape
  group: "basics" | "more";       // basics = required + common; more = the rest (still shown, collapsed by default)
}
export type ObjectTemplateId = "info" | "contact" | "license" | "externalDocs" | "tag" | "server" | "serverVariable" | "channel" | "channelParameter"
  | "operation" | "operationReply" | "operationReplyAddress" | "operationTrait" | "message" | "messageTrait" | "messageExample" | "correlationId" | "securityScheme";
export interface ObjectTemplate { id: ObjectTemplateId; label: string; fields: FieldTemplate[] }
export const TEMPLATES: Record<ObjectTemplateId, ObjectTemplate>;
export function bindingTemplate(protocol: string, target: "server" | "channel" | "operation" | "message"): ObjectTemplate | null; // from node_modules/@asyncapi/specs/bindings/<protocol>/<latest>/<target>.json
export const BINDING_PROTOCOLS: string[];       // every protocol directory the package ships
export type KeyKind = "server" | "channel" | "message" | "operation" | "trait" | "externalRef";
export function suggestKey(kind: KeyKind, values: Record<string, unknown>, taken: Iterable<string>): string; // title → name → host/address/… → fallback `${kind}`; slug + unique, ≤ 64, matches KEY_PATTERN
```
The **coverage test** loads `@asyncapi/specs/schemas/3.0.0.json` (definitions are URL-keyed: `http://asyncapi.com/definitions/3.0.0/<name>.json`; `info`'s and `message`'s properties come through `allOf`/`$ref`s — resolve them) and asserts that each template lists every non-`x-` property of its object (an explicit `IGNORED` map with a reason is allowed, e.g. `$ref`-only forms and `bindingVersion`), and that every `required` property is `required: true`. Binding templates: map JSON Schema → `FieldKind` (`string`→text/enum, `integer`→integer, `boolean`, `array of string`→stringList, `object`→object with `fields` or keyValue, others→json), carry `required`, `description`→`help`, `bindingVersion` omitted from fields (set automatically). Curated labels/groups for Kafka, Google Pub/Sub, Pulsar; generic humanising of camelCase for the rest. Pure TypeScript, client-safe (the spec JSON is read at build/test time into a generated module `bindings.generated.ts` via a script `scripts/generate-asyncapi-templates.ts` + npm script `gen:asyncapi-templates`, committed, with a test that fails when the generated file is stale).

**WP-1a — Document model completeness.** Files: `src/lib/events/document/{types,parse}.ts`, `src/lib/event-specs/types.ts`, `src/lib/event-specs/assemble.ts` (additive emission only), `src/lib/events/document/resolve.ts` (carry new fields), tests. Make every AsyncAPI 3.0 property representable and emitted (all optional, additive; existing documents still parse; every existing test stays green). Types (contract — UI work depends on these exact shapes):
```ts
export interface DocExternalDocs { url: string; description?: string }
export interface DocTag { name: string; description?: string; externalDocs?: DocExternalDocs }
// info: EventSpecInfo gains termsOfService?; contact?: { name?; url?; email? }; license?: { name: string; url? }; tags?: DocTag[]; externalDocs?: DocExternalDocs
// DocServer gains: title?; summary?; variables?: Record<string, { enum?: string[]; default?: string; description?: string; examples?: string[] }>;
//                  security?: string[] /* keys of components.securitySchemes */; tags?: DocTag[]; externalDocs?: DocExternalDocs; bindings?: JsonObject
// DocChannel gains/keeps: parameters?: Record<string, { description?: string; enum?: string[]; default?: string; examples?: string[]; location?: string }>; tags?; externalDocs?; bindings?
// DocMessage gains: name?; deprecated?: boolean; correlationId?: { location: string; description?: string }; tags?; externalDocs?; bindings?: JsonObject;
//                   examples?: Array<{ name?: string; summary?: string; headers?: JsonObject; payload?: JsonValue }>
// DocOperation gains: title?; security?: string[]; tags?; externalDocs?; bindings?; reply gains address?: { location: string; description?: string }
// DocTrait (local): spec is validated per kind — message traits allow {name,title,summary,description,contentType,correlationId,tags,externalDocs,deprecated,examples,bindings} (+ headers pin), operation traits allow {title,summary,description,security,tags,externalDocs,bindings}; unknown keys other than `x-…` are a problem at /traits/<i>/spec/<key>
// components.securitySchemes?: Record<string, { type: "userPassword"|"apiKey"|"X509"|"symmetricEncryption"|"asymmetricEncryption"|"httpApiKey"|"http"|"oauth2"|"openIdConnect"|"plain"|"scramSha256"|"scramSha512"|"gssapi"; description?: string; [typeSpecific: string]: unknown }>
```
Validation: URLs are absolute `http(s)`/`mailto`-free URLs where AsyncAPI says `format: uri`; emails valid; `security` entries must exist in `components.securitySchemes`; `variables` keys must appear as `{name}` in the server host or pathname (problem otherwise); reply address `location` is a runtime expression `$message.header#/…` or `$message.payload#/…`. Parser output keeps authored order; undefined/blank dropped. The assembler emits each new field in AsyncAPI-canonical position (read the existing assembler to follow its ordering helpers); goldens for existing fixtures must not change.

**WP-Code — Live code in the Detail Panel.** Files: `src/lib/events/document/instant-asyncapi.ts` (pure), `src/features/events/event-page/{EventCodePanel.tsx,use-event-code.ts}`, edits to `src/features/events/event-page/EventPage.tsx` (replace `HideEmptyRightPanel` with the shell's right-panel content mechanism — find how `entity-workspace.tsx` fills the Detail Panel, and `src/components/layout/*` for the slot/portal), tests. Interfaces:
```ts
export function buildInstantAsyncApi(doc: EventDocument, opts: { productSlug: string; entityLabels: ReadonlyMap<string, string> /* entityId → "Order" */ }):
  { document: JsonObject | null; yaml: string; json: string; diagnostics: Diagnostic[] };
// payload/headers/key schemas are placeholders (`{ "x-entity": "Order@1.0" }` or similar, clearly marked); uses resolveDocument + assembleAsyncApi3 + the existing serializer with placeholder artifacts; never throws; if the draft does not parse, returns { document: null, yaml: "", … } with the parse problems as diagnostics.
```
`EventCodePanel({ doc, event, productId, entityLabels, problems })`: header with YAML | JSON toggle and Copy; shows the instant code immediately on every edit (no debounce needed; it is cheap), a status chip "Rendering payload schemas…" / "Full schemas" while the debounced (800 ms) server render (`previewEventDocumentAction`, already merged) runs, and swaps in the server's YAML when it returns for the same doc (ignore stale responses); diagnostics (draft pointers and emitted-document pointers) in a collapsible list above the code; read-only monospace `<pre>` with line numbers and light syntax colouring (reuse `CodeViewer` from `src/components/custom/EmissionPreviewPanel/EmissionPreviewPanel.tsx` if it fits; **no new dependencies**); when the right panel is closed the work is skipped. The Event page's **Preview** tab is renamed **Docs** (still the rendered documentation); `?tab=preview` keeps working (alias). The draft must be shared between page and panel (lift to a small context) so the panel always shows the *unsaved* document.

### Wave 2 (after Wave 1 merges)

**WP-1b — Representation (R4).** `DocMessage.representation?: "avro" | "json-schema" | "protobuf"`; `DocChannel.format?`/`formatDialect?` optional (absent = follow messages); `planDocumentArtifacts` and `resolveDocument` take `entityFormats: ReadonlyMap<string, PayloadFormat | undefined>` (entity source formats recorded by the importers; find where `ParsedEntity.sourceFormat` is persisted for entities — if nowhere, record it at import time in `entity.metadata.sourceFormat` and say so) and compute each message's effective representation (R4 order); the assembler gets a per-message profile override (`ResolvedMessage.profile?`) that wins over the channel profile when picking payload and key artifacts, with existing goldens unchanged; `classifyEventBump`: a changed *effective* representation is MAJOR (sides carry `effectiveRepresentations`); snapshot loader reads the entity formats. Interfaces to be fixed in the WP brief after Wave 1.

**WP-UI-core — `TemplateForm`.** `src/features/events/builder/template/{TemplateForm.tsx,FieldControl.tsx,BindingsForm.tsx}`: renders an `ObjectTemplate` against a value object with `onChange(next)`; controls per `FieldKind` (text, markdown textarea with preview toggle, url/email with inline validation, enum select, boolean switch, integer, stringList and tags as chips, keyValue rows, nested object as a bordered group, list with add/remove, reference as select, entityPin using the existing `EntityPinPicker`), `basics` group open and `more` group collapsed with a count, required marker, help text under each field, `aria-describedby` errors from pointer problems. The identifier is never a field.

**WP-UI-sections — rebuild the sections on `TemplateForm`.** Metadata (info + contact + license + external docs + tags), Servers (+ variables, security refs, bindings), Channels (+ parameters auto-synced from the address, servers, bindings, messages allowed), Messages (entity + version + **Representation** select with the "Auto → …" explanation, headers/key pins, correlation id, examples, bindings, traits), Operations (+ reply, traits, security, bindings), **Traits** (message and operation: local templates + library pick), **Advanced** (security schemes). Auto keys through `suggestKey`; "Identifier" disclosure for rename. Existing tests are rewritten, not deleted, where the behavior survives.

## Running it (so the right build is on screen)

- Merged-to-`main` code runs in the user's existing dev server (port 3001). Until the branch is merged, run this branch from `.claude/worktrees/events-self-contained`: `npx next build --webpack` then `AUTH_TRUST_HOST=true npx next start -p 3000` (Turbopack cannot follow the worktree's symlinked `node_modules`; `next start` needs the trusted-host flag).

## Review Focus (round 2)

1. A saved document from slice 1 (v2 shape) must still open and save after the model grows — every new field optional.
2. A user who never opens "More properties" or "Advanced" must still get a valid document.
3. Switching a message's Representation or an entity must never leave a stale payload in the Code panel; stale server responses are dropped.
4. Two servers with the same title/host must get distinct generated identifiers.
5. A product with no contacts, and a mailbox with a comma in the display name (`"Doe, Jane" <j@x.com>`), must round-trip.

## Task steps (every WP)

- [ ] Write the failing tests first (full bodies), run red, implement, run green; keep every existing test green; `npx tsc --noEmit` adds no errors (2 known pre-existing in `tests/unit/lib/events/catalog-mapping.test.ts`); eslint clean; commit `feat(events): …` with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- [ ] Agent report (under 300 words) at `.superpowers/sdd-reports/<WP>.md` inside the worktree: commit, files, tests, deviations, notes for dependants.
