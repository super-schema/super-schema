/**
 * An in-memory tenant for the corpus: the few reads `loadReferenceClosure` makes (the tenant's entity index, a member's metadata, a
 * field list, one entity version), answered from the entities of a built case. The corpus therefore generates a reference closure the way
 * the app does (the REAL resolver walks the REAL reference fields), without a database.
 *
 * Only what the resolver selects is returned, like Prisma: the tenant index never carries `metadata` (it can hold every stored schema
 * version), a member's metadata is a read of its own.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { BuiltMember } from "./build-rows";

/** The one tenant of the corpus. */
export const CORPUS_TENANT = "corpus-tenant";

const idOf = (domain: string | undefined, tag: string): string | null => (domain === undefined ? null : `${tag}-${domain}`);

type VersionRow = { id: string; entityId: string; major: number; minor: number; sequence: number; fieldSnapshot: unknown[] };

function versionRows(member: BuiltMember): VersionRow[] {
  return member.published.map((p, index) => {
    const [major, minor] = p.version.split(".").map(Number);
    return { id: `${member.entity.id}-v${p.version}`, entityId: member.entity.id, major, minor, sequence: index + 1, fieldSnapshot: p.fields };
  });
}

/** The client `loadReferenceClosure` takes, over `members` (the case's own entity and everything else of its tenant). */
export function createMemoryDb(members: readonly BuiltMember[]): PrismaClient {
  const versions = members.flatMap(versionRows);
  const db = {
    entity: {
      findMany: async (args: { where: { tenantId: string } }) =>
        args.where.tenantId !== CORPUS_TENANT
          ? []
          : members.map((m) => ({
              id: m.entity.id,
              name: m.entity.name,
              description: m.entity.description,
              status: m.entity.status,
              version: m.entity.version,
              domainId: idOf(m.place.domain, "d"),
              latestVersionId: versionRows(m).at(-1)?.id ?? null,
              domain: m.place.domain === undefined ? null : { id: idOf(m.place.domain, "d"), name: m.place.domain, slug: m.place.domain.toLowerCase() },
              product: m.place.product === undefined ? null : { name: m.place.product },
            })),
      findUnique: async (args: { where: { id: string } }) => {
        const member = members.find((m) => m.entity.id === args.where.id);
        return member ? { metadata: member.entity.metadata ?? null } : null;
      },
    },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) => members.find((m) => m.entity.id === where.entityId)?.fields ?? [],
    },
    entityVersion: {
      findUnique: async ({ where }: { where: { id?: string; entityId_major_minor?: { entityId: string; major: number; minor: number } } }) => {
        if (where.id) return versions.find((v) => v.id === where.id) ?? null;
        const key = where.entityId_major_minor;
        return key ? (versions.find((v) => v.entityId === key.entityId && v.major === key.major && v.minor === key.minor) ?? null) : null;
      },
    },
  };
  return db as unknown as PrismaClient;
}
