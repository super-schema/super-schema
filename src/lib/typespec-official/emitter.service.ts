import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type {
  PrismaEntityInput,
  PrismaFieldInput,
} from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { protobufFieldName, quoteIdentifier, sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import type { ValidationError } from "@/lib/compiler/types";
import type { ValidationStatus } from "@/lib/emission/emission.types";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { buildDbTypeSpecSource, isDbTypeSpecTarget } from "./db-source";
import { describeAvroProjection, projectTypeSpecSourceForAvro } from "./avro-source";
import { projectTypeSpecSourceForProtobuf } from "./protobuf-source";
import { ok, err, type Result } from "@/types/result";
import { checkTypeSpecImports, TYPESPEC_IMPORT_NOT_ALLOWED } from "@/lib/typespec/import-guard";

const execFileAsync = promisify(execFile);

export interface OfficialTypeSpecTargetResult {
  output: string;
  validationStatus: ValidationStatus;
  warnings: string[];
  errors: ValidationError[];
}

export async function emitOfficialTypeSpecTargetForEntity(
  entityId: string,
  targetKey: string
): Promise<OfficialTypeSpecTargetResult> {
  // Lazy import so the module can be used (FromData path) without a DATABASE_URL.
  const { prisma } = await import("@/lib/db");
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    include: { domain: true },
  });

  if (!entity) {
    return {
      output: "",
      validationStatus: "INVALID",
      warnings: [],
      errors: [{ message: `Entity not found: ${entityId}` }],
    };
  }

  const fields = await prisma.field.findMany({
    where: { entityId },
    orderBy: { sortOrder: "asc" },
  });

  const prismaEntity: PrismaEntityInput = {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    status: entity.status,
    version: entity.version,
    domainId: entity.domainId,
    metadata: entity.metadata,
    domain: entity.domain
      ? {
          id: entity.domain.id,
          name: entity.domain.name,
          slug: entity.domain.name.toLowerCase().replace(/\s+/g, "-"),
        }
      : null,
  };

  const prismaFields: PrismaFieldInput[] = fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    precision: field.precision,
    scale: field.scale,
    nullable: field.nullable,
    isKey: field.isKey,
    fieldNumber: field.fieldNumber,
    description: field.description,
    classification: field.classification,
    aliases: field.aliases,
    decorators: field.decorators,
    sortOrder: field.sortOrder,
  }));

  return emitOfficialTypeSpecTargetFromData(prismaEntity, prismaFields, targetKey);
}

export async function emitOfficialTypeSpecTargetFromData(
  entity: PrismaEntityInput,
  fields: PrismaFieldInput[],
  targetKey: string
): Promise<OfficialTypeSpecTargetResult> {
  const target = getSchemaTargetDefinition(targetKey);
  if (!target || target.runtime !== "typespec-cli") {
    return invalidResult(`Unsupported TypeSpec target "${targetKey}"`);
  }

  if (!target.enabledInSchemaTab) {
    return invalidResult(
      target.unavailableReason ??
        `Target "${target.displayName}" is not available in the Schemas tab.`
    );
  }

  const model = compileEntity(entity, fields);
  const built = buildSourceForTarget(model, target.key);
  if (built.errors.length > 0) {
    return { output: "", validationStatus: "INVALID", warnings: built.warnings, errors: built.errors.map((message) => ({ message })) };
  }
  const options = buildEmitterOptions(target.key, model);
  const result = await runTypeSpecEmitter(target.packageName ?? "", built.source, options);
  if (built.warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...built.warnings, ...result.warnings],
    validationStatus: result.validationStatus === "VALID" ? "WARNING" : result.validationStatus,
  };
}

function buildEmitterOptions(
  targetKey: string,
  model: SuperSchemaModel
): Record<string, unknown> {
  switch (targetKey) {
    case "openapi3":
      return {
        "file-type": "yaml",
        "openapi-versions": ["3.1.0"],
      };
    case "json-schema":
      return {
        emitAllModels: true,
        "file-type": "json",
        bundleId: sanitizeIdentifier(model.entity.name),
      };
    case "protobuf":
      return {};
    case "avro":
    case "java-pojo":
      return {};
    case "spanner":
    case "postgresql":
    case "bigquery":
      return { "naming-convention": "snake_case" };
    default:
      return {};
  }
}

/** The `main.tsp` for a target, plus what the projection for that target had to change (warnings) or could not (errors). */
interface TargetSource {
  source: string;
  warnings: string[];
  errors: string[];
}

const plainSource = (source: string): TargetSource => ({ source, warnings: [], errors: [] });

