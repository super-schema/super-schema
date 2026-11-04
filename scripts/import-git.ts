// Bulk "From URL" import of JSON Schema documents from an internal git host (github.paypal.com, fetched through the server's own `gh`
// credentials) into a domain and product, with the SAME importer and entity-creation code the app uses, so the result is what the
// import dialog would persist, without clicking through it file by file.
//
//   npm run import:git -- --domain identity --product Accounts <url> [<url> ...] [--file urls.txt]
//   npm run import:git -- --domain identity --product Common --file common-urls.txt
//   npm run import:git -- --dry-run <url> ...            fetch + parse only; nothing is written (no database needed)
//
// Options: --domain / --product (created when missing), --file <list> (one URL per line, `#` comments), --report <file> (JSON),
//          --git-mode any|restricted (else SCHEMA_IMPORT_GIT_MODE), --user <email> (owner; default: the first user).
// Git access is the importer's own policy: SCHEMA_IMPORT_GIT_MODE / SCHEMA_IMPORT_GIT_SCOPES (see .env.example); a refused repository
// is reported with the setting to change. Shared references that cannot be loaded (sibling repositories, scalar files) stay as
// dangling references and are listed under `unresolved`, so they can be imported later (importing the referenced file afterwards
// links them: import order does not matter).
//
// Idempotent: an asset that already exists is skipped and reported. The embedded database allows ONE process: stop the dev server first
// (or point PGLITE_DATA_DIR elsewhere). Bundled with esbuild and run with node (like seed-events-demo.ts): see the `import:git` script.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import type { Prisma } from "@/generated/prisma/client";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { generateSlug } from "@/lib/slug";
import { parseImportArgs, parseUrlList, summarizeReport } from "./import-git-cli.mjs";

interface Report {
  imported: string[];
  skipped: string[];
  failed: string[];
  unresolved: string[];
  notes: string[];
  perUrl: Array<{ url: string; ok: boolean; entities: number; enums: number; scalars: number; unions: number; warnings: number }>;
}

const DANGLING = /could not be loaded|not defined in this document|dangling/i;

