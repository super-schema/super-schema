// @vitest-environment jsdom
// tests/unit/features/events/builder/properties-pinned-note.test.tsx
// A trait whose headers come from an entity pin (legacy) has no inline rows: the table says where its properties come from instead
// of "No properties", so such a trait never reads as empty. Everything else about the empty states is unchanged.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PropertiesTable } from "@/features/events/builder/sections/PropertiesTable";
import { pinnedHeaders } from "@/features/events/builder/traits";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";

afterEach(cleanup);

const text = (testId: string) => screen.getByTestId(testId).textContent;
const missing = (testId: string) => screen.queryByTestId(testId) === null;

const PINNED = { name: "OrderCancelled", versionLabel: "1.0", href: "/schemas/payments/checkout/order-cancelled" };
const ONE_ROW = { type: "object", properties: { source: { type: "string" } } };

describe("PropertiesTable: pinned headers as the empty state", () => {
  it.each([
    ["editable", { onChange: () => undefined }],
    ["read-only", { readOnly: true }],
  ])("%s: names the entity and its version, linked, where it would say there are no properties", (_, mode) => {
    render(<PropertiesTable idPrefix="t" headers={undefined} pinned={PINNED} {...mode} />);
    expect(text("t-pin-note")).toBe("Properties come from the entity OrderCancelled v1.0.");
    const link = screen.getByRole("link", { name: "OrderCancelled" });
    expect(link.getAttribute("href")).toBe("/schemas/payments/checkout/order-cancelled");
    expect(link.closest("[data-testid=t-pin-note]")).not.toBeNull();
    expect(missing("t-empty")).toBe(true);
    expect(screen.queryByText(/No properties/)).toBeNull();
  });

  it("leaves the version out when it is not known (an older pin, or none), and the link out when there is no address", () => {
    render(<PropertiesTable idPrefix="t" headers={{ type: "object", properties: {} }} pinned={{ name: "OrderCancelled", versionLabel: null, href: null }} readOnly />);
    expect(text("t-pin-note")).toBe("Properties come from the entity OrderCancelled.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("is only the empty state: with inline rows the table shows them and the note is not repeated by the table", () => {
    render(<PropertiesTable idPrefix="t" headers={ONE_ROW} pinned={PINNED} onChange={() => undefined} />);
    expect(missing("t-pin-note")).toBe(true);
    expect((screen.getByTestId("t-name-0") as HTMLInputElement).value).toBe("source");
  });

  it("keeps the editable Add button under the note", () => {
    render(<PropertiesTable idPrefix="t" headers={undefined} pinned={PINNED} onChange={() => undefined} />);
    expect(screen.getByTestId("t-add")).toBeTruthy();
  });

  it("without a pin the empty states read as before", () => {
    const { rerender } = render(<PropertiesTable idPrefix="t" headers={undefined} readOnly />);
    expect(text("t-empty")).toBe("No properties.");
    rerender(<PropertiesTable idPrefix="t" headers={undefined} onChange={() => undefined} />);
    expect(text("t-empty")).toBe("No properties yet. Add the ones every message carries.");
    expect(missing("t-pin-note")).toBe(true);
  });
});

describe("pinnedHeaders: what the table needs to describe a headers pin", () => {
  const options: EntityOption[] = [
    { id: "e1", name: "OrderCancelled", ownerLabel: "Payments / Checkout", latestVersionId: "v10", latestVersionLabel: "1.0", href: "/schemas/payments/checkout/order-cancelled" },
    { id: "e2", name: "CloudEventsHeaders", ownerLabel: "Enterprise", latestVersionId: null, latestVersionLabel: null },
  ];

  it("is nothing without a pin", () => {
    expect(pinnedHeaders(undefined, options)).toBeUndefined();
  });

  it("names the entity, labels the version it points at and carries the entity's address", () => {
    expect(pinnedHeaders({ entityId: "e1", entityVersionId: "v10" }, options)).toEqual(PINNED);
  });

  it("knows a version label only for the latest version of the entity", () => {
    expect(pinnedHeaders({ entityId: "e1", entityVersionId: "v09" }, options)).toEqual({ ...PINNED, versionLabel: null });
  });

  it("an explicitly unpinned version has no label", () => {
    expect(pinnedHeaders({ entityId: "e1", entityVersionId: null }, options)).toEqual({ ...PINNED, versionLabel: null });
  });

  it("an entity without an address is named without a link", () => {
    expect(pinnedHeaders({ entityId: "e2", entityVersionId: null }, options)).toEqual({ name: "CloudEventsHeaders", versionLabel: null, href: null });
  });

  it("an entity the options do not offer any more is named by its id", () => {
    expect(pinnedHeaders({ entityId: "gone", entityVersionId: "v1" }, options)).toEqual({ name: "gone", versionLabel: null, href: null });
  });
});
