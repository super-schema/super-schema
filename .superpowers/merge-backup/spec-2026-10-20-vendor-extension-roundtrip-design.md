# JSON Schema import fidelity — design

Covers three problems found while testing JSON Schema import against a real
PayPal common-components schema set: (1) vendor extension (`x-*`) round-trip,
(2) spec-correct `allOf`/`anyOf`/`oneOf` composition mapping, (3) `$ref`
resolution across files/repos via a real library instead of filename-guessing.

## Intent

JSON Schema (and OpenAPI) documents carry vendor extension keys (`x-visibility`,
`x-links`, ...) that this importer today silently drops. The user needs
lossless round-trip: don't interpret the keys, don't act on them, but never
lose them — when we re-emit a schema, the extensions come back out.

The same real-world test also exposed two more fidelity gaps, addressed in
their own sections below: `allOf`/`anyOf`/`oneOf` composition is reduced to
"take the first member" today, and `$ref` targets outside the document are
resolved by guessing a name from the filename rather than actually fetching
and understanding the target (which also means two different directories'
same-named file collide, and nothing distinguishes "a $ref we can't reach" from
"a $ref we chose not to expand").

## Current state (verified in this repo; corrected after builder-check)

- `ParsedField.extensions?: Record<string, string>` already exists
  (`src/lib/importers/types.ts:74`) and is wired end-to-end for **TypeSpec
  source only**: `typespec-parser.ts` parses `@extension("key", "value")` on a
  field (string values only — line 1073 regex: `@extension\("([^"]+)"\s*,\s*"([^"]*)"\)`),
  `typespec.importer.ts:184` copies it onto `ParsedField.extensions`,
  `decorator-builder.ts:70-72` lifts it into
  `decorators.typespec.extensions.openapi` (`ExtensionsDecorators.openapi:
  Record<string, unknown>`, `super-schema-model.ts:164`), which persists on
  `Field.decorators` (Prisma `Json`).
- **Two specific extension keys already round-trip today, both ways** — this
  is an existing, narrower mechanism this design must sit next to, not
  duplicate:
  - Entity tags: `model.entity.metadata.tags` → generator emits one
    `@TypeSpec.OpenAPI.extension("x-tags", #["a", "b"])` on the model
    (`governance-decorators.ts:121-124`, called from
    `typespec-generator.ts:382-385`). Import side: `collectModelTags`
    (`typespec-parser.ts:598`).
  - Field classification with no `Enterprise.DataClassification` member match:
    `@TypeSpec.OpenAPI.extension("x-classification", "LEVEL")`
    (`governance-decorators.ts:93-96`).
  - Both are **fully namespace-qualified** (`TypeSpec.OpenAPI.extension`, not
    bare `@extension`) deliberately, "so it cannot become ambiguous with
    another library's `@extension` (e.g. `TypeSpec.JsonSchema.extension`)"
    (`governance-decorators.ts:17-18`) — see the decorator-namespace finding
    below, which makes this more than a style note.
  - The AST-based compiler path (`typespec-compiler.ts:212-222`) already
    establishes the precedent this design follows for the generic case:
    `x-classification` and `x-tags` are **excluded** from the generic
    extensions bag because they're consumed into their own typed fields
    instead (`TAGS_EXTENSION_KEY`, `CLASSIFICATION_EXTENSION_KEY`).
  - What's genuinely missing: generic, arbitrary-key emission. The bare-`@extension`
    capture path for `ParsedField.extensions` (the one `decorator-builder.ts`
    feeds) has no corresponding generator emission at all — still a dead end.
    And `jsonschema.importer.ts` never captures `x-*`/unknown keys — the
    `JsonSchemaNode` interface has `[key: string]: unknown` but nothing reads
    past the known keywords, at any altitude.
- `Entity.metadata` (Prisma `Json?`) already holds a `metadata.custom.*` bag
  used for namespace / interfaces / customScalars / sharedEnums
  (`compiler.service.ts:88-93`) — reused for the new generic entity-level
  extensions bag (distinct from `metadata.tags`, which already has its own
  slot and its own round-trip). No migration needed.
