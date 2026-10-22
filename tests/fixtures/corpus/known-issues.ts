/**
 * Known failures whose root cause is NOT a bug to fix in this repo, each with the evidence. A failing (case, target) that a rule matches
 * is shown in the matrix as FAIL (expected) and keeps the suite green; anything else fails the suite. Never add a rule without evidence.
 *
 * disposition:
 *   sibling  - defect in a sibling emitter package (~/src/my/typespec/packages/*), not modified here
 *   official - limitation of an official @typespec package / of the target format
 *   open     - design question for the controller (behavior is documented or ambiguous, not clearly a bug)
 *   by-design - the app refuses with an actionable message on purpose
 *   emulator - the LocalCloud emulator is narrower than the real engine (the DDL is valid there)
 *
 * Per-case `expectations.expectedFailures` entries work the same way for one-off cases.
 */
import { BQ_PK_OUTSIDE } from "../../helpers/corpus/emulators";
import { JAVA_ENUM_NO_PACKAGE } from "../../helpers/corpus/validators";
import type { BuiltCase } from "../../helpers/corpus/build-rows";
import type { TargetOutcome } from "../../helpers/corpus/run-case";
import type { CorpusCase, TargetKey } from "./types";

export interface KnownIssue {
  id: string;
  targets: readonly TargetKey[];
  disposition: "sibling" | "official" | "open" | "by-design" | "emulator";
  /** Where the defect lives. */
  owner: string;
  /** Evidence: what happens and why it is not fixed here. */
  issue: string;
  /** True when the failure of `outcome` is this issue. */
  matches: (ctx: { c: CorpusCase; outcome: TargetOutcome; built: BuiltCase }) => boolean;
}

