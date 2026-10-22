/**
 * Direct super-schema cases written as TypeSpec source (the app's canonical form). Each goes through the real TypeSpec import
 * (compileTypeSpecDocument -> mapDocumentToImportResult) and then the same payload / row chain as every other import.
 */
import type { CorpusCase, CorpusExpectations } from "./types";

const OA = 'import "@typespec/openapi";';
const ENT = 'import "@superschema/typespec-enterprise";';

function tsp(id: string, title: string, source: string, tags: string[], expectations: CorpusExpectations = {}): CorpusCase {
  return { id: `tsp-${id}`, title, kind: "typespec", source: `${source.trim()}\n`, tags: ["typespec", ...tags], expectations: { roundTrip: false, ...expectations } };
}

export const TYPESPEC_CASES: CorpusCase[] = [
  tsp("basic-model", "plain model with @key and @doc", `
/** A customer. */
model Customer {
  @key id: string;
  /** Full name */
  name: string;
  age?: int32;
  active: boolean;
}`, ["basic", "key"]),
  tsp("every-scalar", "model with one field per TypeSpec scalar", `
model Scalars {
  @key id: string;
  a: int8; b: int16; c: int32; d: int64; e: uint8; f: uint16; g: uint32; h: uint64;
  i: float32; j: float64; k: decimal; l: decimal128; m: string; n: boolean; o: bytes;
  p: plainDate; q: plainTime; r: utcDateTime; s: offsetDateTime; t: duration; u: url; v: safeint; w: integer; x: float; y: numeric;
}`, ["scalar", "wide", "key"]),
  tsp("optional-nullable", "optional and nullable fields", `
model Opt {
  @key id: string;
  a?: string;
  b: string | null;
  c?: int32 | null;
  d: string[] | null;
}`, ["optional", "nullable"]),
  tsp("arrays-maps", "arrays and maps", `
model Coll {
  @key id: string;
  tags: string[];
  grid: float64[][];
  labels: Record<string>;
  counts: Record<int32>;
  lines: Line[];
  byName: Record<Line>;
}
model Line { sku: string; qty: int32; }`, ["array", "map"]),
  tsp("enum-inline", "model using a shared enum", `
enum Status { New, Open, Closed }
enum Priority { low: "L", high: "H" }
enum Level { one: 1, two: 2 }
model Ticket {
  @key id: string;
  status: Status;
  priority?: Priority;
  level: Level;
}`, ["enum"]),
  tsp("union", "union types", `
union Pet { cat: Cat, dog: Dog }
union Mixed { string, int32, boolean }
model Cat { lives: int32; }
model Dog { bark: string; }
model Owner {
  @key id: string;
  pet: Pet;
  anything: Mixed;
  maybe: string | int32;
}`, ["union"]),
  tsp("alias", "aliases", `
alias Name = string;
alias Names = Name[];
alias MaybeName = Name | null;
model Person {
  @key id: string;
  first: Name;
  all: Names;
  nick: MaybeName;
}`, ["alias"]),
  tsp("namespace", "namespace-wrapped model", `
namespace Acme.Sales;
model Invoice {
  @key number: string;
  total: decimal;
}`, ["namespace"]),
  tsp("namespace-block", "block namespace with two models", `
namespace Acme {
  model A { @key id: string; b: B; }
  model B { v: string; }
}`, ["namespace", "ref"]),
  tsp("custom-scalar", "custom scalars", `
@minLength(3) @maxLength(12) scalar Handle extends string;
scalar Money extends decimal;
@pattern("^[A-Z]{3}$") scalar Currency extends string;
model Wallet {
  @key id: string;
  handle: Handle;
  balance: Money;
  currency: Currency;
}`, ["scalar", "constraints"]),
  tsp("constraints", "constraint decorators", `
model Limits {
  @key id: string;
  @minLength(1) @maxLength(80) @pattern("^[a-z ]+$") name: string;
  @minValue(0) @maxValue(100) pct: int32;
  @minItems(1) @maxItems(5) tags: string[];
  @minValueExclusive(0) @maxValueExclusive(1) ratio: float64;
}`, ["constraints"]),
  tsp("format-secret-encoded", "@format / @secret / @encodedName", `
model Account {
  @key id: string;
  @format("email") email: string;
  @format("uuid") ref: string;
  @secret password: string;
  @encodedName("application/json", "full_name") fullName: string;
}`, ["decorators", "secret"]),
  tsp("inheritance", "extends", `
model Animal { @key id: string; name: string; }
model Dog extends Animal { breed: string; }
model Puppy extends Dog { ageWeeks: int32; }`, ["inheritance"]),
  tsp("spread", "spread", `
model Audit { createdAt: utcDateTime; createdBy: string; }
model Doc {
  @key id: string;
  ...Audit;
  title: string;
}`, ["spread"]),
  tsp("doc-comments", "doc comments with hazards", `
/**
 * Multi-line doc with */ hazards? no: escaped. "quotes" and 'single' and \`tick\`.
 */
@doc("Entity doc with \\"quotes\\" and a\\nnewline")
model Documented {
  @key id: string;
  @doc("Field doc with ${'$'}{x} and -- sql;") note: string;
}`, ["doc", "hostile"]),
  tsp("extension-decorators", "@extension on fields and the model", `
${OA}
@TypeSpec.OpenAPI.extension("x-owner", "payments")
@TypeSpec.OpenAPI.extension("x-tags", #["a", "b"])
model Ext {
  @key id: string;
  @TypeSpec.OpenAPI.extension("x-pii", true) @TypeSpec.OpenAPI.extension("x-weight", 1.5) a: string;
  @TypeSpec.OpenAPI.extension("x-meta", #{ list: #[1, 2], nested: #{ k: "v" } }) b: string;
}`, ["extension"]),
  tsp("extension-reserved-keys", "extension values with reserved-word keys", `
${OA}
model ExtRes {
  @key id: string;
  @TypeSpec.OpenAPI.extension("x-meta", #{ \`model\`: 1, \`enum\`: 2, \`namespace\`: 3, \`const\`: 4, \`import\`: 5, \`end\`: 6 }) a: string;
}`, ["extension", "reserved-words", "hostile"]),
  tsp("classification", "classification decorators", `
${ENT}
model Person {
  @key id: string;
  @Enterprise.dataClassification(Enterprise.DataClassification.PII) email: string;
  @Enterprise.dataClassification(Enterprise.DataClassification.Confidential) salary: decimal;
  @Enterprise.dataClassification(Enterprise.DataClassification.Public) nick: string;
  @secret token: string;
}`, ["classification"]),
  tsp("classification-extension", "classification as x-classification extension", `
${OA}
model Cls {
  @key id: string;
  @TypeSpec.OpenAPI.extension("x-classification", "TOP_SECRET") a: string;
}`, ["classification", "extension"]),
  tsp("reserved-field-names", "field names that are TypeSpec / SQL reserved words", `
model Reserved {
  @key id: string;
  \`model\`: string;
  \`enum\`: string;
  \`namespace\`: string;
  \`import\`: string;
  \`const\`: string;
  \`order\`: int32;
  \`when\`: utcDateTime;
  \`select\`: string;
  \`table\`: string;
  \`class\`: string;
}`, ["names", "reserved-words"]),
  tsp("default-values", "default values", `
enum Mode { Fast, Slow }
model Defaults {
  @key id: string;
  a: string = "x";
  b: int32 = 7;
  c: boolean = false;
  d: float64 = 1.5;
  e: Mode = Mode.Fast;
  f: string[] = #["a", "b"];
}`, ["defaults"]),
  tsp("deprecated", "#deprecated fields", `
model Dep {
  @key id: string;
  #deprecated "use b"
  a: string;
  b: string;
}`, ["deprecated"]),
  tsp("composite-key", "composite key", `
model Line {
  @key orderId: string;
  @key lineNo: int32;
  qty: int32;
}`, ["key", "composite"]),
  tsp("references-between-models", "reference fields and arrays of references", `
model Customer { @key id: string; name: string; }
model Order {
  @key id: string;
  customer: Customer;
  history: Customer[];
  approver?: Customer;
}`, ["ref"]),
  tsp("circular-models", "mutually recursive models", `
model A { @key id: string; b?: B; }
model B { a?: A; list: A[]; }`, ["ref", "recursive"]),
  tsp("no-key", "no @key anywhere (DB targets must ask)", `
model Keyless { a: string; b: int32; c: boolean; }`, ["key"], { requiresPrimaryKey: true }),
  tsp("operations-interface", "model plus operations and interface", `
model Pet { @key id: string; name: string; }
@route("/pets") interface Pets {
  list(): Pet[];
  @get read(@path id: string): Pet;
}`, ["operations"]),
  tsp("unknown-and-never", "unknown, never, and anonymous model fields", `
model Odd {
  @key id: string;
  anything: unknown;
  inline: { a: string, b?: int32 };
  tuple: [string, int32];
  lit: "fixed";
  num: 42;
}`, ["odd"]),
  tsp("long-and-unicode-names", "long and non-ASCII identifiers", `
model ${"L".repeat(120)} {
  @key id: string;
  \`名前\`: string;
  \`😀\`: string;
  ${"p".repeat(200)}: string;
}`, ["names", "hostile", "unicode"]),
];
