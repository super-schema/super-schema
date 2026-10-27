// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PayloadPreview } from "@/features/events/builder/sections/PayloadPreview";
import { resetPinSchemaCache } from "@/features/events/builder/use-pin-json-schema";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { ENTITY_OPTIONS, PIN } from "./builder-harness";

type Schema = Record<string, unknown>;
const h = vi.hoisted(() => ({ pinJsonSchemaAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  getExternalRefStatusesAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  getExternalVersionItemsAction: () => Promise.resolve({ success: false, error: "unavailable" }),
  pinJsonSchemaAction: h.pinJsonSchemaAction,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetPinSchemaCache();
});
afterEach(cleanup);

const ORDER: Schema = { type: "object", properties: { orderId: { type: "string" }, quantity: { type: "integer" } }, required: ["orderId"] };
const entity: EntityOption = ENTITY_OPTIONS[0];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const preview = (props: Partial<Parameters<typeof PayloadPreview>[0]> = {}) =>
  render(<PayloadPreview productId="p1" pin={PIN} entity={entity} enabled {...props} />);

describe("PayloadPreview", () => {
  it("says the fields are loading while the schema is on its way", () => {
    h.pinJsonSchemaAction.mockReturnValue(new Promise(() => {}));
    preview();
    expect(screen.getByTestId("payload-preview").textContent).toContain("Loading fields…");
  });

  it("lists the fields with their types and which are required", async () => {
    h.pinJsonSchemaAction.mockResolvedValue({ success: true, data: { schema: ORDER } });
    preview();
    await settle();
    const text = screen.getByTestId("payload-preview").textContent ?? "";
    expect(text).toContain("orderId");
    expect(text).toContain("string");
    expect(text).toContain("quantity");
    expect(text).toContain("integer");
    expect(screen.getByTestId("payload-preview-required-orderId")).toBeDefined();
    expect(screen.queryByTestId("payload-preview-required-quantity")).toBeNull();
    expect(text).not.toContain("Loading fields");
  });

  it("counts the fields it does not list", async () => {
    const properties = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: "string" }]));
    h.pinJsonSchemaAction.mockResolvedValue({ success: true, data: { schema: { properties } } });
    preview();
    await settle();
    expect(screen.getByTestId("payload-preview").textContent).toContain("+2 more");
  });

  it("says there is no preview when the schema has no fields or could not be loaded", async () => {
    h.pinJsonSchemaAction.mockResolvedValue({ success: true, data: { schema: { type: "string" } } });
    const first = preview();
    await settle();
    expect(screen.getByTestId("payload-preview").textContent).toContain("No field preview");
    first.unmount();
    resetPinSchemaCache();
    h.pinJsonSchemaAction.mockResolvedValue({ success: false, error: "boom", code: "X" });
    preview();
    await settle();
    expect(screen.getByTestId("payload-preview").textContent).toContain("No field preview");
  });

  it("links to the entity when the host knows its page, and omits the link when it does not", async () => {
    h.pinJsonSchemaAction.mockResolvedValue({ success: true, data: { schema: ORDER } });
    const first = preview();
    await settle();
    const link = screen.getByRole("link", { name: /open entity/i });
    expect(link.getAttribute("href")).toBe("/schemas/payments/checkout/ordercreated");
    first.unmount();
    preview({ entity: { ...entity, href: undefined } });
    await settle();
    expect(screen.queryByRole("link", { name: /open entity/i })).toBeNull();
  });

  it("asks nothing while it is not enabled", async () => {
    preview({ enabled: false });
    await settle();
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("payload-preview")).toBeNull();
  });

  it("shows nothing for a message without a payload entity", async () => {
    preview({ pin: { entityId: "", entityVersionId: null }, entity: undefined });
    await settle();
    expect(h.pinJsonSchemaAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("payload-preview")).toBeNull();
  });
});