const reasonOf = (o: TargetOutcome): string => o.reason ?? "";
const entityName = (b: BuiltCase): string => b.entity.name;
const decoratorsOf = (f: BuiltCase["fields"][number]): { referencedEntityName?: string } => (f.decorators ?? {}) as { referencedEntityName?: string };
const ALL: readonly TargetKey[] = ["json-schema", "openapi3", "avro", "protobuf", "java-pojo", "postgresql", "spanner", "bigquery"];

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    id: "bigquery-pk-after-column-list", targets: ["bigquery"], disposition: "sibling", owner: "@typespec/bigquery write.ts:74-77",
    issue: "The emitter writes `) PRIMARY KEY (...) NOT ENFORCED` AFTER the closing paren of the column list (Spanner's form). The LocalCloud BigQuery emulator (ZetaSQL parser) rejects that with `PRIMARY KEY must be defined in the table element list as column attribute or constraint`; moved inside the list it says `Unsupported table DDL fields: ['primaryKey']` (the emulator cannot create primary-key tables at all); without the clause the DDL is accepted. BigQuery's documented grammar puts the constraint inside the element list, so the placement looks like a real emitter defect, but sqlglot accepts both forms and the emulator cannot confirm either: OPEN to confirm against real BigQuery.",
    matches: ({ outcome }) => reasonOf(outcome).includes(BQ_PK_OUTSIDE),
  },
  {
    id: "bigquery-array-not-null", targets: ["bigquery"], disposition: "sibling", owner: "@typespec/bigquery write.ts (NOT NULL on a required ARRAY column)",
    issue: "A required array field is written `col ARRAY<T> NOT NULL`. The engine's analyzer says `Columns and fields of ARRAY type do not support the NOT NULL modifier` (the same message real BigQuery gives: an ARRAY column is never NULL, only empty), so the DDL cannot run. Judged without the primary-key clause so this is not hidden by bigquery-pk-after-column-list.",
    matches: ({ outcome }) => /ARRAY type do not support the NOT NULL modifier/.test(reasonOf(outcome)),
  },
  {
    id: "bigquery-emulator-timestamp-array", targets: ["bigquery"], disposition: "emulator", owner: "LocalCloud BigQuery emulator",
    issue: "`ARRAY<TIMESTAMP>` is rejected by the emulator's own loader (`TIMESTAMP columns are qualified only as top-level non-repeated columns`); real BigQuery supports arrays of timestamps. Not an emitter or app defect.",
    matches: ({ outcome }) => /TIMESTAMP columns are qualified only as top-level non-repeated/.test(reasonOf(outcome)),
  },
  {
    id: "java-enum-without-package", targets: ["java-pojo"], disposition: "sibling", owner: "@typespec/java-pojo write.ts writeJavaEnum",
    issue: "writeJavaEnum writes `public enum X {...}` with no `package` line while the POJO is in `package com.superschema.generated;`, so the class cannot see its enum (javac: cannot find symbol). javac compiles once the package line is added to the enum file (the validator proves it).",
    matches: ({ outcome }) => reasonOf(outcome).includes(JAVA_ENUM_NO_PACKAGE),
  },
  {
    id: "java-enum-constant-collision", targets: ["java-pojo"], disposition: "sibling", owner: "@typespec/java-pojo write.ts sanitizeEnumConstant",
    issue: "Different enum symbols that sanitise to the same Java constant are written twice (`\"\"` and `ÄÖ` both become UNKNOWN, `a-b` and `a_b` both A_B): javac `is already defined` even after the missing package line is added. The emitter has no uniqueness pass for constants.",
    matches: ({ outcome }) => /still failing with the package line added/.test(reasonOf(outcome)) && /already defined|duplicate/i.test(reasonOf(outcome)),
  },
  {
    id: "java-javadoc-not-escaped", targets: ["java-pojo"], disposition: "sibling", owner: "@typespec/java-pojo write.ts javadoc()",
    issue: "A description containing `*/` is written into the Javadoc unescaped, closing the comment early: javac `class, interface, enum, or record expected`. Source text of a schema can therefore inject Java code into the generated file.",
    matches: ({ outcome, built }) => /class, interface, enum, or record expected/.test(reasonOf(outcome)) && (built.entity.description.includes("*/") || built.fields.some((f) => f.description.includes("*/"))),
  },
  {
    id: "avro-recursive-model-crash", targets: ["avro"], disposition: "sibling", owner: "@typespec/avro transform.ts mapType",
    issue: "A model that refers to itself (`children: Node[]`, `parent: Node`) makes the emitter recurse without a visited set: `RangeError: Maximum call stack size exceeded` at mapType (transform.ts:261-270), reported by the app as `The TypeSpec emitter failed.`. Avro supports recursive records by name.",
    matches: ({ outcome, built }) => /TypeSpec emitter failed/.test(reasonOf(outcome)) && built.fields.some((f) => decoratorsOf(f).referencedEntityName === entityName(built)),
  },
  {
    id: "entity-name-too-long", targets: ["json-schema", "avro", "java-pojo"], disposition: "open", owner: "this repo (no name cap on import) + official emitters (file name)",
    issue: "An entity whose name is longer than the file-system limit (a 300-character `title`) reaches the emitter, which writes `<name>.json` / `.avsc` / `.java` and crashes with ENAMETOOLONG (reported as `The TypeSpec emitter failed.`). The import path has no entity-name length cap. Hostile input; the app fails loudly but without saying why.",
    matches: ({ outcome, built }) => /TypeSpec emitter failed/.test(reasonOf(outcome)) && entityName(built).length > 200,
  },
  {
    id: "multi-model-emission-gap", targets: ALL, disposition: "open", owner: "this repo (documented gap: default-mappings.ts reference -> protobuf lossDescription)",
    issue: "An entity is emitted ALONE (emitOfficialTypeSpecTargetFromData takes one entity), so a field that references another entity of the same document (`$ref: #/$defs/Addr`, a oneOf of refs, a model reference) names a type that is not in the compile unit: `invalid-ref: Unknown identifier X`. Documented in the type-mapping table as the multi-model emission gap; the DB targets store a reference as text and are unaffected.",
    matches: ({ outcome }) => /invalid-ref: Unknown identifier/.test(reasonOf(outcome)),
  },
  {
    id: "protobuf-nested-array", targets: ["protobuf"], disposition: "official", owner: "@typespec/protobuf",
    issue: "`@typespec/protobuf/nested-array: nested arrays are not supported by the Protobuf emitter`: protobuf cannot express repeated repeated fields; the app does not project an array of arrays for this target (the DB targets note `declared array; stored as ARRAY<...>`).",
    matches: ({ outcome }) => /nested-array/.test(reasonOf(outcome)),
  },
  {
    id: "names-collide-after-sanitising", targets: ["avro", "protobuf", "java-pojo"], disposition: "open", owner: "this repo (no collision guard outside the DB targets)",
    issue: "Distinct property names that sanitise to the same identifier (`😀` and `a\\u200bb` -> `__`, `userId`/`user_id`/`UserID`, `3`/`007`) are caught by the DB targets (`would all become the column`), but avro writes a schema with a duplicate field name, java-pojo writes a class that does not compile (`variable ... is already defined`) and protobuf reports `duplicate-property`. A guard like the DB targets' would turn all three into one actionable message.",
    matches: ({ outcome }) => /duplicate field name|is already defined in class|duplicate-property/.test(reasonOf(outcome)),
  },
  {
    id: "db-name-guard", targets: ["postgresql", "spanner", "bigquery"], disposition: "by-design", owner: "this repo db-source.ts (refusal)",
    issue: "A name that cannot become a column name, or that collides with another after normalisation, is refused with an actionable message naming the fields (`cannot be turned into a column name`, `would all become the column`).",
    matches: ({ outcome }) => /cannot be turned into a (column|table|schema) name|would all become the (column|table)/.test(reasonOf(outcome)),
  },
  {
    id: "openapi-internal-ref-extension", targets: ["openapi3"], disposition: "open", owner: "this repo importer (additionalProperties kept verbatim as an extension, by design)",
    issue: "`additionalProperties` is not mapped by the importer (IGNORED_SCHEMA_KEYWORDS) and is kept verbatim as an extension so a JSON Schema round trip loses nothing. When its value is a `$ref: #/$defs/V` the OpenAPI document gets `additionalProperties: {$ref: '#/$defs/V'}`, which does not resolve there (`Can't resolve reference`).",
    matches: ({ outcome }) => /Can't resolve reference: #\/\$defs/.test(reasonOf(outcome)),
  },
];

export function matchKnownIssue(c: CorpusCase, target: TargetKey, outcome: TargetOutcome, built: BuiltCase): { id: string; issue: string } | undefined {
  const explicit = c.expectations.expectedFailures?.find((f) => f.target === target || f.target === "*");
  if (explicit) return { id: "case-expectation", issue: `${explicit.reason} (${explicit.issue})` };
  return KNOWN_ISSUES.find((k) => k.targets.includes(target) && k.matches({ c, outcome, built }));
}
