import { describe, it, expect } from "vitest";
import { placeRootMessageFirst } from "@/lib/event-specs/proto-root";

const ORDER_PROTO = `syntax = "proto3";

package acme.payments.checkout;

import "google/protobuf/timestamp.proto";

// A line item.
message LineItem {
  string sku = 1;
  int32 quantity = 2;
}

// The order placed at checkout.
message Order {
  string id = 1;
  repeated LineItem items = 2;
  google.protobuf.Timestamp created_at = 3;
}
`;

const ORDER_PROTO_ROOT_FIRST = `syntax = "proto3";

package acme.payments.checkout;

import "google/protobuf/timestamp.proto";

// The order placed at checkout.
// @RootNode
message Order {
  string id = 1;
  repeated LineItem items = 2;
  google.protobuf.Timestamp created_at = 3;
}

// A line item.
message LineItem {
  string sku = 1;
  int32 quantity = 2;
}
`;

function run(proto: string, root: string): string {
  const res = placeRootMessageFirst(proto, root);
  if (!res.success) throw new Error(res.error.message);
  return res.data;
}

describe("placeRootMessageFirst (spec §7.3, Story 16.3)", () => {
  it("moves the root message first and annotates it with // @RootNode", () => {
    expect(run(ORDER_PROTO, "Order")).toBe(ORDER_PROTO_ROOT_FIRST);
  });

  it("is idempotent", () => {
    expect(run(ORDER_PROTO_ROOT_FIRST, "Order")).toBe(ORDER_PROTO_ROOT_FIRST);
  });

  it("annotates a root that is already first", () => {
    const src = `syntax = "proto3";\n\nmessage Order {\n  string id = 1;\n}\n`;
    expect(run(src, "Order")).toBe(`syntax = "proto3";\n\n// @RootNode\nmessage Order {\n  string id = 1;\n}\n`);
  });

  it("moves @RootNode off a stale root", () => {
    const src = `syntax = "proto3";\n\n// @RootNode\nmessage Old {\n  string a = 1;\n}\n\nmessage Order {\n  Old old = 1;\n}\n`;
    expect(run(src, "Order")).toBe(
      `syntax = "proto3";\n\n// @RootNode\nmessage Order {\n  Old old = 1;\n}\n\nmessage Old {\n  string a = 1;\n}\n`,
    );
  });

  it("ignores braces inside strings and comments, and nested messages with the root's name", () => {
    const src = [
      'syntax = "proto3";',
      "",
      "message Outer {",
      '  string note = 1 [json_name = "n{"]; // a } brace',
      "  /* { block } */",
      "  message Order { string id = 1; }",
      "  Order order = 2;",
      "}",
      "",
      "message Order {",
      "  string id = 1;",
      "}",
      "",
    ].join("\n");
    const out = run(src, "Order");
    expect(out.indexOf("// @RootNode\nmessage Order {")).toBeGreaterThan(0);
    expect(out.indexOf("message Order {\n  string id = 1;\n}")).toBeLessThan(out.indexOf("message Outer {"));
    expect(out).toContain(
      '  string note = 1 [json_name = "n{"]; // a } brace\n  /* { block } */\n  message Order { string id = 1; }',
    );
  });

  it("returns ROOT_MESSAGE_NOT_FOUND when the root is not a top-level message", () => {
    const res = placeRootMessageFirst(`syntax = "proto3";\nmessage Outer { message Order {} }\n`, "Order");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("ROOT_MESSAGE_NOT_FOUND");
  });

  it("returns PROTO_PARSE_ERROR on unbalanced braces", () => {
    const res = placeRootMessageFirst(`syntax = "proto3";\nmessage Order {\n  string id = 1;\n`, "Order");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe("PROTO_PARSE_ERROR");
  });
});
