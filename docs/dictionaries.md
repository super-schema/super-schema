# Dictionaries and the class scale

Each tenant has two dictionaries, managed by tenant administrators at **Admin > Settings > Dictionaries** (`/admin/settings/dictionaries`, tabs *Fields* and *Metadata attributes*):

- the **Field Dictionary**: canonical fields (name, aliases, type, classification, default attribute values) that authors reuse;
- the **Metadata Attribute Dictionary**: definitions of tenant `x-` attributes (what they are called, where they apply, what values they accept, how they are emitted).

## The class scale

Classification levels map onto a fixed 1-5 class scale (1 = most restrictive). The scale is not tenant-editable.

| Class | Level | Label |
| --- | --- | --- |
| 1 | `NEVER_STORED` | Never Stored |
| 2 | `PII` | PII |
| 3 | `SENSITIVE` | Sensitive |
| 4 | `INTERNAL` | Internal |
| 5 | `PUBLIC` | Public |

A tenant custom classification level that is mapped to a class number (1-5) uses that number. An unclassified field, and any level with no mapping, counts as class 3 (`SENSITIVE`). The class number is available to derived attribute members as `{class}`.

Import: a vendor level written `class1` to `class5` (case-insensitive) in the classification block of an imported JSON Schema becomes the system level of that class number (`class2` becomes `PII`). An explicit entry in the import's value map wins; any other value is kept as written.

## Field Dictionary

An entry has a name (unique per tenant, case-sensitive), aliases (matched case-insensitively), a type, a description, a classification, and default values for `x-` attributes.

- **Autocomplete.** The field editor suggests entries by name or alias.
- **Save to dictionary.** A field can be saved as a dictionary entry from the field itself. Only `schema`-scope attribute values are copied, with derived members removed, so an entry holds what the author chose, not what is computed. When an alias-matched entry is overwritten the entry keeps its name, and the prompt names it.
- **Usage.** Each entry shows how many fields are linked to it. The usage list names each field with its entity, domain and product.
- **Drift.** For each linked field, usage lists which of `type`, `description`, `classification` and `attributes` differ from the entry (the entry is the reference). Nothing is synced: drift is information only. A derived member that differs is not drift.
- **Deleting** an entry leaves the fields created from it untouched; they only lose the link.

## Metadata Attribute Dictionary

A definition describes one tenant attribute. Values are stored in the existing extension maps (a field's `typespec.extensions.openapi`, an entity's `metadata.custom.extensions`) and compile to TypeSpec as `@TypeSpec.JsonSchema.extension("x-key", ...)` plus `@TypeSpec.OpenAPI.extension("x-key", ...)`, so a TypeSpec round trip (import, GitOps pull) is lossless. An imported `x-` key that has a definition is validated against it; a key without one is kept untyped.

| Property | Meaning |
| --- | --- |
| `key` | Must match `x-` followed by letters, digits, `_`, `.` or `-`; at most 64 characters. Unique per tenant. |
| `label`, `description` | Shown in the editors. |
| `targets` | One or more of `field`, `entity`, `operation`, `channel`, `message`. The editors for fields, entities, API operations and event channels/messages/operations show the attribute where it applies. |
| `valueSchema` | A JSON Schema subset (below). |
| `scope` | `schema` (default) or `internal`. |
| `placement` | `field` (default) or `abc-primitive`. |
| `derive` | Object members computed from templates. |
| `requiredWhen` | `never` (default), `always` or `primitive`. |

### Value schema subset