function buildSourceForTarget(model: SuperSchemaModel, targetKey: string): TargetSource {
  if (isDbTypeSpecTarget(targetKey)) {
    return plainSource(buildDbTypeSpecSource(model, targetKey));
  }

  // Emission source = the generator's text WITHOUT the governance overlay (Story 16.6): field classification
  // (`@Enterprise.dataClassification` / `x-classification`), entity tags (`x-tags`) and their imports. It is
  // an explicit projection, not a strip — the canonical source (Source tab, publish gate, frozen versions)
  // carries the overlay and compiles as is. Omitted here because no typespec-cli emitter reads it
  // (@typespec/avro reads only its avro* decorators by name), and importing @superschema/typespec-enterprise
  // would leak its enums (DataClassification, AvroLogicalType, …) into the java-pojo and json-schema output.
  // Opt a target in here if an emitter ever starts consuming the overlay.
  const baseSource = generateTypeSpec(model, { governance: false }).trim();

  switch (targetKey) {
    case "json-schema":
      return plainSource(['import "@typespec/json-schema";', "", baseSource, ""].join("\n"));
    case "openapi3":
      return plainSource(buildOpenApi3Source(baseSource, model));
    case "protobuf":
      return plainSource(buildProtobufSource(baseSource, model));
    case "avro": {
      // An Avro enum symbol must be [A-Za-z_][A-Za-z0-9_]*; the canonical source keeps wire values (see avro-source.ts).
      const projection = projectTypeSpecSourceForAvro(baseSource);
      return { source: projection.source, ...describeAvroProjection(projection) };
    }
    default:
      return plainSource(baseSource);
  }
}

function buildOpenApi3Source(baseSource: string, model: SuperSchemaModel): string {
  const withNamespace = ensureNamespace(
    baseSource,
    deriveNamespace(model),
    `@service(#{ title: "${escapeTypeSpecString(model.entity.name)}" })`
  );

  return [
    'import "@typespec/http";',
    'import "@typespec/rest";',
    'import "@typespec/openapi3";',
    "using TypeSpec.Http;",
    "using TypeSpec.Rest;",
    "",
    withNamespace,
    "",
  ].join("\n");
}

/**
 * The canonical source uses TypeSpec stdlib scalars (decimal, utcDateTime,
 * plainDate, duration, …), `Record<…>` and value-less enums that the official
 * protobuf emitter rejects. `projectTypeSpecSourceForProtobuf` substitutes the
 * proto representations (google.protobuf.Timestamp, decimal text, map<>, …)
 * for this target only — every other target still compiles the canonical text.
 */
function buildProtobufSource(baseSource: string, model: SuperSchemaModel): string {
  const protobufSource = projectTypeSpecSourceForProtobuf(baseSource);
  const withNamespace = ensureNamespace(protobufSource, deriveNamespace(model), "@package");
  const withFieldNumbers = injectProtobufFieldDecorators(withNamespace, model);

  return [
    'import "@typespec/protobuf";',
    "using TypeSpec.Protobuf;",
    "",
    withFieldNumbers,
    "",
  ].join("\n");
}

function ensureNamespace(
  source: string,
  namespaceName: string,
  decoratorLine?: string
): string {
  if (/^\s*namespace\s+/m.test(source)) {
    if (!decoratorLine) return source;
    return source.replace(
      /^(\s*namespace\s+[^\n]+;)/m,
      `${decoratorLine}\n$1`
    );
  }

  const prefixLines = [];
  if (decoratorLine) {
    prefixLines.push(decoratorLine);
  }
  prefixLines.push(`namespace ${namespaceName};`, "");
  return `${prefixLines.join("\n")}${source}`;
}

function injectProtobufFieldDecorators(
  source: string,
  model: SuperSchemaModel
): string {
  return injectProtobufFieldNumbers(source, sanitizeIdentifier(model.entity.name), model.fields);
}

/**
 * Inject `@field(n)` before every listed property of `model <modelName>` — n is the
 * field's stored number, else its 1-based position. The model is matched by exact name
 * (`Order` never matches `OrderKey`); property lines keep their indentation.
 */
