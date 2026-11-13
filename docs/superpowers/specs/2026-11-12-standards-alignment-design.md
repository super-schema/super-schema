# Standards alignment: PayPal ABC vs. industry standards

**Status:** Proposal · **Date:** 2026-11-12
**Source standards:** PayPal Architecture Building Code (ABC) v2, `Engineering-Documentation-R/architecturebuildingcode`, `docs/abc-v2/design-standards/api-design-standards/{event,rest,api-security,common-data-types}`, `reference-guides/misc/cloud-event`, `urn`.

## 1. Principles

1. **Open standards first.** Where an industry spec exists (AsyncAPI, CloudEvents, JSON Schema, W3C Trace Context, ISO, RFC), Super Schema follows it as the default.
2. **PayPal-specific rules are a profile, not core.** ABC rules marked *PayPal Core* (PPaaS gateway, `pypl*` attributes, `x-slo`, folder layout, …) ship as an optional, switchable **standards profile**. Super Schema stays a neutral Apache project.
3. **Configurable where teams reasonably differ.** Naming case, extension key names, value vocabularies and lint severity are settings, not hardcoded rules.
4. **No functional-noise rules.** We don't adopt rules that change formatting without changing meaning (e.g., JSON indent width).

## 2. Decisions already made (no change)

| Topic | ABC rule | Decision | Why |
|---|---|---|---|
| AsyncAPI version | 2.0.0 | **Keep 3.0** | Current industry version; 2.0 is superseded |
| Event `type` / topic name | `com.<tenant>.<ns>.<resource>.<action>.v<N>` | **Keep `tenant.domain.product.message`** | The `com.` prefix is a Java-package habit, not a topic convention |
| CloudEvents `source` | `urn:paypal:event-src:v1:…` | **Keep path default**; URN later as an optional form | Needs a full entity/geo inventory first |
| Field naming case | lower `snake_case` | **Don't enforce** | Python prefers snake_case, Java prefers camelCase; both are valid |
| JSON indent | 4 spaces | **Keep 2** | No functional effect |

## 3. Data classification: proposal

### 3.1 The gap today

| Aspect | Super Schema now | ABC |
|---|---|---|
| Levels | `NEVER_STORED`, `PII`, `SENSITIVE`, `INTERNAL`, `PUBLIC` (`classification-counts.ts`) | `class1` … `class5` |
| Class number | Only in UI labels (`ClassificationPicker.tsx:11-15`, "Class 1 — Never Stored" …) | First-class value `data_class` |
| Category | Read on import into `governance.dataCategory`; never edited, never exported | `data_category` (ConsumerPersonal, BusinessPersonal, BusinessCompany, EmployeePersonal, PayPalCompany, Intrinsic) |
| Export key | `x-classification: "<LEVEL>"` (string) or `@Enterprise.dataClassification` (`governance-decorators.ts:42`) | `x-securityClassification: {data_class, data_category}` |
| Placement rules | Every field, no rule | Primitives only; arrays → tag `items`; objects with properties untagged unless a descendant can't be tagged; inheritance to the closest untagged descendant |

### 3.2 Principle

Split classification into two layers:

- **Core (open, every tenant):** the named sensitivity scale with a **fixed** class number. Neutral, no vendor vocabulary.
- **Everything else is a tenant-defined metadata attribute.** Governance items, `data_category`, `x-securityClassification`, `x-slo` and any other `x-…` key are entries in the tenant's **Metadata Attribute Dictionary** (§3.4). They are not product standards. A pack (§3.5) is a ready-made set of dictionary entries.

### 3.3 Core: fixed class number

The class number is a fixed, built-in property of each system level. Admins can't edit it.

