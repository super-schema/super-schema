import { afterEach, describe, expect, it, vi } from "vitest";
import { requestEventPreview, requestPinJsonSchema } from "@/features/events/preview-requests";
import { emptyEventDocument } from "@/lib/events/document/types";

afterEach(() => vi.unstubAllGlobals());

describe("event preview requests", () => {
  it("sends compiler reads over HTTP with a bounded lifetime", async () => {
    const result = { success: true, data: { schema: { type: "object" } } };
    const fetcher = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetcher);
    const pin = { entityId: "entity", entityVersionId: "version" };
    expect(await requestPinJsonSchema("product", pin)).toEqual(result);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/events/preview");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ kind: "pin-schema", productId: "product", pin });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("starts another read without waiting for a pending compiler request", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(Response.json({ success: false, code: "NOT_FOUND", error: "Missing" }));
    vi.stubGlobal("fetch", fetcher);
    const pin = requestPinJsonSchema("product", { entityId: "entity", entityVersionId: "version" });
    const document = emptyEventDocument("Event");
    const preview = await requestEventPreview("event", "product", document);
    expect(preview).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ kind: "document", eventId: "event", productId: "product", document });
    finish(Response.json({ success: true, data: { schema: {} } }));
    await pin;
  });
  it("rejects failed HTTP responses and malformed data for the hook to handle", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("Unavailable", { status: 503 })).mockResolvedValueOnce(Response.json({ unexpected: true }));
    vi.stubGlobal("fetch", fetcher);
    const pin = { entityId: "entity", entityVersionId: null };
    await expect(requestPinJsonSchema("product", pin)).rejects.toThrow("Preview request failed");
    await expect(requestPinJsonSchema("product", pin)).rejects.toThrow("Invalid preview response");
  });
});