export function injectProtobufFieldNumbers(
  source: string,
  modelName: string,
  fields: ReadonlyArray<{ name: string; fieldNumber?: number | null }>
): string {
  const header = new RegExp(`\\bmodel\\s+${escapeRegExp(modelName)}(?![A-Za-z0-9_])`).exec(source);
  if (!header) return source;
  const openBrace = source.indexOf("{", header.index);
  if (openBrace === -1) return source;

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return source;

  const before = source.slice(0, openBrace + 1);
  let body = source.slice(openBrace + 1, closeBrace);
  const after = source.slice(closeBrace);

  fields.forEach((field, index) => {
    // The property is written as the protobuf projection leaves it: the bare name (the generator keeps every
    // reserved-for-future word bare), the backticked wire name (a hard keyword such as `op` / `model`, which the
    // projection keeps) or the `_`-replaced name of a non-identifier. The decorator goes in front of whichever it is.
    const fieldNumber = field.fieldNumber ?? index + 1;
    const matcher = new RegExp(
      `^([ \\t]*)(${escapeRegExp(protobufFieldName(field.name))}|${escapeRegExp(quoteIdentifier(field.name))})(\\??:)`,
      "m"
    );
    if (matcher.test(body)) {
      body = body.replace(matcher, (_whole, indent: string, name: string, tail: string) => `${indent}@field(${fieldNumber})\n${indent}${name}${tail}`);
    }
  });

  return `${before}${body}${after}`;
}

export interface EmittedFile {
  relativePath: string;
  content: string;
}

/** A hung `tsp` is killed after this long (`EMITTER_TIMEOUT`). */
export const DEFAULT_EMITTER_TIMEOUT_MS = 120_000;

/**
 * An allowlisted NAME is not enough for the `tsp` CLI: it resolves a library by walking up from the workspace
 * (under `os.tmpdir()`), so a name that is not installed in `<cwd>/node_modules` could still be found in
 * `<tmpdir>/node_modules/...` or any other `node_modules` above the workspace, and that package's JavaScript
 * would run. The workspace's own `node_modules` is a symlink to `<cwd>/node_modules` and is searched first, so
 * requiring every imported library to be installed there pins resolution to the project's installed packages.
 * Returns the first imported library that is not installed, if any.
 */
async function findUninstalledLibrary(specifiers: readonly string[]): Promise<string | null> {
  for (const specifier of new Set(specifiers)) {
    const installed = await fs.stat(path.join(process.cwd(), "node_modules", specifier)).then((s) => s.isDirectory(), () => false);
    if (!installed) return specifier;
  }
  return null;
}

/**
 * Run one TypeSpec emitter in a throw-away workspace; every file it wrote, sorted by path. Never throws: a
 * workspace that cannot be created, a failed compile and a `tsp` that outlives `timeoutMs` (SIGKILL) are errors.
 *
 * `tsp` LOADS (and, for `.js` / `.mjs`, executes) whatever the source imports, so the source is checked first with
 * the TypeSpec parser (`checkTypeSpecImports`): any import that is not an allowed library is
 * `TYPESPEC_IMPORT_NOT_ALLOWED` and no workspace is created; so is an allowed name that is not installed in
 * `<cwd>/node_modules` (`findUninstalledLibrary`). This is the single choke point for every `tsp` run
 * (Schemas-tab targets and the events renderer alike).
 */
