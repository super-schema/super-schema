import { describe, expect, it } from "vitest";
import { bindingCount, cardsWithProblems, cardTemplate, mergeValue, pickValue, setFieldCount } from "@/features/events/builder/sections/form-cards";
import { TEMPLATES } from "@/lib/events/templates";

describe("cardTemplate", () => {
  it("keeps only the card's fields, in the card's order, all in the basics group so the card has no 'More properties' toggle of its own", () => {
    const template = cardTemplate(TEMPLATES.message, ["tags", "externalDocs"]);
    expect(template.fields.map((f) => f.key)).toEqual(["tags", "externalDocs"]);
    expect(template.fields.every((f) => f.group === "basics")).toBe(true);
    expect(template.id).toBe(TEMPLATES.message.id);
  });

  it("keeps each field's label, kind and help", () => {
    const [field] = cardTemplate(TEMPLATES.message, ["correlationId"]).fields;
    const original = TEMPLATES.message.fields.find((f) => f.key === "correlationId")!;
    expect(field).toMatchObject({ key: "correlationId", label: original.label, kind: original.kind, help: original.help });
  });

  it("ignores a key the template does not have, and does not change the template", () => {
    const before = JSON.stringify(TEMPLATES.operation);
    expect(cardTemplate(TEMPLATES.operation, ["title", "nope"]).fields.map((f) => f.key)).toEqual(["title"]);
    expect(JSON.stringify(TEMPLATES.operation)).toBe(before);
  });

  it("covers every field of the message and operation templates once the cards' keys are added up", () => {
    const messageKeys = [
      ...["name", "title", "summary", "description", "contentType"], ...["examples"], ...["tags", "externalDocs"], ...["correlationId"], ...["deprecated"],
      // drawn by hand: the entity pins, the bindings and the traits card
      "payload", "headers", "keyPin", "bindings", "traits",
    ];
    expect([...messageKeys].sort()).toEqual(TEMPLATES.message.fields.map((f) => f.key).sort());
    const operationKeys = [...["title", "summary", "description"], ...["tags", "externalDocs"], "security", "action", "channel", "messages", "reply", "bindings", "traits"];
    expect([...operationKeys].sort()).toEqual(TEMPLATES.operation.fields.map((f) => f.key).sort());
  });
});

describe("pickValue and mergeValue", () => {
  const full = { name: "n", title: "t", tags: [{ name: "a" }], traits: ["x"] };

  it("picks only the keys a card draws", () => {
    expect(pickValue(full, ["title", "tags", "missing"])).toEqual({ title: "t", tags: [{ name: "a" }] });
  });

  it("merges a card's edit back: its keys are replaced, every other key stays", () => {
    expect(mergeValue(full, ["title", "tags"], { title: "T2" })).toEqual({ name: "n", title: "T2", traits: ["x"] });
    expect(mergeValue(full, ["title"], { title: "T2" })).toEqual({ name: "n", title: "T2", tags: [{ name: "a" }], traits: ["x"] });
  });

  it("adds a key the card set for the first time", () => {
    expect(mergeValue({ name: "n" }, ["title"], { title: "T" })).toEqual({ name: "n", title: "T" });
  });

  it("does not mutate its inputs", () => {
    const copy = structuredClone(full);
    mergeValue(full, ["title"], { title: "x" });
    pickValue(full, ["title"]);
    expect(full).toEqual(copy);
  });
});

describe("setFieldCount and bindingCount", () => {
  it("counts the card's fields that are set, and a boolean that was set to false", () => {
    expect(setFieldCount(TEMPLATES.message, ["name", "title", "summary"], { name: "n", summary: "" })).toBe(1);
    expect(setFieldCount(TEMPLATES.message, ["deprecated"], { deprecated: false })).toBe(1);
    expect(setFieldCount(TEMPLATES.message, ["deprecated"], {})).toBe(0);
    expect(setFieldCount(TEMPLATES.message, ["tags", "externalDocs"], { tags: [], externalDocs: { url: "https://x.test" } })).toBe(1);
  });

  it("ignores keys that are not in the template", () => {
    expect(setFieldCount(TEMPLATES.message, ["nope"], { nope: "x" })).toBe(0);
  });

  it("counts the protocols of a bindings object", () => {
    expect(bindingCount({ kafka: {}, mqtt: {} })).toBe(2);
    expect(bindingCount({})).toBe(0);
    expect(bindingCount(undefined)).toBe(0);
    expect(bindingCount([1])).toBe(0);
  });
});

describe("cardsWithProblems", () => {
  const fields = { payload: ["payload", "representation"], details: ["title", "summary"], properties: ["traitKeys"] };

  it("names the cards that hold a problem at or below one of their pointers", () => {
    const problems = [
      { pointer: "/messages/0/payload/entityId", message: "required" },
      { pointer: "/messages/0/traitKeys/1", message: "unknown" },
    ];
    expect([...cardsWithProblems(problems, "/messages/0", fields)].sort()).toEqual(["payload", "properties"]);
  });

  it("ignores problems of another item and prefix look-alikes", () => {
    const problems = [
      { pointer: "/messages/1/title", message: "x" },
      { pointer: "/messages/0/titles", message: "x" },
      { pointer: "/messages/0", message: "x" },
    ];
    expect(cardsWithProblems(problems, "/messages/0", fields).size).toBe(0);
  });

  it("is empty without problems", () => {
    expect(cardsWithProblems([], "/messages/0", fields).size).toBe(0);
  });
});
