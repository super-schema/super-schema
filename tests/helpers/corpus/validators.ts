/**
 * The validator tier per target (offline ones; the emulator tiers are in emulators.ts):
 *   json-schema -> ajv 8 (the copy @typespec/compiler ships) compiles the schema against its own $schema meta-schema
 *   openapi3    -> @scalar/openapi-parser `validate` (OpenAPI 3.1 aware)
 *   avro        -> avsc `Type.forSchema`
 *   protobuf    -> protobufjs `parse` + `resolveAll`
 *   postgresql  -> the DDL executed in PGlite (inside a transaction that is rolled back)
 *   java-pojo   -> `javac -proc:none` with tiny stubs for the imported annotation packages
 *   spanner / bigquery -> LocalCloud emulators (emulators.ts)
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TargetKey } from "../../fixtures/corpus/types";

const req = createRequire(path.join(process.cwd(), "package.json"));
const compilerReq = createRequire(req.resolve("@typespec/compiler"));

export interface Validation {
  ok: boolean;
  tier: string;
  /** Present when !ok. */
  error?: string;
  /** The result could not be judged (tool missing): the matrix shows SKIPPED. */
  skipped?: boolean;
}

const pass = (tier: string): Validation => ({ ok: true, tier });
const fail = (tier: string, error: string): Validation => ({ ok: false, tier, error: error.slice(0, 700) });

/** At most this many unresolved external `$ref`s are stubbed per output (a hostile document cannot make the loop unbounded). */
const MAX_STUBBED_REFS = 500;

/**
 * Makes the node a JSON pointer (`/$defs/Money`) names exist in `stub` (as `{}`); true when something was added. A pointer that is
 * not a plain `/a/b` path (an anchor, `__proto__`, an empty path) adds nothing, so the caller gives up on that ref.
 */
function graftPointer(stub: Record<string, unknown>, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let node = stub;
  let added = false;
  for (const raw of pointer.slice(1).split("/")) {
    let key: string;
    try { key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return added; }
    if (key === "__proto__") return added;
    if (!Object.prototype.hasOwnProperty.call(node, key)) {
      node[key] = {};
      added = true;
    }
    const next = node[key];
    if (typeof next !== "object" || next === null) return added;
    node = next as Record<string, unknown>;
  }
  return added;
}

/**
 * The JSON Schema output of the app is one bare document, or (a closure, or a stand-alone entity that declares an enum / shared
 * type) several documents joined as `===== <Name>.json =====` blocks, which reference each other by file (`$ref: "Other.json"`,
 * resolved against each document's own `$id`). Every document is added to one ajv instance (adding validates it against the
 * meta-schema of its dialect) and compiled, so a `$ref` to a sibling file must resolve.
 *
 * An external `$ref` that points at NO document of the output (`common_components/.../date_time.json`) is kept dangling ON PURPOSE
 * (an import has no base URL to fetch it from): it is not a defect of the output, so it is given an empty stub schema and
 * compilation continues. Only a ref that is unresolved for any other reason fails.
 */
export async function validateJsonSchema(output: string): Promise<Validation> {
  const tier = "ajv 8 meta-schema compile";
  const bundled = splitBundledFiles(output);
  const files = bundled.length > 0 ? bundled : [{ name: "main.json", body: output }];
  const schemas: Array<{ name: string; schema: Record<string, unknown> }> = [];
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(file.body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail(tier, `${file.name} is not a JSON object`);
      schemas.push({ name: file.name, schema: parsed as Record<string, unknown> });
    } catch (e) {
      return fail(tier, `not JSON${bundled.length > 0 ? ` (${file.name})` : ""}: ${(e as Error).message}`);
    }
  }
  const uri = String(schemas[0]?.schema.$schema ?? "");
  const known = uri.includes("2020-12") || uri.includes("2019-09");
  const options = { strict: false, validateFormats: false, allErrors: false };
  try {
    let Ctor: new (o: object) => {
      addSchema(s: object, key?: string): unknown;
      removeSchema(key: string): unknown;
      getSchema(key: string): unknown;
    };
    if (uri.includes("2020-12")) Ctor = compilerReq("ajv/dist/2020").default;
    else if (uri.includes("2019-09")) Ctor = compilerReq("ajv/dist/2019").default;
    else Ctor = compilerReq("ajv").default ?? compilerReq("ajv");
    const ajv = new Ctor(options);
    const keys = schemas.map(({ name, schema }) => {
      // A draft we do not know is compiled as the default one.
      const { $schema: _ignored, ...rest } = schema;
      void _ignored;
      const key = typeof schema.$id === "string" && schema.$id !== "" ? schema.$id : name;
      ajv.addSchema(known ? schema : rest, key);
      return key;
    });
    let stubbed = 0;
    const stubs = new Map<string, Record<string, unknown>>();
    for (const key of keys) {
      for (;;) {
        try {
          // Compiling the schema validates it against the meta-schema of its dialect and resolves its references.
          ajv.getSchema(key);
          break;
        } catch (e) {
          const { missingSchema, missingRef } = e as { missingSchema?: unknown; missingRef?: unknown };
          if (typeof missingSchema !== "string" || stubbed >= MAX_STUBBED_REFS) throw e;
          const stub = stubs.get(missingSchema) ?? {};
          // A ref with a pointer (`other.json#/$defs/Money`) needs that node to exist in the stub.
          const pointer = typeof missingRef === "string" && missingRef.includes("#") ? missingRef.slice(missingRef.indexOf("#") + 1) : "";
          if (!graftPointer(stub, pointer) && stubs.has(missingSchema)) throw e;
          if (stubs.has(missingSchema)) ajv.removeSchema(missingSchema);
          stubs.set(missingSchema, stub);
          stubbed += 1;
          ajv.addSchema(stub, missingSchema);
        }
      }
    }
    return pass(stubbed > 0 ? `${tier} (dangling external $ref tolerated)` : tier);
  } catch (e) {
    return fail(tier, (e as Error).message);
  }
}