/** The importer's result for one URL as the review screen's payload (everything selected). */
async function fetchPayload(url: string, report: Report) {
  const imported = await importJsonSchemaFromUrl(url);
  if (!imported.success) {
    report.failed.push(`${url}: ${imported.error.message}`);
    report.perUrl.push({ url, ok: false, entities: 0, enums: 0, scalars: 0, unions: 0, warnings: 0 });
    return undefined;
  }
  for (const warning of imported.data.warnings) if (DANGLING.test(warning)) report.unresolved.push(`${url.split("/").pop()}: ${warning.replace(/`/g, "").slice(0, 240)}`);
  const asset = toAssetImportResult(imported.data);
  const all = (items: readonly unknown[]) => items.map((_, index) => index);
  const payload = buildImportAssetsPayload(asset, {
    domainId: "",
    selectedModels: [],
    selectedEntities: all(asset.models),
    selectedEnums: all(asset.sharedEnums),
    selectedScalars: all(asset.customScalars),
    selectedUnions: all(asset.unions),
    selectedServices: [],
    selectedDecorators: [],
  });
  report.perUrl.push({
    url,
    ok: true,
    entities: payload.entities.length,
    enums: payload.sharedEnums.length,
    scalars: payload.customScalars.length,
    unions: payload.unionTypes.length,
    warnings: imported.data.warnings.length,
  });
  return payload;
}

/** Only the columns the current Prisma model has: an importer that learns new asset facts does not need this script changed. */
function onlyColumns(row: Record<string, unknown>, columns: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => key in columns && value !== undefined));
}

async function persist(payloads: Array<{ url: string; payload: NonNullable<Awaited<ReturnType<typeof fetchPayload>>> }>, options: { domain: string; product: string; user?: string }, report: Report) {
  const { Prisma } = await import("@/generated/prisma/client");
  const { prisma } = await import("@/lib/db");
  const { resolveScope } = await import("@/lib/asset-scope");
  const { validateScope } = await import("@/lib/levels");
  const { assertNameAvailable } = await import("@/services/name-registry.service");
  const { createImportedEntities, IMPORT_TRANSACTION_OPTIONS } = await import("@/services/imported-entities");
  const links = await import("@/services/imported-links");
  const { DEFAULT_TENANT_ID } = await import("@/lib/org-defaults");

  const user = options.user ? await prisma.user.findFirstOrThrow({ where: { email: options.user } }) : await prisma.user.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const slug = generateSlug(options.domain);
  const domain =
    (await prisma.domain.findFirst({ where: { tenantId: DEFAULT_TENANT_ID, OR: [{ slug }, { name: options.domain }] } })) ??
    (await prisma.domain.create({ data: { name: options.domain, slug, tenantId: DEFAULT_TENANT_ID } }));
  const productSlug = generateSlug(options.product);
  const product =
    (await prisma.product.findFirst({ where: { domainId: domain.id, OR: [{ slug: productSlug }, { name: options.product }] } })) ??
    (await prisma.product.create({ data: { domainId: domain.id, name: options.product, slug: productSlug } }));
  report.notes.push(`target: domain "${domain.name}" (${domain.id}) / product "${product.name}" (${product.id}), owner ${user.email}`);

  for (const { url, payload } of payloads) {
    const skips: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        const domainScope = await resolveScope(tx, { level: "DOMAIN", domainId: domain.id });
        if (!domainScope.success) throw new Error(domainScope.error.message);
        const productScope = await resolveScope(tx, { level: "PRODUCT", productId: product.id });
        if (!productScope.success) throw new Error(productScope.error.message);
        if (!validateScope("entity", productScope.data).success) throw new Error("entities cannot be created at this scope");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${domainScope.data.tenantId}))`;

        const free = async (kind: string, name: string, scope: typeof domainScope.data): Promise<boolean> => {
          const checked = await assertNameAvailable(tx, { name, ...scope });
          if (checked.success) return true;
          if (checked.error.code !== "NAME_CONFLICT") throw new Error(checked.error.message);
          skips.push(`${kind} ${name}: already exists`);
          return false;
        };

        for (const sharedEnum of payload.sharedEnums) {
          const name = sharedEnum.name.trim();
          if (!(await free("enum", name, domainScope.data))) continue;
          const data = { ...onlyColumns(sharedEnum as unknown as Record<string, unknown>, Prisma.SharedEnumScalarFieldEnum), name, description: sharedEnum.description ?? "", values: sharedEnum.values, ...domainScope.data };
          await tx.sharedEnum.create({ data: data as Prisma.SharedEnumUncheckedCreateInput });
          await links.relinkDanglingFieldsToEnum(tx, { domainId: domain.id, enum: { name, values: sharedEnum.values, valueDescriptions: (sharedEnum as { valueDescriptions?: Record<string, string> }).valueDescriptions, sourceRef: (sharedEnum as { sourceRef?: string }).sourceRef } });
          report.imported.push(`enum ${name}`);
        }
        for (const scalar of payload.customScalars) {
          const name = scalar.name.trim();
          if (!(await free("scalar", name, domainScope.data))) continue;
          const data = { ...onlyColumns(scalar as unknown as Record<string, unknown>, Prisma.CustomScalarScalarFieldEnum), name, description: scalar.description ?? "", ...domainScope.data };
          await tx.customScalar.create({ data: data as Prisma.CustomScalarUncheckedCreateInput });
          const relink = (links as Record<string, unknown>).relinkDanglingFieldsToScalar;
          if (typeof relink === "function") await (relink as (t: typeof tx, a: unknown) => Promise<number>)(tx, { domainId: domain.id, scalar: { ...scalar, name } });
          report.imported.push(`scalar ${name}`);
        }
        for (const union of payload.unionTypes) {
          const name = union.name.trim();
          if (!(await free("union", name, domainScope.data))) continue;
          await tx.unionType.create({ data: { name, memberTypes: union.memberTypes, description: union.description ?? "", ...domainScope.data } });
          report.imported.push(`union ${name}`);
        }
        const created = await createImportedEntities(tx, {
          entities: payload.entities,
          productScope: productScope.data,
          productId: product.id,
          ownerId: user.id,
          sourceFormat: payload.sourceFormat,
          isNameFree: (name) => free("entity", name, productScope.data),
          skip: (message) => skips.push(message),
          note: (message) => report.notes.push(`${url.split("/").pop()}: ${message}`),
          refs: new Map(),
        });
        for (const entity of created) report.imported.push(`entity ${entity.name}`);
      }, IMPORT_TRANSACTION_OPTIONS);
    } catch (error) {
      report.failed.push(`${url}: ${error instanceof Error ? error.message.split("\n").pop() : String(error)}`);
    }
    for (const skip of skips) report.skipped.push(`${url.split("/").pop()}: ${skip}`);
  }
}

async function main(): Promise<number> {
  const parsed = parseImportArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[import:git] ${parsed.error}\nusage: npm run import:git -- --domain <name> --product <name> <https url> [...] [--file list.txt] [--dry-run] [--report out.json] [--git-mode any|restricted] [--user email]`);
    return 2;
  }
  const { options } = parsed;
  if (options.gitMode) process.env.SCHEMA_IMPORT_GIT_MODE = options.gitMode;
  const urls = [...new Set([...options.urls, ...options.files.flatMap((file) => parseUrlList(readFileSync(file, "utf8")))])];

  const report: Report = { imported: [], skipped: [], failed: [], unresolved: [], notes: [], perUrl: [] };
  const payloads: Array<{ url: string; payload: NonNullable<Awaited<ReturnType<typeof fetchPayload>>> }> = [];
  for (const url of urls) {
    const payload = await fetchPayload(url, report);
    if (payload) payloads.push({ url, payload });
  }

  if (options.dryRun) {
    for (const { url, payload } of payloads) {
      for (const entity of payload.entities) report.imported.push(`entity ${entity.name}`);
      for (const sharedEnum of payload.sharedEnums) report.imported.push(`enum ${sharedEnum.name}`);
      for (const scalar of payload.customScalars) report.imported.push(`scalar ${scalar.name}`);
      for (const union of payload.unionTypes) report.imported.push(`union ${union.name}`);
      void url;
    }
    report.notes.push("dry run: nothing was written");
  } else {
    await persist(payloads, { domain: options.domain as string, product: options.product as string, user: options.user }, report);
    const { closeSharedPglite } = await import("@/lib/pglite-open");
    await closeSharedPglite();
  }

  if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ summary: summarizeReport(report), failed: report.failed, skipped: report.skipped.length, notes: report.notes }, null, 2));
  if (!options.report) console.log("(pass --report <file> for the full JSON report: imported, skipped, unresolved, per-URL counts)");
  return report.failed.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[import:git] failed:", error);
    process.exit(1);
  },
);
