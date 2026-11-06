import { describe, expect, it } from "vitest";
import type { ApiOperationRecord, ApiParameter } from "@/types/schemas/api-operation";
import {
  crudKey,
  crudOperations,
  draftWarnings,
  duplicateOperation,
  HTTP_STATUS_CODES,
  mergeWarnings,
  missingCrudOperations,
  moveId,
  nextStatusCode,
  syncPathParameters,
  typeOptionGroups,
  validateDraft,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/api-tab-model";

const rec = (over: Partial<ApiOperationRecord> = {}): ApiOperationRecord => ({
  id: "a", serviceId: "s", name: "getInvoice", summary: "", description: "", httpMethod: "GET", httpPath: "/invoices/{id}",
  tags: [], deprecated: false, requestBody: null, responses: [],
  parameters: [{ name: "id", type: "string", isArray: false, location: "path", required: true, description: "" }],
  ...over,
});
const p = (name: string, location: ApiParameter["location"] = "path", type = "string"): ApiParameter =>
  ({ name, type, isArray: false, location, required: location === "path", description: "" });

describe("syncPathParameters", () => {
  it("adds, keeps, renames in place and removes path parameters; other locations untouched", () => {
    const q = p("limit", "query", "int32");
    expect(syncPathParameters([q], "/x", "/x/{id}")).toEqual([p("id"), q]);
    const typed = p("id", "path", "uuid");
    expect(syncPathParameters([typed, q], "/x/{id}", "/x/{invoiceId}")).toEqual([{ ...typed, name: "invoiceId" }, q]);
    expect(syncPathParameters([typed, q], "/x/{id}", "/x")).toEqual([q]);
  });

  it("leaves parameters alone while the path is mid-edit", () => {
    const params = [p("id")];
    expect(syncPathParameters(params, "/x/{id}", "/x/{i")).toEqual(params);
    expect(syncPathParameters(params, "/x/{id}", "/x/{}")).toEqual(params);
    expect(syncPathParameters(params, "/x/{id}", "/x/{1a}")).toEqual(params);
  });
});

describe("validateDraft", () => {
  it("accepts a valid draft and reports contract + rule issues with server-style paths", () => {
    expect(validateDraft(rec())).toEqual([]);
    const issues = validateDraft(rec({ name: "bad name", httpPath: "invoices", responses: [{ statusCode: 99, type: null, isArray: false, contentType: "application/json", description: "" }] }));
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["httpPath", "responses.0.statusCode"]));
    expect(validateDraft(rec({ name: "bad name" })).map((i) => i.path)).toContain("name");
    expect(validateDraft(rec({ parameters: [] })).map((i) => i.path)).toContain("parameters");
  });

  it("flags a duplicate method + path template and a duplicate operationId among siblings", () => {
    const sibling = rec({ id: "b", name: "fetch", httpPath: "/invoices/{invoiceId}" });
    expect(validateDraft(rec(), [rec(), sibling]).map((i) => i.path)).toEqual(["httpPath"]);
    expect(validateDraft(rec({ httpMethod: "POST", httpPath: "/x", parameters: [] }), [rec({ id: "b" })]).map((i) => i.path)).toEqual(["name"]);
  });
});

describe("CRUD generation", () => {
  it("uses the key field for the id parameter when usable", () => {
    expect(crudKey([{ name: "invoiceId", type: "uuid", isKey: true }])).toEqual({ name: "invoiceId", type: "uuid" });
    expect(crudKey([{ name: "code", type: "Money", isKey: true }])).toEqual({ name: "code", type: "string" });
    expect(crudKey([{ name: "x", type: "string" }])).toEqual({ name: "id", type: "string" });
  });

  it("builds five valid operations and skips existing ones", () => {
    const crud = crudOperations("Invoice", { name: "id", type: "string" });
    expect(crud.map((o) => `${o.httpMethod} ${o.httpPath}`)).toEqual([
      "GET /invoices", "GET /invoices/{id}", "POST /invoices", "PUT /invoices/{id}", "DELETE /invoices/{id}",
    ]);
    for (const o of crud) expect(validateDraft({ ...o, id: o.name, serviceId: "s", responses: o.responses.map((r) => ({ ...r, type: r.type ?? null })) })).toEqual([]);
    const missing = missingCrudOperations([rec({ httpPath: "/invoices/{invoiceId}/" })], crud);
    expect(missing.map((o) => o.name)).toEqual(["listInvoices", "createInvoice", "updateInvoice", "deleteInvoice"]);
  });

  it("adopts the path spelling an existing operation uses for the same template (the server refuses a second spelling)", () => {
    const crud = crudOperations("Invoice", crudKey([{ name: "invoiceId", type: "uuid", isKey: true }]));
    const existing = [rec()]; // GET /invoices/{id}
    const missing = missingCrudOperations(existing, crud);
    const put = missing.find((o) => o.name === "updateInvoice")!;
    expect(put.httpPath).toBe("/invoices/{id}");
    expect(put.parameters.filter((p) => p.location === "path").map((p) => [p.name, p.type])).toEqual([["id", "uuid"]]);
    for (const op of missing) {
      expect(validateDraft({ ...op, id: op.name, serviceId: "s", responses: op.responses.map((r) => ({ ...r, type: r.type ?? null })) }, existing)).toEqual([]);
    }
  });
});

describe("helpers", () => {
  it("duplicates with a fresh name and path", () => {
    const a = rec();
    const copy = duplicateOperation(a, [a, rec({ id: "b", name: "getInvoiceCopy", httpPath: "/invoices/{id}/copy" })]);
    expect(copy).toMatchObject({ name: "getInvoiceCopy2", httpPath: "/invoices/{id}/copy2" });
    expect(copy.operationId).toBeUndefined();
  });

  it("moves ids, lists every status code, picks the next free status, groups types", () => {
    expect(moveId(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(HTTP_STATUS_CODES.length).toBeGreaterThan(60);
    expect(nextStatusCode([200, 201])).toBe(204);
    expect(typeOptionGroups("Invoice", ["Customer", "string", "Invoice", "Customer", " Line "]).others).toEqual(["Customer", "Line"]);
  });
});

describe("draftWarnings / mergeWarnings", () => {
  it("warns about an OPTIONS draft (stored, not generated) and nothing else", () => {
    expect(draftWarnings(rec())).toEqual([]);
    expect(draftWarnings(rec({ httpMethod: "OPTIONS" }))).toEqual([expect.stringMatching(/^OPTIONS operations are stored but left out/)]);
  });

  it("merges without duplicates and keeps the first list's reference when nothing is added", () => {
    const a = ["x"];
    expect(mergeWarnings(a, undefined)).toBe(a);
    expect(mergeWarnings(a, ["x"])).toBe(a);
    expect(mergeWarnings(a, ["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("validateDraft: one spelling per path template", () => {
  it("flags a path that names its parameters differently from a sibling on the same template (the server's rule)", () => {
    const update = rec({ id: "u", name: "updateInvoice", httpMethod: "PUT" });
    const renamed = rec({ httpPath: "/invoices/{invoiceId}", parameters: [p("invoiceId")] });
    expect(validateDraft(renamed, [update])).toEqual([
      { path: "httpPath", message: '/invoices/{invoiceId} names its path parameters differently from /invoices/{id} ("updateInvoice")' },
    ]);
    expect(validateDraft(rec(), [update])).toEqual([]);
    expect(validateDraft(rec({ httpPath: "/invoices/{id}/" }), [update])).toEqual([]);
  });
});
