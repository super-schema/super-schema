import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emptyRegistryDelegates } from "../../../helpers/registry-mocks";

const h = vi.hoisted(() => ({ withAudit: vi.fn(), loadDraftSnapshot: vi.fn(), resolveSnapshot: vi.fn(), emitResolved: vi.fn() }));
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: h.withAudit, AuditUserMissingError };
});
// The draft snapshot, rendering and emission are covered by the integration test; here only the publish transaction's error mapping matters.
vi.mock("@/services/events/event-spec-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/events/event-spec-resolver")>();
  return { ...actual, loadDraftSnapshot: h.loadDraftSnapshot, resolveSnapshot: h.resolveSnapshot };
});
vi.mock("@/services/events/event-spec-emit.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/events/event-spec-emit.service")>();
  return { ...actual, emitResolved: h.emitResolved };
});

import { publishEventSpec } from "@/services/events/event-spec-publish.service";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { ServiceContext } from "@/types/service-context";

const SNAPSHOT = {
  spec: { id: "s1", name: "checkout-service", specType: "asyncapi@3.0", tenantId: "t1", domainId: "d1", productId: "p1", productSlug: "checkout", updatedAt: new Date(0), hasUnpublishedChanges: true, latestVersionId: null },
  document: { info: { title: "Checkout" }, servers: [], operations: [] },
  latest: null,
  channels: [],
  traits: [],
  messages: [],
  messageVersionInfo: {},
  unresolved: [],
};

function makeDb() {
  const db = {
    ...emptyRegistryDelegates(),
    product: { findUnique: vi.fn().mockResolvedValue({ id: "p1", domainId: "d1", domain: { tenantId: "t1" } }) },
    eventSpec: { ...emptyRegistryDelegates().eventSpec, findUnique: vi.fn().mockResolvedValue({ tenantId: "t1", domainId: "d1", productId: "p1" }), update: vi.fn() },
    messageVersion: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpecVersion: { create: vi.fn() },
    schemaReference: { deleteMany: vi.fn(), createMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "s1" }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}
type Db = ReturnType<typeof makeDb>;
const publish = (db: Db) =>
  publishEventSpec("s1", "p1", {}, { userId: "u1", userRole: "AUTHOR", prisma: db } as unknown as ServiceContext, { renderer: { render: vi.fn() } as never });

const CONFLICT = {
  success: false,
  error: { code: "CONFLICT", message: "The event spec changed while publishing.", suggestedFix: "Reload the event spec and publish again." },
};
const prismaError = (code: string, meta?: object) => Object.assign(new Error(`prisma ${code}`), { code, ...(meta && { meta }) });
const rawQueryError = (sqlState: string) => prismaError("P2010", { driverAdapterError: { cause: { originalCode: sqlState, originalMessage: "x", kind: "postgres" } } });

beforeEach(() => {
  vi.clearAllMocks();
  h.withAudit.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
  h.loadDraftSnapshot.mockResolvedValue({ success: true, data: SNAPSHOT });
  h.resolveSnapshot.mockResolvedValue({ resolved: { name: "resolved" }, diagnostics: [] });
  h.emitResolved.mockResolvedValue({ success: true, data: { document: { asyncapi: "3.0.0" }, json: "{}", yaml: "", diagnostics: [] } });
});

describe("publishEventSpec: failures raised inside the publish transaction (stubbed errors)", () => {
  it("publishes when nothing fails (the harness reaches the version insert)", async () => {
    const db = makeDb();
    db.eventSpecVersion.create.mockResolvedValue({ id: "esv1", major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedAt: new Date(0), publishedBy: { name: "Ada" } });
    db.eventSpec.update.mockResolvedValue({ id: "s1" });
    db.schemaReference.createMany.mockResolvedValue({ count: 0 });
    expect(await publish(db)).toMatchObject({ success: true, data: { id: "esv1", label: "1.0" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["P2002 unique version label / sequence", () => prismaError("P2002")],
    ["P2003 FK to a removed row", () => prismaError("P2003")],
    ["P2034 write conflict / deadlock", () => prismaError("P2034")],
    ["P2028 expired / timed-out transaction", () => prismaError("P2028", { operation: "commit", timeout: 15_000, timeTaken: 20_000 })],
    ["P2010 / 40P01 deadlock_detected on a raw lock statement", () => rawQueryError("40P01")],
    ["P2010 / 55P03 lock_not_available on a raw lock statement", () => rawQueryError("55P03")],
    ["P2010 / 40001 serialization_failure on a raw lock statement", () => rawQueryError("40001")],
  ])("maps %s to the retryable CONFLICT, at the lock, at the version insert and from $transaction itself", async (_label, failure) => {
    const atLock = makeDb();
    atLock.$queryRaw.mockRejectedValueOnce(failure());
    expect(await publish(atLock)).toEqual(CONFLICT);
    expect(atLock.eventSpecVersion.create).not.toHaveBeenCalled();

    const atWrite = makeDb();
    atWrite.eventSpecVersion.create.mockRejectedValueOnce(failure());
    expect(await publish(atWrite)).toEqual(CONFLICT);
    expect(atWrite.eventSpec.update).not.toHaveBeenCalled();

    const atTransaction = makeDb();
    atTransaction.$transaction.mockRejectedValueOnce(failure());
    expect(await publish(atTransaction)).toEqual(CONFLICT);
    expect(atTransaction.eventSpecVersion.create).not.toHaveBeenCalled();
  });

  describe("any other database failure", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => consoleError.mockRestore());

    it("stays a DB_ERROR with the generic message (P2010 with another SQLSTATE, P2024, a plain driver error); the raw text is only logged", async () => {
      for (const failure of [rawQueryError("42P01"), prismaError("P2024"), new Error('relation "event_spec_versions" does not exist (10.0.0.5)')]) {
        const db = makeDb();
        db.$queryRaw.mockRejectedValueOnce(failure);
        const r = await publish(db);
        expect(r).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
        expect(JSON.stringify(r)).not.toMatch(/event_spec_versions|10\.0\.0\.5/);
        expect(consoleError).toHaveBeenCalledWith("[auditedWrite PUBLISH_VERSION EventSpec s1] database error", failure);
        expect(db.eventSpecVersion.create).not.toHaveBeenCalled();
      }
    });
  });
});
