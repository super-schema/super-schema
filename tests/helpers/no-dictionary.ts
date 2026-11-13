/**
 * A tenant with no dictionary, for a test that hand-builds its prisma / transaction mock. The branch's services read the tenant's
 * attribute definitions, classification levels and counters on the field-write, import, emission and alert paths; a mock that knows
 * none of those tables throws "Cannot read properties of undefined (reading 'findMany')".
 *
 *   const tx = withNoDictionary({ entity: { create }, auditLog: { create } }) as unknown as Prisma.TransactionClient;
 *
 * Tables the caller already mocks are kept (a test that wants a dictionary passes its own); only the missing ones are filled in.
 */
import { vi } from "vitest";

/** The dictionary tables of an empty tenant: no definitions, no levels, no counters. */
export function noDictionaryTables() {
  return {
    metadataAttributeDefinition: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    classificationLevel: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    metadataAttributeCounter: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
  };
}

/** `mock` completed with the dictionary tables it lacks (a new object; `mock` itself is not touched). */
export function withNoDictionary<T extends object>(mock: T): T & ReturnType<typeof noDictionaryTables> {
  return { ...noDictionaryTables(), ...mock };
}
