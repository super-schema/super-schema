import { describe, expect, it } from "vitest";
import { domainDeleteBlocker } from "@/lib/domain-deletion";

const EMPTY = { entities: 0, traits: 0, eventSpecs: 0 };

describe("domainDeleteBlocker", () => {
  it("allows deleting a domain with no entities and no Events assets", () => {
    expect(domainDeleteBlocker(EMPTY)).toBeNull();
  });

  it("keeps the long-standing entity-only wording", () => {
    expect(domainDeleteBlocker({ ...EMPTY, entities: 1 })).toBe(
      "Cannot delete - 1 entity exists in this domain or its products. Move or delete it first."
    );
    expect(domainDeleteBlocker({ ...EMPTY, entities: 3 })).toBe(
      "Cannot delete - 3 entities exist in this domain or its products. Move or delete them first."
    );
  });

  it.each([
    [{ traits: 1 }, "Cannot delete - 1 trait exists in this domain or its products. Move or delete it first."],
    [{ eventSpecs: 1 }, "Cannot delete - 1 event exists in this domain or its products. Move or delete it first."],
    [{ traits: 2 }, "Cannot delete - 2 traits exist in this domain or its products. Move or delete them first."],
    [{ eventSpecs: 5 }, "Cannot delete - 5 events exist in this domain or its products. Move or delete them first."],
  ])("blocks on Events assets alone: %j", (counts, message) => {
    expect(domainDeleteBlocker({ ...EMPTY, ...counts })).toBe(message);
  });

  it("lists entities and every Events kind together", () => {
    expect(domainDeleteBlocker({ entities: 1, traits: 1, eventSpecs: 3 })).toBe(
      "Cannot delete - 1 entity, 1 trait and 3 events exist in this domain or its products. Move or delete them first."
    );
  });

  it("uses the plural form for two single-item kinds", () => {
    expect(domainDeleteBlocker({ ...EMPTY, entities: 1, eventSpecs: 1 })).toBe(
      "Cannot delete - 1 entity and 1 event exist in this domain or its products. Move or delete them first."
    );
  });
});
