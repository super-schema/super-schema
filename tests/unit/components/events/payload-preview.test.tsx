// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PayloadPreview } from "@/features/events/builder/sections/PayloadPreview";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { ENTITY_OPTIONS } from "./builder-harness";

type Schema = Record<string, unknown>;
afterEach(cleanup);

const ORDER: Schema = { type: "object", properties: { orderId: { type: "string" }, quantity: { type: "integer" } }, required: ["orderId"] };
const entity: EntityOption = ENTITY_OPTIONS[0];
const preview = (props: Partial<Parameters<typeof PayloadPreview>[0]> = {}) =>
  render(<PayloadPreview schema={ORDER} loading={false} entity={entity} hasPayload {...props} />);

describe("PayloadPreview", () => {
  it("says the fields are loading while the schema is on its way", () => {
    preview({ schema: null, loading: true });
    expect(screen.getByTestId("payload-preview").textContent).toContain("Loading fields…");
  });

  it("lists the fields with their types and which are required", () => {
    preview();
    const text = screen.getByTestId("payload-preview").textContent ?? "";
    expect(text).toContain("Fields of OrderCreated");
    expect(text).toContain("orderId");
    expect(text).toContain("string");
    expect(text).toContain("quantity");
    expect(text).toContain("integer");
    expect(screen.getByTestId("payload-preview-required-orderId")).toBeDefined();
    expect(screen.queryByTestId("payload-preview-required-quantity")).toBeNull();
    expect(text).not.toContain("Loading fields");
  });

  it("counts the fields it does not list", () => {
    const properties = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: "string" }]));
    preview({ schema: { properties } });
    expect(screen.getByTestId("payload-preview").textContent).toContain("+2 more");
  });

  it("says there is no preview when there is no schema, or the schema has no fields", () => {
    const first = preview({ schema: null });
    expect(screen.getByTestId("payload-preview").textContent).toContain("No field preview");
    first.unmount();
    preview({ schema: { type: "string" } });
    expect(screen.getByTestId("payload-preview").textContent).toContain("No field preview");
  });

  it("links to the entity when the host knows its page, and omits the link when it does not", () => {
    const first = preview();
    expect(screen.getByRole("link", { name: /open entity/i }).getAttribute("href")).toBe("/schemas/payments/checkout/ordercreated");
    first.unmount();
    preview({ entity: { ...entity, href: undefined } });
    expect(screen.queryByRole("link", { name: /open entity/i })).toBeNull();
  });

  it("shows nothing for a message without a payload entity", () => {
    preview({ hasPayload: false, entity: undefined, schema: null });
    expect(screen.queryByTestId("payload-preview")).toBeNull();
  });
});
