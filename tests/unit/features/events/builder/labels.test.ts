import { describe, expect, it } from "vitest";
import {
  addPropertiesLabel, BUILT_IN_NOTE, chooserItemText, groupLabel, LIBRARY_NOTE, MESSAGE_PROPERTIES, messagePropertiesTitle, newPropertiesLabel,
  NEW_PROPERTIES_DESCRIPTION, NEW_PROPERTIES_MENU, OPERATION_PROPERTIES, operationPropertiesTitle, PINNED_HEADERS_LEAD, PINNED_PROPERTIES_LEAD, propertiesName,
  propertiesNameLower, propertiesTitle, propertyCountText, TRAIT_BADGE, TRAIT_SUFFIX, updateDuplicateText,
} from "@/features/events/builder/labels";

describe("labels: one source for the names users see", () => {
  it("names the properties the way the user asked: Message properties, with (Trait) in brackets", () => {
    expect(MESSAGE_PROPERTIES).toBe("Message properties");
    expect(OPERATION_PROPERTIES).toBe("Operation properties");
    expect(TRAIT_SUFFIX).toBe("(Trait)");
    expect(TRAIT_BADGE).toBe("Trait");
    expect(messagePropertiesTitle()).toBe("Message properties (Trait)");
    expect(operationPropertiesTitle()).toBe("Operation properties (Trait)");
  });

  it("picks the title, the plain name and the sentence form by kind", () => {
    expect(propertiesTitle("MESSAGE")).toBe("Message properties (Trait)");
    expect(propertiesTitle("OPERATION")).toBe("Operation properties (Trait)");
    expect(propertiesName("MESSAGE")).toBe("Message properties");
    expect(propertiesName("OPERATION")).toBe("Operation properties");
    expect(propertiesNameLower("OPERATION")).toBe("operation properties");
  });

  it("builds the button, blank-item and menu texts", () => {
    expect(addPropertiesLabel("MESSAGE")).toBe("Add message properties");
    expect(addPropertiesLabel("OPERATION")).toBe("Add operation properties");
    expect(newPropertiesLabel("MESSAGE")).toBe("New message properties");
    expect(NEW_PROPERTIES_MENU).toBe("New Message Properties");
    expect(NEW_PROPERTIES_DESCRIPTION).toBe("Reusable message properties (Trait)");
  });

  it("names the two list groups", () => {
    expect(groupLabel("MESSAGE")).toBe("On messages");
    expect(groupLabel("OPERATION")).toBe("On operations");
  });

  it("explains why built-in and library sets cannot be edited where they are used", () => {
    expect(BUILT_IN_NOTE).toBe("Built in — can't be modified");
    expect(LIBRARY_NOTE).toBe("From the library — edit it under Message properties at the Tenant/Domain level");
  });

  it("counts properties with the right plural, and shows what a chooser item brings", () => {
    expect(propertyCountText(1)).toBe("1 property");
    expect(propertyCountText(0)).toBe("0 properties");
    expect(propertyCountText(8)).toBe("8 properties");
    expect(chooserItemText("CloudEvents 1.0", 8)).toBe("CloudEvents 1.0 — 8 properties");
    expect(chooserItemText("Retry policy", null)).toBe("Retry policy");
  });

  it("words the note of a properties table whose headers come from a pinned entity (the table appends the entity and its version)", () => {
    expect(PINNED_PROPERTIES_LEAD).toBe("Properties come from the entity");
    expect(PINNED_HEADERS_LEAD).toBe("Headers also come from the entity");
  });

  it("names the reference that already points at the item an Update would re-point to, and what to do instead", () => {
    expect(updateDuplicateText("OrderPlaced", "2.0", "Order-placed-v2")).toBe(
      'Cannot update to v2.0: "Order-placed-v2" already points at "OrderPlaced" in that version. Remove one of the two references instead.',
    );
  });
});
