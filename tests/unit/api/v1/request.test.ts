import { describe, expect, it } from "vitest";
import { isUsableId, readJsonBody, unusableIdNotFound } from "@/app/api/v1/request";

const post = (body: BodyInit | null) => new Request("http://localhost/api/v1/webhooks", { method: "POST", body, headers: { "content-type": "application/json" } });

describe("readJsonBody", () => {
  it("hands back what the body holds, whatever its shape (the route validates it)", async () => {
    for (const value of [{ a: 1 }, [], null, "text", 42, true]) {
      expect(await readJsonBody(post(JSON.stringify(value)))).toEqual({ ok: true, body: value });
    }
  });

  it("answers a body that is empty, truncated or not JSON with a 400 VALIDATION_ERROR response instead of throwing", async () => {
    for (const text of ["", "{not json", '{"url": ', "undefined", "<xml/>", "{'a': 1}"]) {
      const result = await readJsonBody(post(text));
      expect(result.ok, JSON.stringify(text)).toBe(false);
      if (result.ok) continue;
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "The request body must be valid JSON",
          suggestedFix: "Send a JSON document as the body, with Content-Type: application/json.",
        },
      });
    }
  });

  it("a request with no body at all is not JSON either", async () => {
    const result = await readJsonBody(new Request("http://localhost/api/v1/webhooks", { method: "POST" }));
    expect(result.ok).toBe(false);
  });
});

describe("isUsableId", () => {
  it("accepts ids of any text that PostgreSQL can hold, and refuses a NUL byte anywhere in one, and an empty one", () => {
    for (const id of ["cmvnfn8qg0000faq3qybc1tl4", "a", "' OR 1=1 --", "é日本語", "../../etc/passwd", "a".repeat(5000)]) expect(isUsableId(id), id.slice(0, 20)).toBe(true);
    for (const id of ["", "\u0000", "ab\u0000cd", "\u0000abc", "abc\u0000"]) expect(isUsableId(id), JSON.stringify(id)).toBe(false);
  });
});

describe("unusableIdNotFound", () => {
  it("is the 404 each service gives for an unknown id, so the two cannot be told apart", async () => {
    const entity = unusableIdNotFound("entity", "x\u0000y");
    expect(entity.status).toBe(404);
    expect(await entity.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: 'Entity with ID "x\u0000y" not found', suggestedFix: "Verify the entity ID and try again." },
    });
    expect((await unusableIdNotFound("webhook", "w").json()).error.message).toBe('Webhook endpoint "w" not found');
    expect((await unusableIdNotFound("notification", "n").json()).error.message).toBe('Notification "n" not found');
    expect(await unusableIdNotFound("event-spec", "e").json()).toMatchObject({ error: { code: "NOT_FOUND", message: "Event spec not found", suggestedFix: "Check the event spec id." } });
  });
});