export async function runTypeSpecEmitterFiles(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>,
  runOptions: { timeoutMs?: number } = {}
): Promise<Result<EmittedFile[]>> {
  const imports = checkTypeSpecImports(source);
  if (!imports.success) return imports;
  const uninstalled = await findUninstalledLibrary(imports.data.imports.map((i) => i.specifier));
  if (uninstalled !== null) {
    return err({
      code: TYPESPEC_IMPORT_NOT_ALLOWED,
      message: `import "${uninstalled}" is not allowed: it is not an installed TypeSpec library`,
      details: { specifier: uninstalled },
    });
  }
  let workspace: string;
  try {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "superschema-tsp-"));
  } catch (error) {
    return err({ code: "EMITTER_FAILED", message: `Could not create a TypeSpec workspace: ${error instanceof Error ? error.message : String(error)}` });
  }
  const outputDir = path.join(workspace, "out");
  const timeoutMs = runOptions.timeoutMs ?? DEFAULT_EMITTER_TIMEOUT_MS;

  try {
    await fs.symlink(
      path.join(process.cwd(), "node_modules"),
      path.join(workspace, "node_modules"),
      "dir"
    );

    const mainFile = path.join(workspace, "main.tsp");
    const configFile = path.join(workspace, "tspconfig.yaml");
    await fs.writeFile(mainFile, source, "utf8");
    await fs.writeFile(
      configFile,
      stringifyYaml({
        emit: [packageName],
        options: {
          [packageName]: {
            "emitter-output-dir": "{project-root}/out",
            ...emitterOptions,
          },
        },
      }),
      "utf8"
    );

    await execFileAsync(getTspBinaryPath(), ["compile", mainFile, "--config", configFile, "--pretty", "false"], {
      cwd: workspace,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    const files = await collectTextFiles(outputDir);
    if (files.length === 0) {
      return err({ code: "EMITTER_NO_OUTPUT", message: `Emitter "${packageName}" completed but did not write any files.` });
    }
    return ok(files);
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { killed?: boolean }).killed === true) {
      return err({ code: "EMITTER_TIMEOUT", message: `Emitter "${packageName}" did not finish within ${timeoutMs} ms and was killed.` });
    }
    const message = error instanceof Error ? error.message : "TypeSpec emitter failed";
    const details = typeof error === "object" && error !== null && "stdout" in error
      ? [String((error as { stdout?: string }).stdout ?? ""), String((error as { stderr?: string }).stderr ?? "")]
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";

    return err({ code: "EMITTER_FAILED", message: details || message });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runTypeSpecEmitter(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>
): Promise<OfficialTypeSpecTargetResult> {
  const files = await runTypeSpecEmitterFiles(packageName, source, emitterOptions);
  if (!files.success) return invalidResult(files.error.message);
  return targetResultFromFiles(packageName, files.data);
}

/** What an emitter run wrote, as a target result: VALID only when the output is usable (see {@link unusableOutputReason}). */
export function targetResultFromFiles(packageName: string, files: EmittedFile[]): OfficialTypeSpecTargetResult {
  const output = bundleGeneratedFiles(files);
  const unusable = unusableOutputReason(packageName, output);
  if (unusable) return invalidResult(unusable);
  return { output, validationStatus: "VALID", warnings: [], errors: [] };
}

/**
 * An emitter can finish "successfully" and still write nothing useful. The protobuf emitter silently drops a message
 * whose fields lack `@field(n)` and then writes only `syntax = "proto3";` — that is not a valid result, so say so.
 */
export function unusableOutputReason(packageName: string, output: string): string | null {
  if (packageName === "@typespec/protobuf" && !/^\s*message\s+\S+\s*\{/m.test(output)) {
    return "The protobuf emitter wrote no message: none of the model's fields received a @field(n) number, so it dropped the whole message.";
  }
  return null;
}

async function collectTextFiles(rootDir: string): Promise<EmittedFile[]> {
  const files: EmittedFile[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const content = await fs.readFile(fullPath, "utf8");
      files.push({
        relativePath: path.relative(rootDir, fullPath),
        content,
      });
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

function bundleGeneratedFiles(files: EmittedFile[]): string {
  if (files.length === 1) {
    return files[0].content;
  }

  return files
    .map(
      (file) =>
        `===== ${file.relativePath} =====\n${file.content.trimEnd()}`
    )
    .join("\n\n");
}

function getTspBinaryPath(): string {
  return process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".bin", "tsp.cmd")
    : path.join(process.cwd(), "node_modules", ".bin", "tsp");
}

function invalidResult(message: string): OfficialTypeSpecTargetResult {
  return {
    output: "",
    validationStatus: "INVALID",
    warnings: [],
    errors: [{ message }],
  };
}

function deriveNamespace(model: SuperSchemaModel): string {
  return sanitizeNamespace(model.namespace || model.entity.domain || model.entity.name);
}

/** A namespace segment: invalid characters become `_`; a keyword is backticked by {@link sanitizeNamespace}, not renamed. */
function sanitizeNamespaceSegment(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

/**
 * TypeSpec keywords (incl. reserved-for-future ones) from the
 * @typespec/compiler 1.10 scanner. A bare keyword used as an identifier fails
 * the real compile with `reserved-identifier`; it must be backtick-escaped.
 * Reachable in practice: a tenant-level entity has no domain, so
 * `compileEntity()` reports its domain as "unknown" — a keyword.
 */
const TYPESPEC_KEYWORDS = new Set([
  "import", "model", "scalar", "namespace", "interface", "union", "if", "else",
  "projection", "using", "op", "extends", "is", "enum", "alias", "dec", "fn",
  "valueof", "typeof", "const", "init", "true", "false", "return", "void",
  "never", "unknown", "extern", "internal", "statemachine", "macro", "package",
  "metadata", "env", "arg", "declare", "array", "struct", "record", "module",
  "mod", "sym", "context", "prop", "property", "scenario", "pub", "sub",
  "typeref", "trait", "this", "self", "super", "keyof", "with", "implements",
  "impl", "satisfies", "flag", "auto", "partial", "private", "public",
  "protected", "sealed", "local", "async",
]);

function sanitizeNamespace(value: string): string {
  return value
    .split(".")
    .map((segment) => sanitizeNamespaceSegment(segment))
    .map((segment) => (TYPESPEC_KEYWORDS.has(segment) ? `\`${segment}\`` : segment))
    .join(".");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTypeSpecString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
