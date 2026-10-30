/**
 * The quick "is this loadable?" answer for pasted schema text: the same detection and parsing the wizard runs on
 * Review & Import, so a green answer means the import will get past parsing. TypeSpec / OpenAPI are compiled by server
 * actions on import: here they are only recognised (`deferred`), never compiled per keystroke.
 */

import type { ImportFormat } from "@/lib/importers/types";

export type SchemaTextCheck =
  | { status: "empty" }
  | { status: "valid"; format: ImportFormat; summary: string; warnings: number; deferred: boolean }
  | { status: "invalid"; message: string };

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  avro: "Avro",
  "bigquery-ddl": "BigQuery DDL",
  protobuf: "Protobuf",
  typespec: "TypeSpec",
  "json-schema": "JSON Schema",
  openapi: "OpenAPI",
};

/** What the wizard says, on Review, to a document that needs a domain when it is importing at the Enterprise level (no product). */
export const NEEDS_DOMAIN_MESSAGE =
  "TypeSpec and OpenAPI documents can define several assets and need a domain. Import this one from a domain or product page.";

export function multiAssetNeedsProductMessage(assets: { models: { name: string }[]; sharedEnums: unknown[]; customScalars: unknown[] }): string {
  const count = assets.models.length + assets.sharedEnums.length + assets.customScalars.length;
  return `Multi-entity imports go into a product — at Enterprise level an import creates one entity. This schema defines ${count} assets (${assets.models.map((m) => m.name).join(", ")}).`;
}

const UNDETECTED = "Could not detect the schema format. Expected Avro, BigQuery DDL, Protobuf, JSON Schema, OpenAPI or TypeSpec.";

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

export interface CheckOptions {
  /** False at the Enterprise level (no product): a document with several assets, or TypeSpec / OpenAPI, cannot be imported there. Default true. */
  allowMultiAsset?: boolean;
}

export async function checkSchemaText(text: string, { allowMultiAsset = true }: CheckOptions = {}): Promise<SchemaTextCheck> {
  if (text.trim() === "") return { status: "empty" };
  try {
    // Loaded on demand: the detector pulls in `yaml` and the importers `protobufjs`, which stay out of the wizard chunk.
    const [{ detectFormatDetailed }, { importSchemaAssets }] = await Promise.all([
      import("@/lib/importers/format-detector"),
      import("@/services/import.service"),
    ]);
    const { format, reason } = detectFormatDetailed(text);
    if (!format) return { status: "invalid", message: reason ? `${reason}.` : UNDETECTED };
    if (format === "typespec" || format === "openapi") {
      if (!allowMultiAsset) return { status: "invalid", message: NEEDS_DOMAIN_MESSAGE };
      return { status: "valid", format, summary: `${FORMAT_LABELS[format]} document, compiled when you review`, warnings: 0, deferred: true };
    }
    const result = importSchemaAssets(text, format);
    if (!result.success) return { status: "invalid", message: result.error.message };
    if (result.data.kind === "multi") {
      const assets = result.data.result;
      if (!allowMultiAsset) return { status: "invalid", message: multiAssetNeedsProductMessage(assets) };
      const parts = [plural(assets.models.length, "entity", "entities")];
      if (assets.sharedEnums.length) parts.push(plural(assets.sharedEnums.length, "enum"));
      if (assets.customScalars.length) parts.push(plural(assets.customScalars.length, "scalar"));
      return { status: "valid", format, summary: `${FORMAT_LABELS[format]}, ${parts.join(", ")}`, warnings: assets.warnings.length, deferred: false };
    }
    const { parsedEntity, warnings } = result.data.result;
    return {
      status: "valid",
      format,
      summary: `${FORMAT_LABELS[format]}, entity ${parsedEntity.name} with ${plural(parsedEntity.fields.length, "field")}`,
      warnings: warnings.length,
      deferred: false,
    };
  } catch (e) {
    return { status: "invalid", message: e instanceof Error ? e.message : "Could not read the schema." };
  }
}