Supported keywords: `type` (`string`, `number`, `integer`, `boolean`, `array`, `object`), `enum`, `format`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`, `items`, `properties`, `required`. Any other keyword is rejected when the definition is saved, as is an invalid `pattern`. Validation problems are reported with JSON pointer paths.

### Scope

- `schema`: the value is part of the contract and appears in emitted outputs.
- `internal`: the value is kept in the canonical TypeSpec and the GitOps source but is removed from every emitted output: JSON Schema, OpenAPI, AsyncAPI and the GitOps artifacts. Stored sources are stripped with a parser, not a text replace.

### Placement

`field` puts the value on the property. `abc-primitive` is for tags on primitive values: on a primitive field it sits on the property; on an array of primitives (or a nested array) it is moved onto the innermost non-array `items` of the emitted JSON Schema / OpenAPI schema; on a resolved reference to an entity, and on an array of references, it is not stored. A dangling reference counts as a plain field. `abc-primitive` requires `field` among the targets.

### Derived members

`derive` maps members of an object-typed value to templates. Each member must be a property of an object `valueSchema`. Placeholders:

| Placeholder | Value |
| --- | --- |
| `{class}` | The field's class number (1-5) |
| `{level}` | The field's classification level (`SENSITIVE` when unclassified) |
| `{name}` | The field name |
| `{type}` | The field type |

Derived members are recomputed whenever a field is saved (every field writer does it), and for existing fields when an attribute definition is created or updated or when a custom level's class number changes. User-entered members of the same value are kept.

### Required attributes and alerts

`requiredWhen: always` requires the attribute on every target; `primitive` only on primitive fields (a scalar, an enum, a property-less object, or an array of primitives). A missing required value, or a stored value that fails its value schema, raises a warning alert on the entity, API operation, channel or message. Alerts never change stored values.

### Domain-policy overrides

A domain policy can set `metadataAttributes` per key: `{ "x-key": { "requiredWhen": "...", "default": ... } }`. `requiredWhen` replaces the definition's value for that domain. `default` fills in a field that has no value for the attribute; a stored value is never overwritten, and a default that fails the value schema is ignored with a warning. Overrides for unknown keys, and malformed entries, are ignored.

### Conversion by target

| Output | Result |
| --- | --- |
| JSON Schema, OpenAPI, AsyncAPI | Emitted from the extension decorators; `internal` keys removed; `abc-primitive` tags of arrays moved to `items` |
| Avro | `schema`-scope values written as custom properties on the field or record in the `.avsc` |
| Protobuf | Custom options (`superschema/metadata_options.proto`, below) |
| DDL, Java | Not representable; a warning lists the attributes that were not emitted |

**Protobuf options.** Each definition gets a Protobuf option number from 50000 to 99999 when it is created. Numbers come from a per-tenant counter and are never reused, even after the attribute is deleted; creating an attribute fails once 99999 is passed. The Protobuf output includes `superschema/metadata_options.proto`, which declares one extension per used `schema`-scope attribute (of `google.protobuf.FieldOptions` for fields, `google.protobuf.MessageOptions` for entities; an object value schema becomes a `<Pascal(key)>Value` message). Values are written as fully qualified options, for example `[(.superschema.metadata.x_security_classification) = {...}]` on a field and `option (.superschema.metadata.<name>) = ...;` in a message. The option name is the key in snake case (`x-securityClassification` becomes `x_security_classification`). A value that fails its schema, or a definition Protobuf cannot express (a nested array, two keys collapsing to one name), is left out with a warning. Internal attributes never produce anything.

When deploying to a Schema Registry, the options file is registered under the subject `<rootSubject>-metadata-options` unless a subject for that file is configured.

## Packs

A pack is a code-defined set of dictionary entries. Installing it (on the Metadata attributes tab) creates them for the tenant; uninstalling removes only the pack's entries and leaves stored values as plain extensions. Pack entries are read-only in the dictionary. Install is all-or-nothing: it stops if the tenant already has its own entry with the same key. Nothing from a pack is visible to a tenant until it installs it.

### `paypal-security-classification`

Adds `x-securityClassification`: target `field`, scope `schema`, placement `abc-primitive`, `requiredWhen: primitive`. The value is an object with `data_class` (pattern `^class[1-5]$`, derived as `class{class}` from the field's classification) and `data_category` (chosen by the author: `ConsumerPersonal`, `BusinessPersonal`, `BusinessCompany`, `EmployeePersonal`, `PayPalCompany`, `Intrinsic`).

Implementation pointers: `src/lib/metadata-attributes/`, `src/services/metadata-*.ts`, `src/services/field-dictionary.service.ts`, `src/components/custom/admin/DictionariesAdmin.tsx`.
