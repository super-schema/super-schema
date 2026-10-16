// @vitest-environment jsdom
// tests/unit/features/events/builder/properties-pinned-note.test.tsx
// A trait whose headers come from an entity pin (legacy): the table itself says where the properties come from, in both states. With no
// rows it replaces "No properties"; with rows (including a row just added and not named yet) it is a line under the table. One place
// decides which, so the note never disappears mid-edit. Everything else about the empty states is unchanged.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("with inline rows the table shows them and keeps the pin as a line under it", () => {
    render(<PropertiesTable idPrefix="t" headers={ONE_ROW} pinned={PINNED} onChange={() => undefined} />);
    expect((screen.getByTestId("t-name-0") as HTMLInputElement).value).toBe("source");
    expect(text("t-pin-note")).toBe("Headers also come from the entity OrderCancelled v1.0.");
    expect(screen.getAllByTestId("t-pin-note")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "OrderCancelled" }).getAttribute("href")).toBe("/schemas/payments/checkout/order-cancelled");
  });

  it("read-only with rows keeps the pin line too", () => {
    render(<PropertiesTable idPrefix="t" headers={ONE_ROW} pinned={PINNED} readOnly />);
    expect(screen.getByTestId("t-row-source")).toBeTruthy();
    expect(text("t-pin-note")).toBe("Headers also come from the entity OrderCancelled v1.0.");
  });

  it("a freshly added, still unnamed row (not in the headers yet) does not make the note go away", () => {
    // The caller's headers stay empty until the row has a name: only the table knows it has a row.
    render(<PropertiesTable idPrefix="t" headers={undefined} pinned={PINNED} onChange={() => undefined} />);
    expect(text("t-pin-note")).toBe("Properties come from the entity OrderCancelled v1.0.");
    fireEvent.click(screen.getByTestId("t-add"));
    expect((screen.getByTestId("t-name-0") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByTestId("t-pin-note")).toHaveLength(1);
    expect(text("t-pin-note")).toBe("Headers also come from the entity OrderCancelled v1.0.");
    // and back: remove the row and the empty-state wording returns
    fireEvent.click(screen.getByTestId("t-remove-0"));
    expect(text("t-pin-note")).toBe("Properties come from the entity OrderCancelled v1.0.");
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
