import { describe, expect, it } from "vitest";
import { isUsableId, optionalParam, queryProblem, readJsonBody, unusableIdNotFound } from "@/app/api/v1/request";

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

describe("optionalParam: an empty value is no value", () => {
  const url = (query: string) => new URL(`http://localhost/api/v1/x?${query}`);

  it("is the value when there is one, and undefined when the parameter is missing or empty (every optional filter: ?status= is no status)", () => {
    expect(optionalParam(url("status=ACTIVE"), "status")).toBe("ACTIVE");
    expect(optionalParam(url("status="), "status")).toBeUndefined();
    expect(optionalParam(url("status"), "status")).toBeUndefined();
    expect(optionalParam(url("other=1"), "status")).toBeUndefined();
    expect(optionalParam(url("search=%20"), "search")).toBe(" "); // a space is a value: the caller decides
  });
});

describe("queryProblem: a NUL byte in a query name or value", () => {
  const url = (query: string) => new URL(`http://localhost/api/v1/x?${query}`);

  it("is a 400 VALIDATION_ERROR naming the parameter (PostgreSQL text holds no NUL byte: the lookup would throw)", async () => {
    for (const query of ["search=%00", "domain=a%00b", "status=ACTIVE%00", "types=%00", "id=%00", "a=1&b=%00", "%00=1", "x%00y=1"]) {
      const response = queryProblem(url(query));
      expect(response, query).not.toBeNull();
      expect(response?.status).toBe(400);
      const body = await response!.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toMatch(/NUL|null byte|\\u0000/i);
      expect(JSON.stringify(body)).not.toContain("\u0000");
    }
  });

  it("is null for anything else, hostile text included", () => {
    for (const query of ["", "search=%27%20OR%201%3D1%20--", "search=%25", "search=%C3%A9", "status=", "a=1&b=2"]) expect(queryProblem(url(query)), query).toBeNull();
  });
});
