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
import type { ValidationError } from "@/lib/compiler/types";
import type { ValidationStatus } from "@/lib/emission/emission.types";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { buildDbTypeSpecSource, isDbTypeSpecTarget } from "./db-source";

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

  const baseSource = stripRealCompileInvalidDecorators(generateTypeSpec(model).trim());

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

/**
 * `generateTypeSpec()` emits `@tag("classification:...")` on fields so the
 * regex-based Paste-Import round trip (`typespec.importer.ts#extractClassification`)
 * can read it back. Real TypeSpec's `@tag` only accepts Namespace | Interface |
 * Operation targets, so a real `tsp compile` (every typespec-cli target routed
 * through this file) rejects it outright with `decorator-wrong-target`. Strip
 * it here, at the real-compile boundary, rather than stop emitting it —
 * that would silently break the paste-import round trip, which never goes
 * through a real compile and has no other way to carry classification today.
 */
function stripRealCompileInvalidDecorators(source: string): string {
  return source.replace(/^[ \t]*@tag\("classification:[^"]*"\)\n/gm, "");
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

function buildProtobufSource(baseSource: string, model: SuperSchemaModel): string {
  const withNamespace = ensureNamespace(baseSource, deriveNamespace(model), "@package");
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
  const modelName = sanitizeIdentifier(model.entity.name);
  const modelStart = source.indexOf(`model ${modelName}`);
  if (modelStart === -1) {
    return source;
  }

  const openBrace = source.indexOf("{", modelStart);
  if (openBrace === -1) {
    return source;
  }

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

  if (closeBrace === -1) {
    return source;
  }

  const before = source.slice(0, openBrace + 1);
  let body = source.slice(openBrace + 1, closeBrace);
  const after = source.slice(closeBrace);

  model.fields.forEach((field, index) => {
    const safeName = sanitizeIdentifier(field.name);
    const fieldNumber = field.fieldNumber ?? index + 1;
    const matcher = new RegExp(`^(\\s*)${escapeRegExp(safeName)}(\\??:)`, "m");
    if (matcher.test(body)) {
      body = body.replace(
        matcher,
        `$1@field(${fieldNumber})\n$1${safeName}$2`
      );
    }
  });

  return `${before}${body}${after}`;
}

async function runTypeSpecEmitter(
  packageName: string,
  source: string,
  emitterOptions: Record<string, unknown>
): Promise<OfficialTypeSpecTargetResult> {
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
      return invalidResult(`Emitter "${packageName}" completed but did not write any files.`);
    }

    return {
      output: bundleGeneratedFiles(files),
      validationStatus: "VALID",
      warnings: [],
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "TypeSpec emitter failed";
    const details = typeof error === "object" && error !== null && "stdout" in error
      ? [String((error as { stdout?: string }).stdout ?? ""), String((error as { stderr?: string }).stderr ?? "")]
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";

    return invalidResult(details || message);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function collectTextFiles(rootDir: string): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = [];

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

function bundleGeneratedFiles(files: Array<{ relativePath: string; content: string }>): string {
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

function sanitizeIdentifier(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(safe)) {
    safe = `_${safe}`;
  }
  return safe;
}

function sanitizeNamespace(value: string): string {
  return value
    .split(".")
    .map((segment) => sanitizeIdentifier(segment))
    .join(".");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTypeSpecString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
