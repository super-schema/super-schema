import { describe, it, expect } from "vitest";
import { parseProtobufSchema } from "@/lib/importers/protobuf.importer";

describe("Protobuf Importer", () => {
  describe("scalar types", () => {
    it("parses .proto file with scalar types", () => {
      const proto = `syntax = "proto3";

message User {
  string name = 1;
  int32 age = 2;
  int64 id = 3;
  float score = 4;
  double amount = 5;
  bool active = 6;
  bytes data = 7;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.name).toBe("User");
      expect(result.data.fields).toHaveLength(7);

      expect(result.data.fields[0]).toMatchObject({
        name: "name",
        type: "string",
        confidence: "high",
      });
      expect(result.data.fields[1]).toMatchObject({
        name: "age",
        type: "int32",
        confidence: "high",
      });
      expect(result.data.fields[2]).toMatchObject({
        name: "id",
        type: "int64",
        confidence: "high",
      });
      expect(result.data.fields[3]).toMatchObject({
        name: "score",
        type: "float32",
        confidence: "high",
      });
      expect(result.data.fields[4]).toMatchObject({
        name: "amount",
        type: "float64",
        confidence: "high",
      });
      expect(result.data.fields[5]).toMatchObject({
        name: "active",
        type: "boolean",
        confidence: "high",
      });
      expect(result.data.fields[6]).toMatchObject({
        name: "data",
        type: "bytes",
        confidence: "high",
      });
    });

    it("parses uint32 and uint64 types", () => {
      const proto = `syntax = "proto3";
message Msg {
  uint32 unsigned_int = 1;
  uint64 unsigned_long = 2;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].type).toBe("uint32");
      expect(result.data.fields[1].type).toBe("uint64");
    });
  });

  describe("field numbers", () => {
    it("preserves field numbers in ParsedField", () => {
      const proto = `syntax = "proto3";
message Event {
  string event_type = 1;
  int64 timestamp = 5;
  string payload = 10;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].fieldNumber).toBe(1);
      expect(result.data.fields[1].fieldNumber).toBe(5);
      expect(result.data.fields[2].fieldNumber).toBe(10);
    });
  });

  describe("proto3 syntax", () => {
    it("handles proto3 syntax (all fields implicitly optional / nullable)", () => {
      const proto = `syntax = "proto3";
message Msg {
  string name = 1;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].nullable).toBe(true);
    });

    it("handles explicit optional keyword in proto3", () => {
      const proto = `syntax = "proto3";
message Msg {
  optional string nickname = 1;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].nullable).toBe(true);
    });
  });

  describe("well-known types", () => {
    it("maps google.protobuf.Timestamp to utcDateTime", () => {
      const proto = `syntax = "proto3";
message Event {
  google.protobuf.Timestamp created_at = 1;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].type).toBe("utcDateTime");
      expect(result.data.fields[0].confidence).toBe("high");
    });

    it("maps the google.type civil-time messages the protobuf target emits back to plainDate / plainTime", () => {
      const proto = `syntax = "proto3";
import "google/type/date.proto";
import "google/type/timeofday.proto";
message Shift {
  google.type.Date work_day = 1;
  google.type.TimeOfDay starts_at = 2;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields.map((f) => [f.name, f.type, f.confidence])).toEqual([
        ["work_day", "plainDate", "high"],
        ["starts_at", "plainTime", "high"],
      ]);
    });
  });

  // Epic 15.1: map key/value and array element types are now preserved, so the
  // mapping is exact (was low / medium when only "map" / "array" survived).
  describe("map and repeated types", () => {
    it("maps map<K,V> with key and value types at high confidence", () => {
      const proto = `syntax = "proto3";
message Msg {
  map<string, string> metadata = 1;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0]).toMatchObject({
        type: "map",
        mapKeyType: "string",
        mapValueType: "string",
        confidence: "high",
      });
    });

    it("maps repeated scalars to arrays with their element type at high confidence", () => {
      const proto = `syntax = "proto3";
message Msg {
  repeated string tags = 1;
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0]).toMatchObject({
        type: "array",
        arrayElementType: "string",
        confidence: "high",
      });
    });
  });

  describe("comments as descriptions", () => {
    it("extracts inline comments as field descriptions", () => {
      const proto = `syntax = "proto3";
message Msg {
  string email = 1; // User email address
}`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.fields[0].description).toBe("User email address");
    });
  });

  describe("error handling", () => {
    it("returns error for content without message definition", () => {
      const result = parseProtobufSchema("enum Status { ACTIVE = 0; }");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PARSE_ERROR");
    });

    it("returns error for empty content", () => {
      const result = parseProtobufSchema("");
      expect(result.success).toBe(false);
    });
  });

  describe("source format tracking", () => {
    it("sets sourceFormat to protobuf", () => {
      const proto = `syntax = "proto3";\nmessage M { string x = 1; }`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.sourceFormat).toBe("protobuf");
    });

    it("preserves original content", () => {
      const proto = `syntax = "proto3";\nmessage M { string x = 1; }`;
      const result = parseProtobufSchema(proto);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.originalContent).toBe(proto);
    });
  });
});