- **Decorator-namespace finding (changes the design):** `@typespec/json-schema`
  and `@typespec/openapi` each ship their *own* `extension` decorator, backed
  by **separate, non-shared compiler state**:
  `@typespec/json-schema`'s emitter reads only its own `JsonSchema.extension`
  state (`node_modules/@typespec/json-schema/dist/src/json-schema-emitter.js:522-523`,
  state key `node_modules/@typespec/json-schema/dist/src/lib.js:128`); the
  OpenAPI3 emitter reads only `@typespec/openapi`'s state
  (`node_modules/@typespec/openapi3/dist/src/schema-emitter.js:284-290`, via
  `getExtensions` imported from `"@typespec/openapi"`). **Using only
  `@TypeSpec.OpenAPI.extension` — the form the existing x-tags/x-classification
  code uses — would not round-trip through the json-schema emission path at
  all**, which is the primary path this design exists for (JSON Schema import
  → JSON Schema export). Both packages are already declared dependencies
  (`package.json:102-103`), so no new dependency is needed to fix this.
  **Resolution (confirmed):** emit **both** `@TypeSpec.JsonSchema.extension("key", value)`
  and `@TypeSpec.OpenAPI.extension("key", value)` for every generic extension,
  at both model and field level, so the value survives whichever official
  emitter runs. One extra line per extension; both imports
  (`import "@typespec/json-schema";` / `import "@typespec/openapi";`) added
  to the generated source whenever any generic extension is present, same
  pattern `governanceImportLines` (`typespec-generator.ts:356-365`) already
  uses to conditionally add the OpenAPI/Enterprise imports.

## Goals

- Capture every key in an imported JSON Schema document that isn't one of the
  keywords this importer already reads, at whatever node it appears on
  (document root, a property, an array's `items` subschema).
- Store it so TypeSpec text (the canonical source) can represent it via the
  existing, compiler-native `@extension` decorator — at both model level and
  field level.
- Re-emit it: TypeSpec → JSON Schema / OpenAPI3 (the official-compiler paths)
  must reproduce the original `x-*` key/value.
- Widen value support from string-only to any JSON value (object, array,
  number, boolean, null), since real-world extensions like `x-visibility:
  {extent: "..."}` are objects, not strings.

## Non-goals

- Interpreting or acting on any extension's meaning (no `x-visibility`-driven
  access control, no special-casing specific vendor keys).
- Avro / Protobuf / native emitters consuming entity or field extensions —
  those emitters don't go through TypeSpec, so re-emission there is separate,
  future work, out of scope here.

## Anti-goals

