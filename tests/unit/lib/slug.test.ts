import { describe, it, expect } from "vitest";
import {
  generateSlug,
  isReservedSchemaRouteSlug,
  isReservedEntityRouteSlug,
  isReservedProductRouteSlug,
  reservedEntitySlugMessage,
} from "@/lib/slug";

describe("generateSlug", () => {
  it("keeps the slug of an ASCII name exactly as it was (a stored slug is never re-derived to a different one)", () => {
    expect(generateSlug("Order Data")).toBe("order-data");
    expect(generateSlug("order_id")).toBe("order-id");
    expect(generateSlug("  Billing 2  ")).toBe("billing-2");
    expect(generateSlug("a--b")).toBe("a-b");
    expect(generateSlug("Order #1")).toBe("order-1");
  });

  it("folds accents and spells the special letters, so a Latin name keeps its letters (Café is cafe, Größe is grosse)", () => {
    expect(generateSlug("Café")).toBe("cafe");
    expect(generateSlug("ÉCOLE")).toBe("ecole");
    expect(generateSlug("Größe")).toBe("grosse");
    expect(generateSlug("Ærø")).toBe("aero");
    expect(generateSlug("Łódź")).toBe("lodz");
    expect(generateSlug("Đorđe")).toBe("dorde");
    expect(generateSlug("Þór")).toBe("thor");
    expect(generateSlug("Œuvre")).toBe("oeuvre");
    expect(generateSlug("Kılıç")).toBe("kilic");
  });

  it("reads the compatibility letters as the plain letters they stand for, capitals included (ℕℤℚ, ℂ, 𝐇𝐞𝐥𝐥𝐨), so none of them is dropped", () => {
    expect(generateSlug("ℕℤℚ")).toBe("nzq");
    expect(generateSlug("ℂ")).toBe("c");
    expect(generateSlug("𝐇𝐞𝐥𝐥𝐨")).toBe("hello");
    expect(generateSlug("Ⅻ")).toBe("xii");
    expect(generateSlug("ℂ")).not.toBe("");
  });

  it("gives a name with no ASCII left (a non-Latin script) its own item- slug, stable for the name and distinct per name", () => {
    const first = generateSlug("名前");
    expect(first).toMatch(/^item-[0-9a-z]+$/);
    expect(generateSlug("名前")).toBe(first);
    expect(generateSlug(" 名前 ")).toBe(first);
    expect(generateSlug("年齢")).not.toBe(first);
    expect(generateSlug("Имя")).not.toBe(generateSlug("Фамилия"));
    expect(generateSlug("ガ")).not.toBe(generateSlug("カ"));
  });

  it("keeps two names that differ by a letter apart, even when one folds into the other's spelling (Café and Caf)", () => {
    expect(generateSlug("Café")).toBe("cafe");
    expect(generateSlug("Caf")).toBe("caf");
    expect(generateSlug("Café")).not.toBe(generateSlug("Caf"));
  });

  it("keeps the ASCII part of a mixed name with the hash after it, so two such names do not share a slug", () => {
    expect(generateSlug("Café 名前")).toMatch(/^cafe-[0-9a-z]+$/);
    expect(generateSlug("Café 名前")).not.toBe(generateSlug("Café 住所"));
    expect(generateSlug("Café")).toBe("cafe");
  });

  it("is empty only for a name with no letter or digit in any script (the callers refuse it)", () => {
    expect(generateSlug("!!!")).toBe("");
    expect(generateSlug("---")).toBe("");
    expect(generateSlug("   ")).toBe("");
    expect(generateSlug("★ ✓")).toBe("");
    expect(generateSlug("1")).toBe("1");
  });
});

describe("reserved slugs", () => {
  it("schema route", () => {
    expect(isReservedSchemaRouteSlug("enterprise")).toBe(true);
    expect(isReservedSchemaRouteSlug("type-mappings")).toBe(true);
    expect(isReservedSchemaRouteSlug("payments")).toBe(false);
  });
  it("entity route", () => {
    for (const s of ["new", "events", "channels", "messages", "specs", "traits", "data-types", "apis"]) {
      expect(isReservedEntityRouteSlug(s)).toBe(true);
    }
    expect(isReservedEntityRouteSlug("order")).toBe(false);
  });
  it("product route", () => {
    expect(isReservedProductRouteSlug("traits")).toBe(true);
    expect(isReservedProductRouteSlug("checkout")).toBe(false);
  });
  it("reserved entity slug message", () => {
    expect(reservedEntitySlugMessage("Events")).toContain("events");
    expect(reservedEntitySlugMessage("Events")).toContain("reserved");
    expect(reservedEntitySlugMessage("Order")).toBe(null);
  });
});
