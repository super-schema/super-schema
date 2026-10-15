import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAssertNameAvailable, mockTx, lockCalls } = vi.hoisted(() => ({
  mockAssertNameAvailable: vi.fn(),
  mockTx: { marker: "tx" },
  lockCalls: [] as string[],
}));

vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
  withTenantNameLock: async (_db: unknown, tenantId: string, fn: (tx: unknown) => unknown) => {
    lockCalls.push(tenantId);
    return fn(mockTx);
  },
}));

import { createInScope, writeWithUniqueName, ServiceErrorRejection } from "@/services/scoped-create.service";

const db = {
  domain: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "d1" ? { id: "d1", tenantId: "t1" } : null
    ),
  },
  product: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "p1" ? { id: "p1", domainId: "d1", domain: { tenantId: "t1" } } : null
    ),
  },
};

const PRODUCT_SCOPE = { tenantId: "t1", domainId: "d1", productId: "p1" };
const CONFLICT = { success: false, error: { code: "NAME_CONFLICT", message: "dup" } };
const DB_ERROR = { success: false, error: { code: "DB_ERROR", message: "connection lost" } };

describe("createInScope", () => {
  const write = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    lockCalls.length = 0;
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    write.mockResolvedValue({ id: "new-1" });
  });

  it("resolves scope, checks the name under the tenant lock, writes once and returns the write result", async () => {
    const result = await createInScope(db as never, {
      kind: "entity",
      target: { level: "PRODUCT", productId: "p1" },
      name: "Order",
      write,
    });

    expect(result).toEqual({ success: true, data: { id: "new-1" } });
    expect(lockCalls).toEqual(["t1"]);
    expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, { name: "Order", ...PRODUCT_SCOPE });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(mockTx, PRODUCT_SCOPE);
    expect(mockAssertNameAvailable.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });

  it("forwards exclude to the registry", async () => {
    await createInScope(db as never, {
      kind: "entity",
      target: { level: "PRODUCT", productId: "p1" },
      name: "Order",
      exclude: { kind: "entity", id: "e1" },
      write,
    });
    expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
      name: "Order",
      ...PRODUCT_SCOPE,
      exclude: { kind: "entity", id: "e1" },
    });
  });

  it("returns the scope error without locking, checking or writing", async () => {
    const result = await createInScope(db as never, {
      kind: "dataType",
      target: { level: "DOMAIN", domainId: "nope" },
      name: "Status",
      write,
    });

    expect(!result.success && result.error.code).toBe("NOT_FOUND");
    expect(lockCalls).toEqual([]);
    expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("returns the placement error (kind not allowed at this level) without locking or writing", async () => {
    const result = await createInScope(db as never, {
      kind: "entity",
      target: { level: "DOMAIN", domainId: "d1" },
      name: "Order",
      write,
    });

    expect(!result.success && result.error.code).toBe("INVALID_SCOPE");
    expect(lockCalls).toEqual([]);
    expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("runs a caller precondition after placement and before the lock", async () => {
    const precondition = vi.fn(() => ({
      success: false as const,
      error: { code: "INVALID_SCOPE", message: "wrong domain" },
    }));

    const result = await createInScope(db as never, {
      kind: "entity",
      target: { level: "PRODUCT", productId: "p1" },
      name: "Order",
      precondition,
      write,
    });

    expect(precondition).toHaveBeenCalledWith(PRODUCT_SCOPE);
    expect(result).toEqual({ success: false, error: { code: "INVALID_SCOPE", message: "wrong domain" } });
    expect(lockCalls).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns a name conflict without calling write", async () => {
    mockAssertNameAvailable.mockResolvedValue(CONFLICT);
    const result = await createInScope(db as never, {
      kind: "entity",
      target: { level: "PRODUCT", productId: "p1" },
      name: "Order",
      write,
    });

    expect(result).toEqual(CONFLICT);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns a registry DB_ERROR without calling write", async () => {
    mockAssertNameAvailable.mockResolvedValue(DB_ERROR);
    const result = await createInScope(db as never, {
      kind: "entity",
      target: { level: "PRODUCT", productId: "p1" },
      name: "Order",
      write,
    });

    expect(result).toEqual(DB_ERROR);
    expect(write).not.toHaveBeenCalled();
  });

  it("lets a throwing write propagate (so the transaction rolls back)", async () => {
    write.mockRejectedValue(new Error("boom"));
    await expect(
      createInScope(db as never, {
        kind: "entity",
        target: { level: "PRODUCT", productId: "p1" },
        name: "Order",
        write,
      })
    ).rejects.toThrow("boom");
  });
});

describe("writeWithUniqueName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockCalls.length = 0;
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
  });

  it("checks the name for an already-placed asset (rename) with exclude, then writes", async () => {
    const write = vi.fn().mockResolvedValue("renamed");
    const result = await writeWithUniqueName(db as never, {
      scope: PRODUCT_SCOPE,
      name: "Order2",
      exclude: { kind: "entity", id: "e1" },
      write,
    });

    expect(result).toEqual({ success: true, data: "renamed" });
    expect(lockCalls).toEqual(["t1"]);
    expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
      name: "Order2",
      ...PRODUCT_SCOPE,
      exclude: { kind: "entity", id: "e1" },
    });
    expect(write).toHaveBeenCalledWith(mockTx);
  });

  it("does not write when the registry rejects", async () => {
    mockAssertNameAvailable.mockResolvedValue(CONFLICT);
    const write = vi.fn();
    const result = await writeWithUniqueName(db as never, { scope: PRODUCT_SCOPE, name: "Order", write });
    expect(result).toEqual(CONFLICT);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("ServiceErrorRejection", () => {
  it("carries the ServiceError and uses its message", () => {
    const error = { code: "NAME_CONFLICT", message: "dup", suggestedFix: "rename" };
    const rejection = new ServiceErrorRejection(error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe("dup");
    expect(rejection.serviceError).toBe(error);
  });
});