- Silently dropping any non-keyword key, ever.
- Inventing a parallel, TypeSpec-shadowing storage format (a side-channel JSON
  blob in the DB that isn't visible in the `.tsp` source) when the compiler
  already has a native decorator for this.
- A schema migration. `Field.decorators` and `Entity.metadata` are both
  already-JSON, already-used-as-bags columns.

## Design

### Where unknown keys get captured (`jsonschema.importer.ts`)

Define an explicit allow-list of keywords this importer already reads (the
current `JsonSchemaNode` field set: `$schema, $id, $ref, title, description,
type, format, properties, required, items, enum, const, deprecated, default,
oneOf, anyOf, allOf, minLength, maxLength, pattern, minimum, maximum,
exclusiveMinimum, exclusiveMaximum, minItems, maxItems, $defs, definitions`).
Any other key on a schema node, at any altitude, is captured verbatim
(key and value unchanged — no renaming, no `x-` requirement, matches "capture
ALL information provided") **except `x-tags` and `x-classification`**, which
already have dedicated, typed round-trip paths (`metadata.tags`, field
`classification`) and must stay excluded from the generic bag — same
precedent the AST compiler path already establishes
(`typespec-compiler.ts:215-221`, `TAGS_EXTENSION_KEY` / `CLASSIFICATION_EXTENSION_KEY`).
A JSON Schema document that happens to use the literal key `x-tags` or
`x-classification` feeds the existing entity-tags / field-classification
machinery instead of the new generic bag.

- Root node, sibling to `properties` (e.g. `x-links`) → **entity-level**
  extension.
- A property node, sibling to `type`/`format`/etc. (e.g. a property with
  `x-deprecated-reason`) → **field-level** extension.
- An array's `items` subschema, sibling to `$ref`/`type` (e.g. `x-visibility`
  on `links.items`) → **item-level**, see below — this is not the same
  altitude as a field-level extension and must not be collapsed into one
  silently.

### Item-level extensions (A primary, C fallback)

JSON Schema lets `items` carry sibling keys next to `$ref`/`type`; TypeSpec
has no node for "the element type as used right here" — only models and
properties can carry decorators. Two paths, chosen per-case:

**A — items is a `$ref` to an entity (the common case, e.g. the PayPal
sample).** Synthesize a per-usage model that stands in for the item type,
carries the `@extension`, and is what the array actually references:

```tsp
import "@typespec/json-schema";
import "@typespec/openapi";

@TypeSpec.JsonSchema.extension("x-visibility", #{extent: "EXTERNAL"})
@TypeSpec.OpenAPI.extension("x-visibility", #{extent: "EXTERNAL"})
model LinkDescription_Item extends LinkDescription {}

model Foo {
  links: LinkDescription_Item[];
}
```

Name collisions resolved the same way `indexDefinitions` already
disambiguates asset names (`_2`, `_3`, ... suffix). **Open implementation
question, not resolved by this doc:** whether TypeSpec `extends` or a spread
(`{ ...LinkDescription }`) is what makes `@typespec/json-schema` emit the
synthetic model as a distinct schema that still carries the original $ref
relationship, vs. flattening it into an inlined copy. The builder must verify
this against a real compile before picking one, and record the actual output
shape in a code comment next to wherever this is implemented.

**C — items is not a `$ref` to a named entity (primitive or inline object
item).** No model exists to hang a decorator on. Fall back to folding the
extension onto the array field itself (altitude lost in the *re-emitted*
shape) and append a warning to `MultiEntityImportResult.warnings` naming the
field and the original JSON Pointer path (e.g. `"links.items.x-visibility
folded onto field 'links' — original altitude not preserved"`), so the loss
is visible, never silent.

### Value representation

`ParsedField.extensions` and the new entity-level extensions widen from
`Record<string, string>` to `Record<string, unknown>` (matches
`ExtensionsDecorators.openapi`, which is already `Record<string, unknown>` —
no type mismatch downstream). The TypeSpec generator needs a small
value→TypeSpec-literal serializer (string → `"..."`, array → `#[...]` — follow
the exact convention `tagsDecorator` already uses, `governance-decorators.ts:121-124`
— object → `#{...}`, number/boolean/null → bare literal), and the parser's
`@extension(...)` regex needs the inverse: today it only matches a quoted-string
second argument and must be extended to parse `#{...}` / `#[...]` / bare
literals back into a JS value.

### Round-trip wiring

- **Field level** (mostly exists): generator gains the missing emit step —
  for each `field.decorators.typespec.extensions.openapi` entry not in the
  excluded set (`x-tags`, `x-classification`), emit both
  `@TypeSpec.JsonSchema.extension("key", <value literal>)` and
  `@TypeSpec.OpenAPI.extension("key", <value literal>)` immediately above the
  field, adding both library imports (once per generated document, reusing
  `governanceImportLines`'s conditional-import pattern,
  `typespec-generator.ts:356-365`, rather than duplicating it). Parser gains
  the widened value grammar described above, and must recognize both
  qualified decorator spellings (plus the legacy bare `@extension(...)` already
  parsed today, for backward compatibility with previously-generated sources).
- **Entity level** (net new): `jsonschema.importer.ts` puts root-level unknown
  keys on `ParsedEntity.extensions` (new field, mirrors `ParsedField.extensions`
  shape — distinct from `metadata.tags`, which keeps its own dedicated path).
  The asset-creation path persists them into `Entity.metadata.custom.extensions`
  (same bag `compiler.service.ts` already reads `namespace`/`interfaces`/etc.
  from). `typespec-parser.ts` gains a `collectModelExtensions` alongside the
  existing `collectModelTags` / `collectDiscriminator` / etc., feeding
  `ParsedTypeSpecModel.extensions` → `TypeSpecImportModel` → `ParsedEntity.extensions`.
  The generator emits the same dual-decorator pair above the `model`
  declaration from this same slot, alongside (not replacing) the existing
  `tagsDecorator` emission.

## Constraints

- TypeSpec source is the canonical representation (2026-10-12 pivot, per
  project memory) — this design stores extensions as real `@extension`
  decorators in `.tsp` text, not a side-channel.
- Must not regress existing `jsonschema.importer.test.ts`,
  `jsonschema-document.test.ts`, `jsonschema-literals.test.ts`, or
  `typespec.importer`/`typespec-parser`/`typespec-generator` round-trip tests.
- No Prisma migration.
- Before adding any new TypeSpec-side construct, check
  https://typespec.io/docs/language-basics/overview/ (and the relevant
  sub-page — unions, decorators, etc.) for an existing language feature or
  official-library decorator that already does it, the way this doc already
  found `@extension` and `union` cover two of the three problems here without
  new TypeSpec-side work. Don't hand-roll a TypeSpec-shadowing mechanism for
  something the language or an official `@typespec/*` package already
  expresses.

