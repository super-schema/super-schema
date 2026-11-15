import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  classificationLevel: { findMany: vi.fn() },
  customScalar: { findMany: vi.fn() },
  sharedEnum: { findMany: vi.fn() },
  unionType: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
import { dictionaryFormOptions } from "@/services/field-dictionary.service";

beforeEach(() => vi.clearAllMocks());

it("offers tenant-scoped unions alongside enums and scalars, sorted and deduplicated", async () => {
  db.classificationLevel.findMany.mockResolvedValue([]);
  db.customScalar.findMany.mockResolvedValue([{ name: "Money" }]);
  db.sharedEnum.findMany.mockResolvedValue([{ name: "Status" }]);
  db.unionType.findMany.mockResolvedValue([{ name: "Either" }, { name: "Money" }]);
  expect((await dictionaryFormOptions("tenant-a")).customTypes).toEqual(["Either", "Money", "Status"]);
  for (const table of [db.customScalar, db.sharedEnum, db.unionType]) {
    expect(table.findMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-a" }, select: { name: true } });
  }
});
