import { describe, it, expect } from "vitest";
import { inferJsonSchema } from "@/lib/importers/jsonschema-infer";
import { parseJsonSchema } from "@/lib/importers/jsonschema.importer";

describe("JSON Schema inference from sample", () => {
  it("infers types + string formats from a sample event", () => {
    const schema = inferJsonSchema(
      {
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        email: "a@b.com",
        createdAt: "2024-05-06T12:20:00Z",
        count: 3,
        ratio: 1.5,
        active: true,
      },
      "Event"
    );

    const props = schema.properties as Record<string, { type: string; format?: string }>;
    expect(props.id.format).toBe("uuid");
    expect(props.email.format).toBe("email");
    expect(props.createdAt.format).toBe("date-time");
    expect(props.count.type).toBe("integer");
    expect(props.ratio.type).toBe("number");
    expect(props.active.type).toBe("boolean");
    expect(schema.title).toBe("Event");
  });

  it("marks non-null sample keys as required", () => {
    const schema = inferJsonSchema({ a: 1, b: null });
    expect(schema.required).toEqual(["a"]);
  });

  it("produces output that round-trips through parseJsonSchema", () => {
    const schema = inferJsonSchema({ id: "x", when: "2024-05-06", nested: { k: 1 } }, "Sample");
    const result = parseJsonSchema(JSON.stringify(schema));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("Sample");
    expect(result.data.fields.find((f) => f.name === "when")?.type).toBe("plainDate");
    expect(result.data.fields.find((f) => f.name === "nested")?.type).toBe("object");
  });

  it("wraps a primitive root under a value property", () => {
    const schema = inferJsonSchema("hello");
    const props = schema.properties as Record<string, { type: string }>;
    expect(props.value.type).toBe("string");
  });
});
