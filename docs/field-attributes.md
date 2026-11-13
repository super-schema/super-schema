# Field attributes

The quick inspector and full Field Studio use the same attribute sections, labels, type-specific controls, validation, and serialization semantics. Saving edits changes the working draft. Publishing and deploying continue to use the entity/version workflows.

## Description and compatibility

`Field.description` is the canonical description. Field-level Summary and the duplicate TypeSpec `documentation.doc` property have been removed from authoring and from the current decorator schema. The generator emits one `@doc` and no field `@summary`.

Legacy records remain readable without a bulk database mutation. The read/compiler adapters choose the first nonblank text from `Field.description`, legacy `documentation.doc`, then legacy `documentation.summary`. On creation, save, import, and source application, legacy decorator text is normalized. Conflicting text is retained in `decorators.legacyDocumentation` and can be inspected under Documentation. An explicitly cleared description stays cleared. Existing published snapshots remain immutable.

Legacy source formats can still supply a summary; it is compatibility input, rather than a second editable field attribute. Operation/message summaries retain their own format-defined semantics.

## Attribute categories

| Category | Behavior |
| --- | --- |
| Properties | Requiredness, nullability, typed default, key, semantic format, decimal precision/scale, enum values, array/map member types, aliases. |
| Documentation | Typed example, external documentation, preserved legacy text. Description remains visible above the sections and has a safe Markdown preview. |
| Validation | Numeric bounds with inclusive/exclusive endpoints, string length/pattern, array length. Inconsistent ranges, invalid regexes and invalid dimensions are rejected. |
| Data Quality | Dataset/business assertions with JSON parameters, distinct from payload constraints. Assertions are metadata for quality tooling; this editor does not execute them against production data. |
| Data Governance | Classification (a fixed 1-5 class scale, see [Dictionaries](dictionaries.md#the-class-scale)), sensitive-value annotation, sensitive data categories, glossary term, units, data treatment, encryption scope/algorithm/policy reference, policy context, and custom attributes (tenant `x-` attributes are defined in the [Metadata Attribute Dictionary](dictionaries.md#metadata-attribute-dictionary)). |
| Lifecycle Visibility | Create/read/update/delete/query inclusion, presets, and a preview matching generated `visibility`, `removeVisibility`, or `invisible` annotations. User authorization remains governed by the application access policy. |
| Serialization | Type-specific encoding, media-type-specific encoded names, and Protobuf field number. HTTP placement belongs to API operations. Legacy field HTTP/XML metadata is preserved and identified as such. |
| Storage Hints | Requested partition/index/cluster hints. These are metadata and do not provision physical structures. |
| Extensions | Explicit string/number/boolean/null/JSON values, editing/removal, duplicate protection, and vendor-prefix handling. Existing imported schema keys retain their identity when edited. An `x-` key defined in the [Metadata Attribute Dictionary](dictionaries.md#metadata-attribute-dictionary) is validated against its value schema, and its derived members follow the field on save. |
| Schema Evolution | Added/removed/renamed/type/requiredness annotations, deprecation and replacement guidance, and the entity discriminator property selection. This is separate from recorded audit/version history. |

## Presence, nullability and defaults

| Required | Allow null | Canonical TypeSpec |
| --- | --- | --- |
| Yes | No | `value: string;` |
| No | No | `value?: string;` |
| Yes | Yes | `value: string \| null;` |
| No | Yes | `value?: string \| null;` |

The existing database representation remains compatible: `Field.nullable` means the property may be absent or its value may be null. `decorators.nullableType` and `decorators.requiredNullable` distinguish these cases. Shared helpers are the only editor conversion boundary. Keys are always required and non-null.

Boolean defaults distinguish No default, true and false. Examples are stored as typed values, including structured JSON, and remain separate from defaults. Authoring feedback checks examples/defaults against the configured numeric bounds, string lengths/patterns, and array sizes. Large integer example text is preserved; when TypeSpec cannot emit it exactly, the editor reports the limitation rather than rounding silently. A schema default is a contract annotation; consumer behavior determines whether it is applied at runtime.

## Governance and target behavior

Protection controls record requirements, not a claim that data has been transformed. The Secret annotation does not itself mask logs, redact responses, or encrypt data. Treatment distinguishes masking, hashing, redaction and pseudonymization. Encryption scope, algorithm and policy reference are independent; key material must not be entered here. A compatibility string remains available to existing compliance readers.

Policy context is read-only and is not copied into field overrides. Entity retention takes precedence over domain template context when available. Ownership is shown only when supplied by the existing context. Retention continues to be managed at entity/domain level.

Target adapters remain authoritative about supported features. JSON Schema and OpenAPI can preserve vendor extensions; other targets may ignore them. Storage hints and quality requirements need consuming tooling. XML is not an available output target. Aliases, formats, constraints, nullability, precision and scale have target-specific interpretations and restrictions.

Schema evolution generates a version enum from the used labels (natural numeric label order), imports the TypeSpec versioning library, and emits all supported evolution annotations. Closure namespaces share one enum per namespace. This does not create historical database snapshots or replace the application's publish/version workflow. Discriminator annotations are emitted on the model, never on a property; ambiguous selections fail validation.

Protobuf numbers must be 1–536870911, excluding reserved values 19000–19999. Automatic assignment skips the reserved interval. Changes to published field numbers require wire-compatibility review.

## Verification

Focused tests cover documentation recovery and conflict preservation; all four presence/nullability combinations; typed defaults, examples and extensions; save/discard and reference-selection races; source application; lifecycle visibility; schema evolution and discriminator scope. Generated annotations are compiled with the real TypeSpec compiler. Target checks exercise JSON Schema, OpenAPI, Avro, Protobuf, Java, PostgreSQL, Spanner and BigQuery. JSON Schema assertions inspect actual requiredness, nullable types and deprecation output.

The browser review mounts the actual inspector with representative data and the application stylesheet, at 1280px and 390px in light and dark themes. This isolates editor rendering from authentication and production data. No live user records are modified by the preview.

Validation uses the existing installed dependencies; a fresh registry installation is not part of this change.

Focused verification commands (run at the repository root):

```sh
npm run test -- --run tests/unit/lib/field-attributes.test.ts tests/unit/compiler/field-attributes-generation.test.ts tests/unit/components/field-attributes-ui.test.tsx
npx --no-install tsc --noEmit
npm run build
```

Canonical implementation pointers: `src/lib/field-attributes.ts`, the TypeSpec decorator schema, and `fields/[fieldId]/panels/FieldAttributeSections.tsx`.
