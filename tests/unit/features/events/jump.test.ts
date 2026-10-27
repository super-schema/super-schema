import { describe, expect, it } from "vitest";
import { jumpEntries } from "@/features/events/builder/jump";
import { buildOutline } from "@/features/events/builder/outline";
import { emptyEventDocument } from "@/lib/events/document/types";
import { sampleDocument } from "../../components/events/builder-harness";

describe("jumpEntries", () => {
  it("lists the seven sections first, then the items of each section in outline order", () => {
    const entries = jumpEntries(buildOutline(sampleDocument(), []));
    expect(entries.slice(0, 7).map((e) => [e.section, e.item, e.label, e.group])).toEqual([
      ["metadata", null, "Metadata", "Sections"], ["servers", null, "Servers", "Sections"], ["channels", null, "Channels", "Sections"],
      ["messages", null, "Messages", "Sections"], ["operations", null, "Operations", "Sections"],
      ["traits", null, "Message properties", "Sections"], ["advanced", null, "Advanced", "Sections"],
    ]);
    expect(entries.slice(7).map((e) => [e.section, e.item, e.label, e.group])).toEqual([
      ["servers", "kafka-prod", "kafka-prod", "Servers"], ["servers", "kafka-dev", "kafka-dev", "Servers"],
      ["channels", "orders", "orders", "Channels"], ["channels", "refunds", "refunds", "Channels"],
      ["messages", "OrderCreated", "OrderCreated", "Messages"], ["operations", "publishOrder", "publishOrder", "Operations"],
    ]);
  });

  it("gives an empty document only its sections", () => {
    const entries = jumpEntries(buildOutline(emptyEventDocument("Orders"), []));
    expect(entries).toHaveLength(7);
    expect(entries.every((e) => e.item === null && e.group === "Sections")).toBe(true);
  });

  it("lists the external references with the channels or messages they stand beside", () => {
    const doc = sampleDocument();
    doc.externalRefs = [{ key: "Shared", kind: "message", eventVersionId: "ev-1", itemKey: "Shared" }];
    const entries = jumpEntries(buildOutline(doc, []));
    expect(entries.filter((e) => e.section === "messages" && e.item !== null).map((e) => e.item)).toEqual(["OrderCreated", "Shared"]);
  });

  it("carries the problem counts of sections and items", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "not a host" };
    const problems = [{ pointer: "/servers/1/host", message: "bad" }];
    const entries = jumpEntries(buildOutline(doc, problems));
    expect(entries.find((e) => e.section === "servers" && e.item === null)?.problems).toBe(1);
    expect(entries.find((e) => e.item === "kafka-dev")?.problems).toBe(1);
    expect(entries.find((e) => e.item === "kafka-prod")?.problems).toBe(0);
  });

  it("names an item with no key (a broken document) and jumps to its section", () => {
    const doc = sampleDocument();
    doc.servers[0] = { ...doc.servers[0], key: "" };
    const blank = jumpEntries(buildOutline(doc, [])).find((e) => e.group === "Servers" && e.label === "(no key)");
    expect(blank).toMatchObject({ section: "servers", item: null });
  });
});
