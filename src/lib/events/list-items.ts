// src/lib/events/list-items.ts
import { isJsonObject } from "./inputs";
import type { TraitKind, TraitListItem } from "./types";

function summaryOf(spec: { summary?: unknown; description?: unknown }): string {
  const text = typeof spec.summary === "string" && spec.summary ? spec.summary : typeof spec.description === "string" ? spec.description : "";
  return text.slice(0, 200);
}

export function traitListItem(row: { id: string; name: string; kind: string; spec: unknown; updatedAt: Date }): TraitListItem {
  return {
    id: row.id, name: row.name, kind: row.kind as TraitKind,
    summary: summaryOf(isJsonObject(row.spec) ? row.spec : {}), updatedAt: row.updatedAt.toISOString(),
  };
}
