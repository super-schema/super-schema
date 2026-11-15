import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ pin: vi.fn(), document: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  pinJsonSchemaAction: h.pin, previewEventDocumentAction: h.document,
}));
import { POST } from "@/app/api/events/preview/route";

const request = (body: unknown) => new Request("http://localhost/api/events/preview", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => vi.resetAllMocks());

describe("event preview HTTP route", () => {
  it("keeps the existing pin-schema guard and result", async () => {
    const pin = { entityId: "entity", entityVersionId: "version" };
    const result = { success: true, data: { schema: { type: "object" } } };
    h.pin.mockResolvedValue(result);
    expect(await (await POST(request({ kind: "pin-schema", productId: "product", pin }))).json()).toEqual(result);
    expect(h.pin).toHaveBeenCalledWith("product", pin);
    expect(h.document).not.toHaveBeenCalled();
  });
  it("keeps the existing document-preview guard and forwards authorization refusals", async () => {
    const result = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
    h.document.mockResolvedValue(result);
    expect(await (await POST(request({ kind: "document", eventId: "event", productId: "product", document: {} }))).json()).toEqual(result);
    expect(h.document).toHaveBeenCalledWith("event", "product", {});
  });
  it("rejects invalid requests before calling the compiler", async () => {
    for (const body of [null, [], {}, { kind: "document", productId: "product" }, { kind: "unknown", productId: "product" }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    const malformed = new Request("http://localhost/api/events/preview", { method: "POST", body: "{" });
    expect((await POST(malformed)).status).toBe(400);
    expect(h.pin).not.toHaveBeenCalled();
    expect(h.document).not.toHaveBeenCalled();
  });
  it("bounds the request body before parsing or invoking the compiler", async () => {
    expect((await POST(request({ data: "a".repeat(1024 * 1024) }))).status).toBe(413);
    expect(h.pin).not.toHaveBeenCalled();
    expect(h.document).not.toHaveBeenCalled();
  });
});
