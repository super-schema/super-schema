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
import { toCompilableTypeSpec } from "@/lib/compiler/compilable-source";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { ValidationError } from "@/lib/compiler/types";
import type { ValidationStatus } from "@/lib/emission/emission.types";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { buildDbTypeSpecSource, isDbTypeSpecTarget } from "./db-source";
import { projectTypeSpecSourceForProtobuf } from "./protobuf-source";
import { ok, err, type Result } from "@/types/result";

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
  const source = buildSourceForTarget(model, target.key);
  const options = buildEmitterOptions(target.key, model);
  return runTypeSpecEmitter(target.packageName ?? "", source, options);
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

function buildSourceForTarget(model: SuperSchemaModel, targetKey: string): string {
  if (isDbTypeSpecTarget(targetKey)) {
    return buildDbTypeSpecSource(model, targetKey);
  }

  // Real TypeSpec rejects the `@tag(...)` decorators generateTypeSpec() emits (field classification and
  // model tags), so they are stripped at the real-compile boundary. toCompilableTypeSpec is shared with the
  // publish compile gate; model-level tags are stripped too since R46 (before that an entity with tags failed
  // `decorator-wrong-target` on every typespec-cli target).
  const baseSource = toCompilableTypeSpec(generateTypeSpec(model).trim());

  switch (targetKey) {
    case "json-schema":
      return ['import "@typespec/json-schema";', "", baseSource, ""].join("\n");
    case "openapi3":
      return buildOpenApi3Source(baseSource, model);
    case "protobuf":
      return buildProtobufSource(baseSource, model);
    default:
      return baseSource;
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
    const safeName = sanitizeIdentifier(field.name);
    const fieldNumber = field.fieldNumber ?? index + 1;
    const matcher = new RegExp(`^([ \\t]*)${escapeRegExp(safeName)}(\\??:)`, "m");
    if (matcher.test(body)) body = body.replace(matcher, `$1@field(${fieldNumber})\n$1${safeName}$2`);
  });

  return `${before}${body}${after}`;
}

export interface EmittedFile {
  relativePath: string;
  content: string;
}

/** Run one TypeSpec emitter in a throw-away workspace; every file it wrote, sorted by path. */
export async function runTypeSpecEmitterFiles(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>
): Promise<Result<EmittedFile[]>> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "superschema-tsp-"));
  const outputDir = path.join(workspace, "out");

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
    });

    const files = await collectTextFiles(outputDir);
    if (files.length === 0) {
      return err({ code: "EMITTER_NO_OUTPUT", message: `Emitter "${packageName}" completed but did not write any files.` });
    }
    return ok(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TypeSpec emitter failed";
    const details = typeof error === "object" && error !== null && "stdout" in error
      ? [String((error as { stdout?: string }).stdout ?? ""), String((error as { stderr?: string }).stderr ?? "")]
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";

    return err({ code: "EMITTER_FAILED", message: details || message });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function runTypeSpecEmitter(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>
): Promise<OfficialTypeSpecTargetResult> {
  const files = await runTypeSpecEmitterFiles(packageName, source, emitterOptions);
  if (!files.success) return invalidResult(files.error.message);
  return {
    output: bundleGeneratedFiles(files.data),
    validationStatus: "VALID",
    warnings: [],
    errors: [],
  };
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

export function sanitizeIdentifier(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(safe)) {
    safe = `_${safe}`;
  }
  return safe;
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
    .map((segment) => sanitizeIdentifier(segment))
    .map((segment) => (TYPESPEC_KEYWORDS.has(segment) ? `\`${segment}\`` : segment))
    .join(".");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTypeSpecString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
