import { describe, expect, it } from "vitest";
import { suggestKey } from "@/lib/events/templates";
import type { KeyKind } from "@/lib/events/templates";
import { KEY_MAX_LENGTH, KEY_PATTERN } from "@/lib/events/document/types";
import { isReservedKey } from "@/lib/event-specs/own-property";

const KINDS: KeyKind[] = ["server", "channel", "message", "operation", "trait", "externalRef"];

describe("suggestKey", () => {
  describe("server: title -> host -> protocol -> server", () => {
    it("prefers the title", () => {
      expect(suggestKey("server", { title: "Production Kafka", host: "k.example.com:9092", protocol: "kafka" }, [])).toBe("Production-Kafka");
    });
    it("falls back to the host, then the protocol, then the kind", () => {
      expect(suggestKey("server", { host: "k.example.com:9092", protocol: "kafka" }, [])).toBe("k.example.com-9092");
      expect(suggestKey("server", { protocol: "mqtt" }, [])).toBe("mqtt");
      expect(suggestKey("server", {}, [])).toBe("server");
    });
    it("gives two servers with the same host distinct keys", () => {
      const values = { host: "broker.example.com:9092", protocol: "kafka" };
      const taken: string[] = [];
      for (let i = 0; i < 3; i++) taken.push(suggestKey("server", values, taken));
      expect(taken).toEqual(["broker.example.com-9092", "broker.example.com-9092-2", "broker.example.com-9092-3"]);
      expect(new Set(taken).size).toBe(3);
    });
    it("gives two servers with the same title distinct keys", () => {
      const first = suggestKey("server", { title: "Prod" }, []);
      expect(suggestKey("server", { title: "Prod" }, [first])).toBe("Prod-2");
    });
  });

  describe("channel: title -> address -> channel", () => {
    it("prefers the title", () => expect(suggestKey("channel", { title: "User signed up", address: "user/signedup" }, [])).toBe("User-signed-up"));
    it("falls back to the address, slugging braces and slashes", () => {
      expect(suggestKey("channel", { address: "user/{userId}/signedup" }, [])).toBe("user-userId-signedup");
      expect(suggestKey("channel", { address: "orders.created" }, [])).toBe("orders.created");
    });
    it("falls back to the kind when the address is null or blank", () => {
      expect(suggestKey("channel", { address: null }, [])).toBe("channel");
      expect(suggestKey("channel", { title: "  ", address: "" }, [])).toBe("channel");
    });
  });

  describe("message: name -> title -> message", () => {
    it("prefers the name over the title", () => expect(suggestKey("message", { name: "OrderCreated", title: "Order created" }, [])).toBe("OrderCreated"));
    it("falls back to the title, then the kind", () => {
      expect(suggestKey("message", { title: "Order created" }, [])).toBe("Order-created");
      expect(suggestKey("message", {}, [])).toBe("message");
    });
  });

  describe("operation: title -> action-channel -> operation", () => {
    it("prefers the title", () => expect(suggestKey("operation", { title: "Publish order", action: "send", channel: "orders" }, [])).toBe("Publish-order"));
    it("falls back to `${action}-${channel}`", () => expect(suggestKey("operation", { action: "send", channel: "orders" }, [])).toBe("send-orders"));
    it("needs both action and channel for the fallback", () => {
      expect(suggestKey("operation", { action: "send" }, [])).toBe("operation");
      expect(suggestKey("operation", { channel: "orders" }, [])).toBe("operation");
      expect(suggestKey("operation", {}, [])).toBe("operation");
    });
    it("keeps send and receive on the same channel apart", () => {
      expect(suggestKey("operation", { action: "receive", channel: "orders" }, ["send-orders"])).toBe("receive-orders");
    });
  });

  describe("trait: name -> title -> trait", () => {
    it("prefers the name", () => expect(suggestKey("trait", { name: "CommonHeaders", title: "Common" }, [])).toBe("CommonHeaders"));
    it("falls back to the title, then the kind", () => {
      expect(suggestKey("trait", { title: "Common headers" }, [])).toBe("Common-headers");
      expect(suggestKey("trait", {}, [])).toBe("trait");
    });
  });

  describe("externalRef: reference", () => {
    it("always starts from `reference` and counts up", () => {
      expect(suggestKey("externalRef", { title: "ignored", name: "ignored" }, [])).toBe("reference");
      expect(suggestKey("externalRef", {}, ["reference"])).toBe("reference-2");
      expect(suggestKey("externalRef", {}, ["reference", "reference-2"])).toBe("reference-3");
    });
  });

  describe("uniqueness", () => {
    it("appends -2, -3, … until free, skipping taken holes", () => {
      expect(suggestKey("message", { name: "Order" }, ["Order"])).toBe("Order-2");
      expect(suggestKey("message", { name: "Order" }, ["Order", "Order-2"])).toBe("Order-3");
      expect(suggestKey("message", { name: "Order" }, ["Order", "Order-3"])).toBe("Order-2");
    });
    it("accepts any iterable of taken keys and never mutates it", () => {
      const taken = new Set(["Order"]);
      expect(suggestKey("message", { name: "Order" }, taken)).toBe("Order-2");
      expect([...taken]).toEqual(["Order"]);
      function* generated() { yield "Order"; yield "Order-2"; }
      expect(suggestKey("message", { name: "Order" }, generated())).toBe("Order-3");
    });
    it("treats keys case-sensitively, like the document does", () => {
      expect(suggestKey("message", { name: "Order" }, ["order"])).toBe("Order");
    });
  });

  describe("source text handling", () => {
    it("ignores blank, non-string and symbol-only candidates and moves on to the next source", () => {
      expect(suggestKey("server", { title: "   ", host: 5, protocol: "amqp" }, [])).toBe("amqp");
      expect(suggestKey("server", { title: "!!!", host: "h.example.com" }, [])).toBe("h.example.com");
      expect(suggestKey("message", { name: undefined, title: null }, [])).toBe("message");
    });
    it("moves on from a title without any ASCII letter or digit", () => {
      expect(suggestKey("server", { title: "日本語", host: "h.example.com" }, [])).toBe("h.example.com");
    });
    it("trims surrounding whitespace", () => expect(suggestKey("message", { name: "  Order created  " }, [])).toBe("Order-created"));
  });

  describe("length and shape", () => {
    it("truncates to 64 characters", () => {
      const key = suggestKey("message", { name: "a".repeat(200) }, []);
      expect(key).toBe("a".repeat(KEY_MAX_LENGTH));
    });
    it("stays within 64 characters when a suffix is needed", () => {
      const base = "b".repeat(200);
      const first = suggestKey("message", { name: base }, []);
      const second = suggestKey("message", { name: base }, [first]);
      expect(first).toHaveLength(KEY_MAX_LENGTH);
      expect(second).toHaveLength(KEY_MAX_LENGTH);
      expect(second.endsWith("-2")).toBe(true);
      expect(second).not.toBe(first);
      const third = suggestKey("message", { name: base }, [first, second]);
      expect(third).toHaveLength(KEY_MAX_LENGTH);
      expect(third.endsWith("-3")).toBe(true);
    });
    it("drops a trailing dash left by truncation", () => {
      const key = suggestKey("message", { name: `${"c".repeat(63)} tail` }, []);
      expect(key).toBe("c".repeat(63));
    });
    it("never returns a reserved Object.prototype name", () => {
      for (const name of ["__proto__", "constructor", "prototype"]) {
        const key = suggestKey("message", { name }, []);
        expect(isReservedKey(key), key).toBe(false);
        expect(KEY_PATTERN.test(key), key).toBe(true);
      }
    });
    it.each(KINDS)("returns keys that match KEY_PATTERN for awkward input (%s)", (kind) => {
      const awkward = ["Ünïcödé naïve", "emoji 🚀 title", "a/b\\c d?e=f&g#h", "  ", "---", "{id}", "ünï", "x".repeat(300), "dots.and_underscores-and-dashes", "<script>alert(1)</script>"];
      const taken: string[] = [];
      for (const text of awkward) {
        const key = suggestKey(kind, { title: text, name: text, address: text, host: text, protocol: text, action: "send", channel: text }, taken);
        expect(KEY_PATTERN.test(key), `${kind}: ${JSON.stringify(text)} -> ${key}`).toBe(true);
        expect(key.length).toBeLessThanOrEqual(KEY_MAX_LENGTH);
        expect(taken).not.toContain(key);
        taken.push(key);
      }
    });
  });
});