---

# Addendum A — `allOf` / `anyOf` / `oneOf`: spec-correct composition mapping

## Why this isn't just "handle the PayPal pattern"

The first pass at this (array-items-carry-a-sibling-extension) was shaped
around one observed file. Re-derived from JSON Schema 2020-12 itself (the
draft this importer targets — `jsonschema-infer.ts:95` emits
`$schema: "https://json-schema.org/draft/2020-12/schema"`), the three
keywords have precise, different meanings (2020-12 core, §10.2.1, "Keywords
for Applying Subschemas With Boolean Logic"):

- **`allOf`**: the instance must satisfy **every** subschema simultaneously —
  an intersection of constraints, not "pick one."
- **`oneOf`**: **exactly one** subschema must match — mutual exclusivity is
  part of the meaning.
- **`anyOf`**: **one or more** subschemas may match — overlap is allowed.

Today's `resolveSchemaType` combinator branch (`jsonschema.importer.ts:298-321`)
collapses all three to the same thing: take the first non-null member, drop
the rest, downgrade confidence if there's more than one. That's not a
shortcut worth keeping now that we're fixing fidelity generally.

## `allOf` → merge, not pick-first

Per spec, `description`/`title`/`deprecated`/`x-*` are *annotations* — they
never narrow validity, they just decorate. So the correct merge:

1. Split each `allOf` member into annotation-only keys vs. constraining keys
   (`type`, `properties`, `$ref`, `minLength`, etc.).
2. Merge every constraining member's effect: `extractConstraints` already
   returns a list, so union the constraint lists across members (minLength
   from one member, maxLength from another — both apply, they're not
   alternatives).
3. Apply every annotation-only member's keys directly onto the merged result
   (a member containing only `{"description": "..."}` enriches the final
   field/entity, it doesn't compete with the real type member).
4. **The specific shape this design must recognize as inheritance:** exactly
   one `$ref`-to-object-entity member plus exactly one inline-object member
   with its own `properties`, **at the position where a whole entity is being
   defined** (document root or a `$defs`/`definitions` entry — not nested
   inside a single property). That maps to TypeSpec `extends`:
   `ParsedEntity` gains an `extends?: string` field (mirrors
   `TypeSpecImportModel.extends` already used by the TypeSpec importer,
   `typespec.importer.ts:53-60`), fields come from the inline-object member via
   the existing `buildFields`.
5. More than one `$ref` member in the same `allOf` (legal per spec — multiple
   inheritance) has no TypeSpec analog (`extends` takes one base). Approximation,
   documented as such: first ref → `extends`, remaining refs → `...spread`
   so their fields still land, losing the "is-a" relationship for those but
   not the fields.
6. At property level (not whole-entity), `allOf: [{$ref: X}, {description: "..."}]`
   (no `properties` in the second member) isn't inheritance — it's a plain
   reference field enriched with an annotation. Merge the description onto
   the resolved reference field rather than discarding member 2, which is
   what happens today.
7. Members whose constraining keys genuinely conflict (e.g. `allOf: [{type:
   "string"}, {type: "number"}]` — unsatisfiable in practice) aren't worth
   modeling precisely: keep today's behavior (take first, low confidence),
   since `SuperSchemaModel` has no way to represent an uninstantiable type
   anyway and real documents essentially never do this.

## `oneOf` / `anyOf` → both map to `UnionType`, and that's spec-correct, not a shortcut

The exactly-one vs. one-or-more distinction is a **validation-time** concept.
`SuperSchemaModel`/TypeSpec unions don't validate at all — a union there means
"this value's shape is one of these," with no mechanism to enforce exclusivity
either way. So the distinction JSON Schema draws between `oneOf` and `anyOf`
has no surviving analog once the target is a descriptive type system rather
than a validator — both honestly collapse to the same TypeSpec `union`
construct (https://typespec.io/docs/language-basics/unions/ — the feature
itself needs nothing new; it already round-trips end to end on the TypeSpec
import path). **Decision: build this now, not deferred** — tracing the
existing TypeSpec path showed the gap is pure plumbing, not new capability:

- Persistence already exists and is format-agnostic: `import-payload.ts:72`
  already does `unionTypes: selection.selectedUnions.map((idx) =>
  result.unions[idx])` against the `UnionType` Prisma model — nothing new to
  build on the create/persist side.
- The shape to produce is already defined and trivial:
  `Array<{ name: string; memberTypes: string[]; description?: string }>`
  (`typespec.importer.ts:91`) — reuse it as-is, don't invent a parallel type.
- The only real gap: `MultiEntityImportResult` (the shared shape for
  JSON Schema/Avro/Protobuf, `types.ts:151-166`) has no `unions` field, and
  `multi-asset.ts:103` hardcodes `unions: []` for all three formats. Add the
  field (optional, defaults to `[]`) and have `jsonschema.importer.ts`
  populate it when a `oneOf`/`anyOf`'s members are all `$ref`s to named
  entities/enums (member name → `refToEntityName`/definition lookup, same
  resolution `resolveRef` already does); `multi-asset.ts` passes it through
  instead of hardcoding empty. Avro/Protobuf are untouched — they keep
  producing `[]` exactly as today, this doesn't force work onto them, it just
  stops blocking JSON Schema's.
- Members that aren't all named refs (primitives, inline objects mixed in)
  keep today's low-confidence single-type fallback — no union built.

## Explicitly not supported (documented gap, not a silent one)

`not`, `if`/`then`/`else`, `$dynamicRef`/`$dynamicAnchor`, `unevaluatedProperties`
— none have any `SuperSchemaModel` analog. Encountering one of these produces
a warning (`MultiEntityImportResult.warnings`) naming the keyword and the
field/entity it was on, and the node is otherwise treated as if the keyword
weren't there (not inlined, not approximated into some invented shape).

---

# Addendum B — `$ref` resolution: adopt a real library, stop guessing

## The problem with today's approach

`refToEntityName` (`jsonschema.importer.ts:407-410`) strips an external `$ref`
down to its basename and calls that the entity name — no actual fetch, no
disambiguation. Confirmed broken against the real PayPal schema set
(`identity.CommonComponentsSpecification`, fetched via `gh api --hostname
github.paypal.com` during this conversation): `address.json` contains
`"$ref": "../../common_components/v5/schema/json/openapi-3.0/components/schemas/address/address_portable.json"`
— a relative path that climbs out of the current repo into a *different* repo
entirely. Basename-only naming can't tell that apart from a same-named file
in the current repo, and gives no way to actually go fetch the real target
later.

## Decision: parsing/addressing is a library's job; mapping to SuperSchemaModel stays ours

No JSON-Schema-aware library is in this codebase today (confirmed: no `ajv`,
no `json-schema-ref-parser`/`@apidevtools/json-schema-ref-parser` in
`package.json`; `codemirror-json-schema` is editor-only tooling, `@typespec/json-schema`
is the TypeSpec→JSON-Schema *emitter*, unrelated to importing). Every other
importer in this repo (avro, protobuf, bigquery-ddl, typespec) hand-rolls its
own format's semantics — but `$ref` addressing/fetching (relative paths,
absolute URLs, across files, across repos) is exactly the problem
`@apidevtools/json-schema-ref-parser` exists to solve, and re-deriving a
spec-correct, security-sane URI-resolution algorithm by hand isn't a good use
of hand-rolled effort the way allOf/oneOf *mapping* is. New dependency,
justified: **adopt `@apidevtools/json-schema-ref-parser`** for addressing;
our own code still owns every semantic decision (allOf/oneOf merge, type
mapping, entity construction) — library in, mapping ours, matching the split
the user asked to confirm.

**Use its `resolve()` (or `bundle()`), not `dereference()`.** `dereference()`
inlines every `$ref` target into a single flattened object — exactly what we
must *not* do, since the goal is "the reference entities as well" (each
`$ref` target becomes its own separate imported entity, linked by reference,
not copied inline). `resolve()` instead returns the map of every transitively
reachable file's raw parsed content, keyed by resolved absolute URI, without
collapsing anything — each resolved file still gets run through this
importer's normal root-schema-to-entity path, one entity per file.

## Resolving relative paths across our internal git hosts

A plain HTTP(S) resolver doesn't reach `github.paypal.com` (private, needs
auth) or resolve a relative path like `../../common_components/...` into a
fetch from the right repo/ref. `json-schema-ref-parser` supports pluggable
custom resolvers (`options.resolve`); this design adds one that, given a
resolved URI under a known internal git host, fetches raw file content via
the already-authenticated `gh api` (reusing the user's existing `gh auth
login --hostname <host>` session — no new credential storage), translating
a relative path to the right repo path the same way `git` would. Plain
`https://`/`http://` URLs fall through to the library's default HTTP
resolver. A `$ref` that resolves to a host/repo we have no resolver or
access for **fails that one node**, not the whole import — see below.

## This is also how "dangling reference" (the earlier non-goal) gets solved

A `$ref` the resolver can't reach (unknown host, 404, no `gh auth` session,
access denied) is caught per-node, not fatal to the import: the field keeps
its resolved target name (now the *real* name, derived from the fetched
document's `title`/`$id` when reachable, or the full original `$ref` string
when not — already preserved in `originalType` per `resolveRef`'s existing
fallback, `jsonschema.importer.ts:274-280`) and is flagged live (not stored —
see field-completeness pattern, `src/lib/validation/field-completeness.ts`)
wherever `referencedEntityName` doesn't match a real entity in the current
product, using the existing-but-currently-unused `ValidationIndicator`
component. Nothing here requires a new Prisma column: newly created entities
already default to `EntityStatus.DRAFT` and nothing in the import path
promotes them past it, so "stays in draft until resolved" is already true
today — this design only adds the visible flag.