export async function validateOpenApi(output: string): Promise<Validation> {
  const tier = "@scalar/openapi-parser validate";
  try {
    const { validate } = (await import("@scalar/openapi-parser")) as unknown as {
      validate: (c: string) => Promise<{ valid: boolean; errors?: Array<{ message: string }> }>;
    };
    const result = await validate(output);
    if (result.valid) return pass(tier);
    // A `$ref` to another file is kept dangling ON PURPOSE (the import has no base URL); that is not a defect of the document.
    const real = (result.errors ?? []).filter((x) => !/Can't resolve external reference/i.test(x.message));
    return real.length === 0 ? { ok: true, tier: `${tier} (dangling external $ref tolerated)` } : fail(tier, real.map((x) => x.message).join(" | "));
  } catch (e) {
    return fail(tier, `validator threw: ${(e as Error).message}`);
  }
}

export async function validateAvro(output: string): Promise<Validation> {
  const tier = "avsc Type.forSchema";
  try {
    const avsc = req("avsc") as { Type: { forSchema(s: unknown): unknown } };
    avsc.Type.forSchema(JSON.parse(output));
    return pass(tier);
  } catch (e) {
    return fail(tier, (e as Error).message);
  }
}

export async function validateProtobuf(output: string): Promise<Validation> {
  const tier = "protobufjs parse + resolveAll";
  // protobufjs resolves `google/protobuf/*.proto` imports (its bundled well-known types) only when loading a file.
  const dir = await mkdtemp(path.join(tmpdir(), "ss-corpus-proto-"));
  try {
    const protobuf = req("protobufjs") as { Root: new () => { loadSync(file: string, o?: object): { resolveAll(): void } } };
    const file = path.join(dir, "schema.proto");
    await writeFile(file, output);
    // protobufjs bundles google/protobuf/* only; the google/type/* well-known files the emitter may import are stubbed (field-for-field as published).
    const stubs: Record<string, string> = {
      "google/type/date.proto": 'syntax = "proto3"; package google.type; message Date { int32 year = 1; int32 month = 2; int32 day = 3; }',
      "google/type/timeofday.proto": 'syntax = "proto3"; package google.type; message TimeOfDay { int32 hours = 1; int32 minutes = 2; int32 seconds = 3; int32 nanos = 4; }',
    };
    for (const [rel, body] of Object.entries(stubs)) {
      if (!output.includes(`"${rel}"`)) continue;
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), body);
    }
    new protobuf.Root().loadSync(file, { keepCase: true }).resolveAll();
    return pass(tier);
  } catch (e) {
    return fail(tier, (e as Error).message.replaceAll(dir, "<tmp>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Pg = { exec(sql: string): Promise<unknown> };
let pglite: Promise<Pg> | undefined;
async function sharedPglite(): Promise<Pg> {
  pglite ??= import("@electric-sql/pglite").then(async ({ PGlite }) => {
    const db = new PGlite();
    await db.waitReady;
    return db as unknown as Pg;
  });
  return pglite;
}
let pgChain: Promise<unknown> = Promise.resolve();

/** PGlite is single-connection: serialise, and roll every case back so cases cannot see each other's tables. */
export async function validatePostgres(ddl: string): Promise<Validation> {
  const tier = "PGlite DDL execution";
  const run = async (): Promise<Validation> => {
    const db = await sharedPglite();
    try {
      await db.exec("BEGIN");
      await db.exec(ddl);
      return pass(tier);
    } catch (e) {
      return fail(tier, (e as Error).message);
    } finally {
      try { await db.exec("ROLLBACK"); } catch { /* nothing open */ }
    }
  };
  const result = pgChain.then(run, run);
  pgChain = result.catch(() => undefined);
  return result;
}

function exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

let javacAvailable: Promise<boolean> | undefined;

/** Splits the "===== Name.ext =====" multi-file output (bundleGeneratedFiles) into its files; empty when the output is one bare file. */
export function splitBundledFiles(output: string): Array<{ name: string; body: string }> {
  const parts = output.split(/^===== (.+?) =====$/m);
  const files: Array<{ name: string; body: string }> = [];
  for (let i = 1; i + 1 < parts.length; i += 2) files.push({ name: parts[i].trim(), body: parts[i + 1] });
  return files;
}

/** The java-pojo emitter's multi-file output (a single class is written without the marker, see validateJava). */
export const splitJavaFiles = splitBundledFiles;

/** Stub annotation types for the annotation packages the emitter may import (all imports of those packages become empty @interfaces). */
function stubsFor(sources: string[]): Array<{ rel: string; body: string }> {
  const stubs = new Map<string, { rel: string; body: string }>();
  for (const src of sources) {
    for (const m of src.matchAll(/^import\s+((?:com\.fasterxml|jakarta|javax)\.[\w.]+)\.([A-Z]\w*);/gm)) {
      const pkg = m[1];
      const name = m[2];
      if (pkg.startsWith("javax.xml") || pkg === "javax.annotation") { /* still stub: not in JDK 25 */ }
      stubs.set(`${pkg}.${name}`, {
        rel: path.join(...pkg.split("."), `${name}.java`),
        body: `package ${pkg};\npublic @interface ${name} { String value() default ""; String[] names() default {}; String pattern() default ""; String regexp() default ""; int min() default 0; int max() default Integer.MAX_VALUE; String message() default ""; }\n`,
      });
    }
  }
  return [...stubs.values()];
}

async function compileJava(files: Array<{ name: string; body: string }>): Promise<{ ok: boolean; out: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-corpus-java-"));
  try {
    const out = path.join(dir, "out");
    await mkdir(out, { recursive: true });
    const written: string[] = [];
    for (const f of files) {
      const rel = path.normalize(f.name);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, out: `unsafe file name ${f.name}` };
      const abs = path.join(dir, "src", rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.body);
      written.push(abs);
    }
    for (const s of stubsFor(files.map((f) => f.body))) {
      const abs = path.join(dir, "stubs", s.rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, s.body);
      written.push(abs);
    }
    const result = await exec("javac", ["-proc:none", "-Xlint:none", "-d", out, ...written], dir, 60000);
    return { ok: result.code === 0, out: result.out.replaceAll(dir, "<tmp>") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Marker prefix of the one failure that compiles once a missing `package` line is added (see known-issues.ts). */
export const JAVA_ENUM_NO_PACKAGE = "enum/class file has no package declaration";

export async function validateJava(output: string): Promise<Validation> {
  const tier = "javac -proc:none (annotation stubs)";
  javacAvailable ??= exec("javac", ["-version"], process.cwd(), 15000).then((r) => r.code === 0);
  if (!(await javacAvailable)) return { ok: true, tier: "javac not installed", skipped: true };
  let files = splitJavaFiles(output);
  if (files.length === 0) {
    // A single class is written without the `===== File.java =====` marker.
    const m = /public\s+(?:final\s+)?(?:class|enum|interface|record)\s+(\w+)/.exec(output);
    if (!m) return fail(tier, "java-pojo output has no class and no file markers");
    files = [{ name: `${m[1]}.java`, body: output }];
  }
  const first = await compileJava(files);
  if (first.ok) return pass(tier);
  // Isolate the known sibling defect: files without a package line next to files with one.
  const pkg = files.map((f) => /^package\s+[\w.]+;/m.exec(f.body)?.[0]).find((p) => p);
  if (pkg && files.some((f) => !/^package\s/m.test(f.body))) {
    const fixed = await compileJava(files.map((f) => (/^package\s/m.test(f.body) ? f : { ...f, body: `${pkg}\n\n${f.body}` })));
    if (fixed.ok) return fail(tier, `${JAVA_ENUM_NO_PACKAGE}: javac fails as emitted but compiles after adding \`${pkg}\` to the package-less files`);
    return fail(tier, `still failing with the package line added: ${fixed.out.slice(0, 380)} (as emitted: ${first.out.slice(0, 200)})`);
  }
  return fail(tier, first.out);
}

/** The offline validator for `target`; the emulator targets return undefined (see emulators.ts). */
export async function validateOffline(target: TargetKey, output: string): Promise<Validation | undefined> {
  switch (target) {
    case "json-schema": return validateJsonSchema(output);
    case "openapi3": return validateOpenApi(output);
    case "avro": return validateAvro(output);
    case "protobuf": return validateProtobuf(output);
    case "postgresql": return validatePostgres(output);
    case "java-pojo": return validateJava(output);
    default: return undefined;
  }
}
