import { vi } from "vitest";
import { REGISTRY_DELEGATES, type RegistryDelegateKey } from "@/services/name-registry.service";

type NamedRowFixture = { id: string; name: string; tenantId: string; domainId: string | null; productId: string | null };

/**
 * `findMany` delegates for every kind the line-unique name registry queries (entity, enum, scalar, union,
 * API, trait, event spec). Spread this into a hand-built Prisma mock so adding a registry
 * kind in name-registry.service.ts cannot silently break it; pass rows to simulate existing assets:
 *
 *   emptyRegistryDelegates({ eventSpec: [{ id: "s1", name: "orders", tenantId: "t", domainId: "d", productId: "p" }] })
 */
export function emptyRegistryDelegates(
  rows: Partial<Record<RegistryDelegateKey, NamedRowFixture[]>> = {}
): Record<RegistryDelegateKey, { findMany: ReturnType<typeof vi.fn> }> {
  const delegates = {} as Record<RegistryDelegateKey, { findMany: ReturnType<typeof vi.fn> }>;
  for (const key of Object.values(REGISTRY_DELEGATES)) {
    delegates[key] = { findMany: vi.fn().mockResolvedValue(rows[key] ?? []) };
  }
  return delegates;
}
