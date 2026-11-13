// C3 / C6: the bulk re-derivation re-reads the field rows under a row lock inside its transaction (an edit committed after the ids were
// read is never overwritten), runs every query of a batch on that transaction, and derives with the domain-resolved definitions.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; entityId: string; name: string; type: string; classification: string | null; decorators: Record<string, unknown>; entity: Record<string, unknown> };

const h = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    afterFirstRead: undefined as undefined | (() => void),
    log: [] as string[],
    defs: [] as Array<Record<string, unknown>>,
  };
  const fieldDelegate = (who: string) => ({
    findMany: vi.fn(async (args: { where?: { id?: { in: string[] } }; select?: Record<string, unknown> }) => {
      state.log.push(`${who}.field.findMany`);
      const picked = args.where?.id ? state.rows.filter((r) => args.where!.id!.in.includes(r.id)) : state.rows;
      const out = structuredClone(picked);
      const hook = state.afterFirstRead;
      state.afterFirstRead = undefined;
      hook?.();
      return out;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: { decorators: Record<string, unknown> } }) => {
      state.log.push(`${who}.field.update`);
      const row = state.rows.find((r) => r.id === args.where.id)!;
      row.decorators = args.data.decorators;
      return row;
    }),
  });
  const dictionary = (who: string) => ({
    metadataAttributeDefinition: { findMany: vi.fn(async () => { state.log.push(`${who}.defs`); return state.defs; }) },
    classificationLevel: { findMany: vi.fn(async () => { state.log.push(`${who}.levels`); return []; }) },
  });
  const tx = {
    ...dictionary("tx"),
    field: fieldDelegate("tx"),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => { state.log.push(`tx.$queryRaw ${strings.join("?")}`); return []; }),
    $executeRawUnsafe: vi.fn(async () => { state.log.push("tx.mark"); return 1; }),
  };
  const prisma = {
    ...dictionary("prisma"),
    field: fieldDelegate("prisma"),
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { state, tx, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

import { rederiveTenant } from "@/services/metadata-rederive.service";

const KEY = "x-securityClassification";
const ext = (v: Record<string, unknown>) => ({ typespec: { extensions: { openapi: { [KEY]: v } } } });
const defRow = (over: Record<string, unknown> = {}) => ({
  id: "d1", tenantId: "t1", key: KEY, label: "S", description: "", targets: ["field"], scope: "schema", placement: "abc-primitive",
  valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
  derive: { data_class: "class{class}" }, requiredWhen: "primitive", pack: null, protobufOptionNumber: 50000, createdAt: new Date(), updatedAt: new Date(),
  ...over,
});
const entityIn = (domainId: string, policyTemplate: unknown = null) => ({ tenantId: "t1", domainId, domain: { id: domainId, policyTemplate }, product: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.state.log = [];
  h.state.defs = [defRow()];
  h.state.afterFirstRead = undefined;
});

describe("rederiveTenant (C3: rows locked and re-read inside the transaction)", () => {
  it("keeps an edit committed after the field ids were read", async () => {
    h.state.rows = [{ id: "f1", entityId: "e1", name: "email", type: "string", classification: "PII", decorators: ext({ data_class: "class3", data_category: "ConsumerPersonal" }), entity: entityIn("dA") }];
    // A concurrent save lands between the first read and the write: PUBLIC, a new category, another attribute.
    h.state.afterFirstRead = () => {
      h.state.rows[0].classification = "PUBLIC";
      h.state.rows[0].decorators = { typespec: { extensions: { openapi: { [KEY]: { data_class: "class5", data_category: "Intrinsic" }, "x-other": 1 } } } };
    };
    await rederiveTenant("t1");
    const after = h.state.rows[0].decorators as { typespec: { extensions: { openapi: Record<string, unknown> } } };
    expect(after.typespec.extensions.openapi["x-other"]).toBe(1);
    expect(after.typespec.extensions.openapi[KEY]).toEqual({ data_class: "class5", data_category: "Intrinsic" });
  });

  it("locks the rows FOR UPDATE and runs every read and write of the batch on the transaction", async () => {
    h.state.rows = [{ id: "f1", entityId: "e1", name: "email", type: "string", classification: "PII", decorators: ext({ data_class: "class3" }), entity: entityIn("dA") }];
    await rederiveTenant("t1");
    const lock = h.state.log.findIndex((l) => l.startsWith("tx.$queryRaw") && l.includes("FOR UPDATE"));
    expect(lock).toBeGreaterThanOrEqual(0);
    const after = h.state.log.slice(lock + 1);
    expect(after).toEqual(expect.arrayContaining(["tx.field.findMany", "tx.defs", "tx.levels", "tx.field.update", "tx.mark"]));
    expect(after.some((l) => l.startsWith("prisma."))).toBe(false);
    expect((h.state.rows[0].decorators as ReturnType<typeof ext>).typespec.extensions.openapi[KEY]).toEqual({ data_class: "class2" });
  });
});

describe("rederiveTenant (C6: domain-resolved definitions)", () => {
  it("applies a domain's requiredWhen override, resolved per domain", async () => {
    h.state.defs = [defRow({ requiredWhen: "never" })];
    const strict = { metadataAttributes: { [KEY]: { requiredWhen: "primitive" } } };
    h.state.rows = [
      { id: "f1", entityId: "e1", name: "a", type: "string", classification: "PII", decorators: {}, entity: entityIn("dStrict", strict) },
      { id: "f2", entityId: "e2", name: "b", type: "string", classification: "PII", decorators: {}, entity: entityIn("dLoose") },
      { id: "f3", entityId: "e3", name: "c", type: "string", classification: "PUBLIC", decorators: {}, entity: entityIn("dStrict", strict) },
    ];
    await rederiveTenant("t1");
    const value = (i: number) => (h.state.rows[i].decorators as Partial<ReturnType<typeof ext>>).typespec?.extensions.openapi[KEY];
    expect(value(0)).toEqual({ data_class: "class2" });
    expect(value(1)).toBeUndefined();
    expect(value(2)).toEqual({ data_class: "class5" });
  });
});
