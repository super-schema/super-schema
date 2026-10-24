/**
 * The Field Studio is opened with the field's slug in its address, and a rename changes the slug (the server derives it from the name).
 * Every save revalidates the page behind the studio, so the next render of an address that still names the OLD slug is a 404: the
 * studio showed "This page could not be found" a moment after the first autosave of a renamed field (found by the browser suite). The
 * studio therefore puts the field's id, which never changes, in its address as soon as it is on screen.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FieldStudio } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({ updateFieldAction: vi.fn() }));

const FIELD = {
  id: "f1", name: "shipTo", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [] as string[], decorators: {} as Record<string, unknown>,
};
const ENTITY = { id: "ent-1", name: "Order", slug: "order", domainSlug: "payments", productSlug: "checkout" };
const TENANT_ENTITY = { ...ENTITY, domainSlug: null, productSlug: null };
const DOMAIN = { name: "Payments", policy: null };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    configurable: true,
  });
});
afterEach(cleanup);

describe("the address of the Field Studio", () => {
  it("names the field by its id once the studio is on screen, when it was opened by the slug", () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/order/fields/ship-to?tab=x");
    render(<FieldStudio field={FIELD} entity={ENTITY} domain={DOMAIN} />);
    expect(window.location.pathname).toBe("/schemas/payments/checkout/order/fields/f1");
    expect(window.location.search).toBe("?tab=x");
  });

  it("is left alone when it already names the id", () => {
    window.history.replaceState(null, "", "/schemas/payments/checkout/order/fields/f1");
    const replace = vi.spyOn(window.history, "replaceState");
    render(<FieldStudio field={FIELD} entity={ENTITY} domain={DOMAIN} />);
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/schemas/payments/checkout/order/fields/f1");
    replace.mockRestore();
  });

  it("is the Enterprise address for a tenant-level entity", () => {
    window.history.replaceState(null, "", "/schemas/enterprise/entities/order/fields/ship-to");
    render(<FieldStudio field={FIELD} entity={TENANT_ENTITY} domain={DOMAIN} />);
    expect(window.location.pathname).toBe("/schemas/enterprise/entities/order/fields/f1");
  });
});
