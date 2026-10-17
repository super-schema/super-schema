"use client";

// src/features/events/builder/use-pin-json-schema.ts
// The JSON Schema of the entity a message pins, for the examples of that message (the editor checks an example against it and
// "Generate from payload" builds one from it). It asks the server (`pinJsonSchemaAction`, which runs the TypeSpec compiler), so:
//   - nothing is asked unless `enabled` (the examples are on screen), and never for a pin without an entity;
//   - the answer belongs to ONE pin (`entityId:entityVersionId`): when the pin changes the previous pin's schema is gone at once,
//     in the very render that sees the new pin, and an answer that arrives for a pin the message has moved on from is dropped;
//   - a failed load leaves no schema at all, and is not asked again until the pin changes;
//   - a published version never changes, so its schema is kept for the page session; an unpinned entity (its current draft) is
//     asked for again whenever it is needed.
// The action is imported when first needed (`externalRefActions`), so a builder that never shows an example never loads it.
import { useEffect, useState } from "react";
import type { EntityPin } from "@/lib/events/types";
import { externalRefActions } from "./use-external-ref-status";

type Schema = Record<string, unknown>;

/** Schemas of published versions by `productId` + pin; the oldest are dropped past this many (a schema can be 500 KB). */
const MAX_KEPT = 24;
const versionSchemas = new Map<string, Schema>();

function keep(slot: string, schema: Schema): void {
  versionSchemas.delete(slot);
  versionSchemas.set(slot, schema);
  while (versionSchemas.size > MAX_KEPT) versionSchemas.delete(versionSchemas.keys().next().value as string);
}

/** Forgets every kept schema. Tests only: the cache lives as long as the page. */
export function resetPinSchemaCache(): void {
  versionSchemas.clear();
}

/**
 * The schema of `pin`, or `null` while it is loading, when it could not be loaded, when `pin` is absent / has no entity, and while
 * `enabled` is false. `productId` is the product the user works in (the action checks it against the active tenant).
 */
export function usePinJsonSchema(productId: string, pin: EntityPin | null | undefined, enabled = true): Schema | null {
  return usePinJsonSchemaState(productId, pin, enabled).schema;
}

/**
 * `usePinJsonSchema` that also says whether the answer is still on its way: `loading` is true from the render that wants a schema until
 * it has arrived or failed (a schema render takes seconds), and false when none is wanted, when it is there, and after a failure.
 */
export function usePinJsonSchemaState(
  productId: string, pin: EntityPin | null | undefined, enabled = true,
): { schema: Schema | null; loading: boolean } {
  const entityId = pin?.entityId ?? "";
  const versionId = pin?.entityVersionId ?? null;
  const wanted = enabled && entityId !== "";
  const slot = `${productId}\n${entityId}\n${versionId ?? ""}`;
  const kept = wanted && versionId !== null ? versionSchemas.get(slot) : undefined;
  const [answer, setAnswer] = useState<{ slot: string; schema: Schema | null } | null>(null);

  useEffect(() => {
    if (!wanted || kept !== undefined) return undefined;
    let cancelled = false;
    void (async () => {
      let schema: Schema | null = null;
      try {
        const actions = await externalRefActions();
        const result = await actions.pinJsonSchemaAction(productId, { entityId, entityVersionId: versionId });
        if (result.success) schema = result.data.schema;
      } catch {
        // no schema: the example is simply not checked
      }
      if (schema !== null && versionId !== null) keep(slot, schema);
      if (!cancelled) setAnswer({ slot, schema });
    })();
    return () => { cancelled = true; };
  }, [wanted, kept, productId, entityId, versionId, slot]);

  if (!wanted) return { schema: null, loading: false };
  if (kept !== undefined) return { schema: kept, loading: false };
  if (answer !== null && answer.slot === slot) return { schema: answer.schema, loading: false };
  return { schema: null, loading: true };
}
