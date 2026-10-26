// @vitest-environment node
/**
 * `setUserDisabled`'s last-administrator guard, and its retry when the database aborts a transaction that lost a race, on a mocked transaction (the rules
 * on real SQL are in tests/integration/db/user-lifecycle-pglite.test.ts). The guard is belt and braces behind "an actor is an enabled administrator
 * and nobody disables themselves": it asks the database whether another ENABLED platform administrator remains, and refuses when none does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rolesOf: {} as Record<string, Array<{ role: string; scopeKey: string; tenantId: string | null; domainId?: string | null; productId?: string | null }>>,
  disabled: new Set<string>(),
  others: { count: 1 },
  audit: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => {
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id in h.rolesOf ? { id: where.id, disabledAt: h.disabled.has(where.id) ? new Date() : null, roles: h.rolesOf[where.id] } : null
      ),
      update: vi.fn(async (args: Record<string, unknown>) => {
        h.updates.push(args);
        return {};
      }),
    },
    userRole: { count: vi.fn(async () => h.others.count) },
    authToken: { count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({ count: 0 })) },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.audit.push(data);
        return {};
      }),
    },
  };
  return { prisma: { ...tx, $transaction: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)) } };
});

import { prisma } from "@/lib/db";
import { setUserDisabled } from "@/services/user.service";
import type { ServiceContext } from "@/types/service-context";

const ctx = (userId: string): ServiceContext => ({ userId, userRole: "VIEWER", prisma: prisma as never });
const GLOBAL_ADMIN = { role: "ADMIN", scopeKey: "G", tenantId: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.rolesOf = { actor: [GLOBAL_ADMIN], other: [GLOBAL_ADMIN], plain: [{ role: "VIEWER", scopeKey: "T:t1", tenantId: "t1" }] };
  h.disabled = new Set();
  h.others = { count: 1 };
  h.audit = [];
  h.updates = [];
});

describe("setUserDisabled: the last enabled platform administrator", () => {
  it("is not disabled when the database says no other enabled administrator remains; nothing is written", async () => {
    h.others.count = 0;
    const result = await setUserDisabled("other", true, ctx("actor"));
    expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN", message: expect.stringContaining("last platform administrator") } });
    expect(h.updates).toEqual([]);
    expect(h.audit).toEqual([]);
    // The question names the enabled platform administrators other than the target.
    expect(vi.mocked(prisma.userRole.count)).toHaveBeenLastCalledWith({ where: { role: "ADMIN", scopeKey: "G", userId: { not: "other" }, user: { disabledAt: null } } });
  });

  it("is disabled when another enabled administrator remains", async () => {
    expect((await setUserDisabled("other", true, ctx("actor"))).success).toBe(true);
    expect(h.updates).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
  });

  it("the question is only asked about a platform administrator (a plain user needs no such answer)", async () => {
    h.others.count = 0;
    expect((await setUserDisabled("plain", true, ctx("actor"))).success).toBe(true);
    expect(vi.mocked(prisma.userRole.count)).not.toHaveBeenCalled();
  });

  it("enabling one needs no such answer either", async () => {
    h.others.count = 0;
    h.disabled.add("other");
    expect(await setUserDisabled("other", false, ctx("actor"))).toMatchObject({ success: true, data: { changed: true } });
  });
});

describe("setUserDisabled: a transaction the database aborts for losing a race is run again", () => {
  it("one lost round: the change is made once, with one entry; the work of the aborted round left nothing behind", async () => {
    let rounds = 0;
    const real = vi.mocked(prisma.$transaction).getMockImplementation()!;
    vi.mocked(prisma.$transaction).mockImplementation((async (work: never, options: never) => {
      if (++rounds === 1) throw Object.assign(new Error("write conflict"), { code: "P2034" });
      return real(work, options);
    }) as never);
    expect((await setUserDisabled("plain", true, ctx("actor"))).success).toBe(true);
    expect(rounds).toBe(2);
    expect(h.updates).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
    vi.mocked(prisma.$transaction).mockImplementation(real);
  });

  it("a transaction that loses every round is a CONFLICT answer, not a thrown error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = vi.mocked(prisma.$transaction).getMockImplementation()!;
    vi.mocked(prisma.$transaction).mockRejectedValue(Object.assign(new Error("write conflict"), { code: "P2034" }));
    expect(await setUserDisabled("plain", true, ctx("actor"))).toMatchObject({ success: false, error: { code: "CONFLICT" } });
    expect(h.updates).toEqual([]);
    vi.mocked(prisma.$transaction).mockImplementation(real);
  });

  it("runs the decision in a SERIALIZABLE transaction", async () => {
    await setUserDisabled("plain", true, ctx("actor"));
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });
});
