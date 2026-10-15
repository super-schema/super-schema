// src/services/events/schema-references.ts
import type { Prisma, SchemaReferenceFromKind, SchemaReferenceRole, SchemaReferenceToKind } from "@/generated/prisma/client";
import type { PinRole } from "@/lib/events/types";

type Tx = Prisma.TransactionClient;

export interface ReferenceEdge {
  role: SchemaReferenceRole;
  toKind: SchemaReferenceToKind;
  toId: string;
}

const ROLE: Record<PinRole, SchemaReferenceRole> = { payload: "PAYLOAD", headers: "HEADERS", key: "KEY" };

/** Edges for pinned entity versions (unpinned roles produce no edge). */
export function pinEdges(pins: Partial<Record<PinRole, string | null>>): ReferenceEdge[] {
  return (Object.entries(pins) as Array<[PinRole, string | null | undefined]>)
    .filter((entry): entry is [PinRole, string] => typeof entry[1] === "string")
    .map(([role, toId]) => ({ role: ROLE[role], toKind: "ENTITY_VERSION" as const, toId }));
}

/** D2: rewrite every edge from one record in the caller's transaction. */
export async function replaceReferences(
  tx: Tx,
  from: { kind: SchemaReferenceFromKind; id: string },
  edges: ReferenceEdge[],
  isDraft: boolean
): Promise<void> {
  await tx.schemaReference.deleteMany({ where: { fromKind: from.kind, fromId: from.id } });
  if (edges.length === 0) return;
  await tx.schemaReference.createMany({
    data: edges.map((e) => ({ fromKind: from.kind, fromId: from.id, role: e.role, toKind: e.toKind, toId: e.toId, isDraft })),
    skipDuplicates: true,
  });
}

export async function deleteReferencesFrom(tx: Tx, kind: SchemaReferenceFromKind, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.schemaReference.deleteMany({ where: { fromKind: kind, fromId: { in: ids } } });
}