| Level | Class | Meaning |
|---|---|---|
| NEVER_STORED | 1 | Most restrictive |
| PII | 2 | |
| SENSITIVE | 3 | Default for unclassified fields (today's behavior) |
| INTERNAL | 4 | |
| PUBLIC | 5 | Least restrictive |

- Lives in code (`classification-counts.ts`), not in the DB: same 1–5 scale for every tenant, no migration.
- Admin-defined levels (e.g. `FINANCIAL`) must **choose one of the five classes** when created (`ClassificationLevel.classNumber`, required, 1–5). The number sets ordering and "at least as restrictive" comparisons; the label stays free.
- Core export is unchanged: `x-classification: "<LEVEL>"` / `@Enterprise.dataClassification`. The class is derivable from the level, so it isn't emitted separately.

### 3.4 Tenant dictionaries

Two tenant-level catalogs, managed like custom data types (`CustomScalar`, `SharedEnum`):

| | **Field Dictionary** | **Metadata Attribute Dictionary** |
|---|---|---|
| Defines | Reusable *fields*: what a field is | Reusable *attributes on a field or entity*: extra facts about it |
| Entry | name, aliases, type (logical / custom scalar / shared enum), description, default classification, default attribute values, optional link to a glossary concept | key (`x-…`), label, description, value schema, targets (`field`, `entity`), scope, derived members, placement, pack |
| Used when | Adding a field: name autocomplete; picking an entry fills type, description, classification and default attributes | Adding metadata to a field/entity: key autocomplete + a typed value editor |
| In schemas | Becomes an ordinary field (no runtime link needed; an optional `dictionaryEntryId` is kept for "which fields use this entry") | Becomes a vendor extension (see below) |

**Field Dictionary notes**
- Replaces the static field-name suggestions (`schema-standards/common-fields.json`) as the first suggestion source. Static standards and fields already used in the domain remain as fallbacks.
- `BusinessConcept` (glossary) stays the *business meaning*. A dictionary entry may link to one concept; it doesn't replace the glossary.
- Field-name case isn't normalized (§2). Aliases match case-insensitively.

**Metadata Attribute Dictionary notes**
- **Keys are vendor extensions:** every key starts with `x-`. That's how attributes travel through every open format (JSON Schema, OpenAPI, AsyncAPI) without inventing anything.
- **Value schema = JSON Schema** (a subset: `string`, `number`, `integer`, `boolean`, `array`, `object` with `properties`, `enum`, `format`, `pattern`, `minimum`/`maximum`, `required`). An open standard drives validation and the value editor.
- **Storage reuses the existing extension maps:** field → `decorators.typespec.extensions.openapi[key]`, entity → `metadata.custom.extensions[key]`. Hand-typed extensions keep working. The dictionary only adds typing, validation and autocomplete.
- **Scope:**
  - `schema`: emitted everywhere.
  - `internal`: kept in Super Schema and the canonical TypeSpec source (lossless GitOps), stripped from emitted target outputs.
- **Derived members:** `derive: { member: template }` computes object members from the field itself. Placeholders: `{class}` (fixed class number), `{level}` (classification level), `{name}`, `{type}`. Derived members are re-computed and stored whenever the field's classification or the attribute changes, and on pack install. Downstream code therefore sees plain stored values.
- **Placement:**
  - `field` (default).
  - `abc-primitive` (§3.5 rules): skipped on entity-reference fields; on array fields, moved to `items` in emitted JSON Schema/OpenAPI.

**TypeSpec conversions (each attribute must map both ways)**

| Direction | Mapping |
|---|---|
| Model → TypeSpec (canonical source) | Field: `@TypeSpec.JsonSchema.extension("x-key", <value>)` + `@TypeSpec.OpenAPI.extension("x-key", <value>)` (existing generic path, `genericExtensionDecorators`). Entity: same on the model. Object/array values as TypeSpec value literals (`#{…}`, `#[…]`). |
| TypeSpec → model (import, GitOps pull) | Existing `@extension` parsing → extension map; the dictionary entry (if any) validates the value; unknown keys are kept untyped |
| TypeSpec → JSON Schema / OpenAPI / AsyncAPI | Emitted by the official emitters from the extension decorators; `internal` keys removed by the emission projection; `abc-primitive` array tags moved to `items` by a post-pass |
| JSON Schema / OpenAPI / AsyncAPI → model | Existing vendor-extension round trip (`2026-10-20-vendor-extension-roundtrip-design.md`) |
| Avro | Emitted as Avro field/record custom properties (the Avro spec allows extra attributes), post-pass on the `.avsc` |
| Protobuf | custom options (`superschema/metadata_options.proto`) |
| DDL, Java | Not representable. A warning lists the attributes that were skipped |

### 3.5 PayPal "Security Classification" pack (install on demand)

A pack is a code-defined set of Metadata Attribute Dictionary entries; installing upserts them for the tenant. This pack adds one entry:

```json
{
  "key": "x-securityClassification",
  "label": "Security classification",
  "targets": ["field"],
  "scope": "schema",
  "placement": "abc-primitive",
  "valueSchema": {
    "type": "object",
    "properties": {
      "data_class": { "type": "string", "pattern": "^class[1-5]$" },
      "data_category": { "type": "string", "enum": ["ConsumerPersonal", "BusinessPersonal", "BusinessCompany", "EmployeePersonal", "PayPalCompany", "Intrinsic"] }
    }
  },
  "derive": { "data_class": "class{class}" },
  "requiredWhen": "primitive"
}
```

- Users only pick `data_category`; `data_class` always follows the field's classification through the fixed class number.
- ABC placement rules (via `abc-primitive`):
  - Tag primitives and property-less objects.
  - Array fields: move the tag to `items`.
  - Objects with properties (entity references): no tag. Unresolvable references: tag the field.
  - Never emit the tag inside examples/samples.
- Import: `data_class: classN` sets the field's classification to the system level with class N, unless `SCHEMA_CLASSIFICATION_VALUE_MAP` maps it explicitly.
- Uninstall removes the dictionary entry. Stored values stay as plain, untyped extensions.

Without the pack, nothing PayPal-specific appears in the UI or in emitted schemas.

## 4. Common data types

**ABC rule:** money, address, percentage, country, currency and dates must reuse *one shared definition* (PayPal's `CommonComponentsSpecification`), not be redefined per API. For example, money is always `{currency_code: ISO-4217, value: decimal-string}`, never a float `amount`.

**Decision:** common types are ordinary, per-tenant content. Nothing about them needs a special model.

- A tenant creates a product (e.g. `common`) under any domain and authors or imports entities there (`Money`, `PostalAddress`, `CountryCode`, …). Because entities can be referenced across products and domains, they're available everywhere in the tenant.
- No built-in library, no "common" flag, no seeding. The class number and metadata attributes (§3) apply to them like to any entity.
- **On demand, optional:** the Standards Browser can offer a starter template ("Common types: ISO 4217 money, ISO 3166 country, RFC 3339 dates, E.164 phone, BCP 47 locale, schema.org PostalAddress") that a user imports *into a product they choose*. It creates regular entities they then own and edit. PayPal can instead import `CommonComponentsSpecification` through the JSON Schema importer into its own common product.
- **Later / optional:** a lint hint ("`amount` is a float; the tenant has a `Money` entity") matching by entity name across the tenant. Off by default.

## 5. Rules not followed today: evaluation

Verdicts: **Adopt** = core default · **Config** = core feature, off or neutral by default, the profile switches it on · **Metadata attribute (pack)** = no core feature; a Metadata Attribute Dictionary entry (§3.4), shipped in an installable pack · **Profile** = PayPal profile only · **Relax** = don't implement.

| # | ABC rule | Industry position | Verdict | Suggestion |
|---|---|---|---|---|
| 1 | Channel name == CE `type` | CloudEvents leaves `type` free; mapping channel → type is good practice | **Config** | Setting "CE `type` source": `derived` (today) · `channel-address` · `message-name`. Lint mismatch as a warning when enabled. |
| 2 | Past-tense action, `-command` suffix for commands | Common EDA guidance (event = fact, command = intent); not in any spec | **Config** | Add an optional `intent: event \| command` on messages (default `event`). Optional lint: past-tense verb for events, imperative for commands; suffix pattern configurable (`-command` in profile). |
| 3 | Enum values `UPPER_SNAKE` | Not a standard; Avro requires `[A-Za-z_][A-Za-z0-9_]*`, Protobuf convention is `UPPER_SNAKE` | **Config** | Enum casing policy: `any` (default) / `UPPER_SNAKE` / `lower_snake` / `PascalCase`. Keep the Avro/Protobuf validity checks always on. |
| 4 | `_date` / `_time` suffixes, plural arrays | Style only | **Relax** (lint opt-in) | Fold into the pluggable naming lint (`namingConventions` becomes structured rules); off by default. |
| 5 | `x-visibility` (PUBLIC/PARTNER/COMPANY/INTERNAL/DOMAIN) + "never more restrictive" | No AsyncAPI/JSON Schema equivalent; audience visibility is a real need for doc portals | **Config** | Core concept "audience" on channel / operation / message / field, with a configurable vocabulary (default `public`, `partner`, `internal`). Emitted as `x-visibility: {extent}`; key name configurable. Bump rule: narrowing audience = MAJOR. Doc renderers filter by audience. |
| 6 | `x-slo` (p95 latency, error rate) | No spec equivalent; useful operational metadata | **Metadata attribute (pack)** | A Metadata Attribute Dictionary entry `x-slo` (targets: operation; needs the operation target, added with this item). Ships in the PayPal pack; any tenant can define its own. No bespoke core field. |
| 7 | `x-serviceName` | PayPal routing (topos) | **Metadata attribute (pack)** | Product ownership already covers owner/service generically. The PayPal pack defines `serviceName` (channel/operation target) emitting `x-serviceName`. |
| 8 | `x-security` scopes + `x-securitySchemes` (appcontextauth) | AsyncAPI 3.0 has native `security` on servers/operations with `oauth2` scopes | **Adopt native, Profile for appcontextauth** | Use AsyncAPI 3.0 `security` (already modeled). The profile adds an `appcontextauth` custom scheme as an `x-` scheme. No `x-security` duplicate. |
| 9 | `x-deprecated` on channel/operation | AsyncAPI 3.0 has `deprecated` on messages and operations only | **Adopt** | Add `deprecated` + `replacedBy` to channels/operations in the model. Emit native `deprecated` where the spec allows; elsewhere emit `x-deprecated: {see, since_version}`. Same shape as field deprecation. |
| 10 | `x-supportedCountries` | Not standard | **Metadata attribute (pack)** | `string[]` attribute (ISO 3166 codes) emitting `x-supportedCountries`, in the PayPal pack. |
| 11 | `x-requiredOverride`, `x-unsupportedFields` | Not standard; work around rigid shared components | **Relax** | Super Schema already handles this natively: entity versions, `@withOptionalProperties` / pick / omit projections. Import keeps these keys as extensions (already lossless). |
| 12 | `x-pattern` (country-conditional regex files) | Not standard; JSON Schema `if/then` covers it | **Relax** | Use JSON Schema `if/then/else` or `dependentSchemas`. Import keeps `x-pattern` as an extension. |
| 13 | `pypl*` CloudEvents extensions | CloudEvents allows vendor extensions | **Profile** | Ship a "PayPal CloudEvents" library trait (`pyplcorrelationid`, `pyplsecuritycontext`, …) in the profile. Core gets a generic "custom CloudEvents extension" trait template that validates CE naming (lowercase alphanumeric, ≤ 20 chars). |
| 14 | `partitionkey` (CE Partitioning), `dataref` (claim check) | Official CloudEvents documented extensions | **Adopt** | Add built-in traits `cloudevents-partitioning@1.0` and `cloudevents-dataref@1.0`. Map the message key pin → `partitionkey` automatically. Also offer the CE Distributed Tracing extension next to W3C Trace Context (`traceparent` is the same value). |
| 15 | `schemaFormat: application/cloudevents+json; version=1.0` | In AsyncAPI 3.0 `schemaFormat` describes the payload *schema* language, not the envelope; CE is expressed via headers/traits | **Relax** | Keep the correct 3.0 semantics. Expose CE mode as `x-cloudevents: {mode: structured\|binary, specversion}` plus the CE trait. Profile may emit the PayPal string as `contentType` for structured mode. |
| 16 | Idempotency key = `source` + `id` | CloudEvents spec says the same (`source` + `id` unique) | **Adopt (document)** | Already stated in the trait description. Add an `x-idempotency-key` declaration (default `["source","id"]`, configurable) on messages and show it in docs. No runtime enforcement (not our layer). |
| 17 | Repo layout `v#/{doc,sample,error_sample,schema/asyncapi.json}`, `RELEASENOTES`/`USERGUIDE` | PayPal-specific | **Profile (GitOps layout)** | Make the GitOps export layout a template. Default stays the current layout; profile template emits the ABC layout, with release notes generated from `changeSummary` and samples from message `examples`. |
| 18 | Error samples, error catalog, Event Gateway URI/POST/status codes | PayPal gateway | **Profile** | Out of core scope. Profile can add error examples under `x-error-samples`. |
| 19 | Headers/payload in separate files via `$ref` | Spec-neutral; both forms valid | **Adopt (already)** | Pinned entities already emit as separate components; multi-file GitOps export covers it. |

## 6. Mechanism: standards profiles

One configuration object per tenant (overridable per domain), in the admin settings, also loadable from `gitops.config.yaml`:

```yaml
standards:
  profile: open           # open | paypal-abc | custom
  naming:
    fieldCase: any        # any | snake_case | camelCase
    enumCase: any         # any | UPPER_SNAKE | lower_snake | PascalCase
    timeSuffixes: off     # off | warn | error
  events:
    typeSource: derived   # derived | channel-address | message-name
    intentLint: off       # off | warn | error
    commandSuffix: "-command"
  attributePacks: []     # e.g. [paypal-security-classification, paypal-api-metadata]
  visibility:
    extensionKey: x-visibility
    vocabulary: [public, partner, internal]
  commonTypes:
    suggestions: off      # off | info | warn  (name-match hint against tenant entities)
```

`paypal-abc` = a preset that sets: `enumCase: UPPER_SNAKE`, `timeSuffixes: warn`, `intentLint: warn`, the attribute packs `paypal-security-classification` (data category, `x-securityClassification`, ABC tagging rules) and `paypal-api-metadata` (`x-slo`, `x-serviceName`, `x-supportedCountries`), the visibility vocabulary `PUBLIC/PARTNER/COMPANY/INTERNAL/DOMAIN`, the `pypl*` trait, and the ABC GitOps layout. Field case stays `any` even in this profile, per §2.

## 7. Phasing

| Phase | Scope |
|---|---|
| 1 | Core class number fixed at 1–5 (§3.3) + Field Dictionary + Metadata Attribute Dictionary with TypeSpec conversions (§3.4) |
| 2 | `paypal-security-classification` pack (§3.5): derived `data_class`, ABC placement, import mapping |
| 3 | Open-standard adoptions: CE partitioning/dataref/tracing traits, channel/operation deprecation, idempotency declaration |
| 4 | Standards-profile config (§6) + structured naming/enum/intent lint; audience/visibility |
| 5 | `paypal-abc` profile: `paypal-api-metadata` pack, `pypl*` trait, appcontextauth, GitOps ABC layout, error samples; optional common-types starter template (§4) |

## 8. Resolved questions

1. **Class number:** fixed 1–5 in code; custom levels must map to one of the five.
2. **Data category / `x-securityClassification`:** PayPal-specific. A Metadata Attribute Dictionary entry delivered by a pack, not a core standard.
3. **Common types:** per tenant, ordinary entities in a product the tenant chooses; optional starter template on demand.