## New surface needed: import by URL

Pasting/uploading raw text (today's only input) has no "base location" to
resolve a relative `$ref` against. This design adds a URL-based import entry
point (new input alongside paste/upload in `ImportDialog.tsx`) and a new
server action (`"use server"`, following the existing pattern in
`openapi-import-actions.ts`/`typespec-import-actions.ts`) — resolution must
run server-side, since it needs the server's `gh` auth/network access, not
the browser's.



## Left to the builder (vendor extensions, Addendum A, Addendum B)

- Exact final shape of the "known keywords" allow-list in
  `jsonschema.importer.ts` (enumerate from the current `JsonSchemaNode`
  interface and the keywords `resolveSchemaType`/`buildFields`/`extractConstraints`
  actually read — don't hand-copy this doc's list without re-checking against
  the file at implementation time, in case it's changed).
- The `extends` vs. spread choice for synthetic per-item models (path A) —
  verify empirically against a real `@typespec/json-schema` compile.
- TypeSpec value-literal serializer/parser edge cases: `null`, nested
  arrays/objects, numbers vs. numeric strings.
- Exact warning message wording for the C fallback.
- Field-level UI already exists:
  `.../fields/[fieldId]/panels/ExtensionsPanel.tsx` reads/writes
  `extensions.openapi` (the exact `decorators.typespec.extensions.openapi` bag
  this design feeds) — no new field-level UI needed, imported extensions just
  show up there. Entity-level has no equivalent panel today; whether to add
  one in this pass or leave entity extensions editable only by re-importing /
  editing TypeSpec source directly is left to the builder.
- Whether the import review screen should flag "this entity/field carries
  preserved-but-uninterpreted extensions" before the user confirms the
  import — reuse whatever visual convention already marks low-confidence
  fields rather than inventing a new one.
- **Addendum A:** exact threshold for "this `allOf` is defining a whole
  entity" vs. "this `allOf` is a property's type" — needs to hook into
  wherever `indexDefinitions`/`isObjectSchema` currently decide a node is an
  entity, verify against the actual nesting the importer walks.
- **Addendum A:** whether `anyOf`/`oneOf` members that are a mix of `$ref`s
  and inline primitive schemas still produce a `UnionType`, or fall back to
  low-confidence — pick whatever's consistent with how `UnionType` is built
  elsewhere in this codebase (check `typespec.importer.ts` union handling).
- **Addendum B:** exact custom-resolver implementation against
  `@apidevtools/json-schema-ref-parser`'s `options.resolve` API — how it
  detects "this URI is one of our known internal git hosts" vs. "this is a
  plain HTTP(S) URL" vs. "we have no way to reach this," and how it maps a
  resolved relative path back to a `gh api --hostname <host> repos/<owner>/<repo>/contents/<path>`
  call (owner/repo/branch need to come from the import's starting URL, not
  be hardcoded to the PayPal repo used for testing).
- **Addendum B:** concurrency/cycle limits for transitive resolution (a
  schema graph with a cycle, or hundreds of transitively reachable files,
  needs a bound — check how `MAX_REF_DEPTH`/`MAX_SCHEMA_NESTING` already
  guard the hand-rolled path and apply an equivalent bound here).
- **Addendum B:** how a resolved external entity's name is chosen (prefer
  the fetched document's `title`, falling back to today's basename
  derivation) and how cross-file name collisions are actually disambiguated
  once resolution is by real URI instead of guessed basename.

