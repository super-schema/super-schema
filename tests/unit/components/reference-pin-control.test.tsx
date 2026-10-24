/**
 * The pin control on a reference field: choose one of the referenced entity's PUBLISHED versions, or "Latest published (no pin)". A pin is
 * the only thing that stores a version on a reference; unpinning removes it. Drafts are never offered.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { ReferencePinControl, type ReferenceFieldControls } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ReferencePinControl";
import { FieldCard } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/FieldCard";

const listPublishedVersions = vi.fn();
const setPin = vi.fn();
const controls: ReferenceFieldControls = {
  listPublishedVersions: (entityId) => listPublishedVersions(entityId),
  setPin: (args) => setPin(args),
};

beforeEach(() => {
  vi.clearAllMocks();
  listPublishedVersions.mockResolvedValue({ labels: ["2.1", "2.0", "1.0"] });
  setPin.mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount(over: Partial<React.ComponentProps<typeof ReferencePinControl>> = {}) {
  return render(
    <ReferencePinControl fieldId="fld-1" referencedEntityId="ent-addr" referenceLabel="Billing / Core / Address" controls={controls} {...over} />,
  );
}

const optionLabels = () => Array.from((screen.getByTestId("reference-pin-control") as HTMLSelectElement).options).map((o) => [o.value, o.textContent]);

describe("ReferencePinControl", () => {
  it("shows no pin badge for an unpinned reference and loads nothing until it is opened", () => {
    mount();
    expect(screen.queryByTestId("reference-pin-badge")).toBeNull();
    expect(screen.queryByTestId("reference-pin-control")).toBeNull();
    expect(listPublishedVersions).not.toHaveBeenCalled();
  });

  it("the open button's accessible name starts with its visible text and says which reference it is about", () => {
    const { rerender } = mount();
    const open = screen.getByTestId("reference-pin-open");
    expect(open.textContent).toBe("Pin version");
    expect(open.getAttribute("aria-label")).toBe("Pin version of Billing / Core / Address");

    rerender(<ReferencePinControl fieldId="fld-1" referencedEntityId="ent-addr" referenceLabel="Billing / Core / Address" controls={controls} pinnedVersion="1.0" />);
    expect(screen.getByTestId("reference-pin-open").textContent).toBe("Change pin");
    expect(screen.getByTestId("reference-pin-open").getAttribute("aria-label")).toBe("Change pin of Billing / Core / Address");
  });

  it("announces the loading of the versions as a status, with the icon hidden from assistive technology", async () => {
    let finish: (v: { labels: string[] }) => void = () => {};
    listPublishedVersions.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mount();

    fireEvent.click(screen.getByTestId("reference-pin-open"));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Loading versions");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    finish({ labels: ["1.0"] });
    await screen.findByTestId("reference-pin-control");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers the referenced entity's published versions and 'Latest published (no pin)', and nothing else", async () => {
    mount();

    fireEvent.click(screen.getByTestId("reference-pin-open"));

    await screen.findByTestId("reference-pin-control");
    expect(listPublishedVersions).toHaveBeenCalledTimes(1);
    expect(listPublishedVersions).toHaveBeenCalledWith("ent-addr");
    expect(optionLabels()).toEqual([
      ["", "Latest published (no pin)"],
      ["2.1", "v2.1"],
      ["2.0", "v2.0"],
      ["1.0", "v1.0"],
    ]);
    expect((screen.getByTestId("reference-pin-control") as HTMLSelectElement).value).toBe("");
  });

  it("pins the chosen version through the action and shows it as a badge", async () => {
    mount();
    fireEvent.click(screen.getByTestId("reference-pin-open"));
    const select = (await screen.findByTestId("reference-pin-control")) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "2.0" } });

    await waitFor(() => expect(setPin).toHaveBeenCalledTimes(1));
    expect(setPin).toHaveBeenCalledWith({ fieldId: "fld-1", referencedEntityId: "ent-addr", pinnedVersion: "2.0" });
    expect((await screen.findByTestId("reference-pin-badge")).textContent).toContain("v2.0");
    expect(screen.queryByTestId("reference-pin-control")).toBeNull();
  });

  it("shows the current pin as a badge and preselects it", async () => {
    mount({ pinnedVersion: "1.0" });
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.0");

    fireEvent.click(screen.getByTestId("reference-pin-open"));

    expect(((await screen.findByTestId("reference-pin-control")) as HTMLSelectElement).value).toBe("1.0");
  });

  it("unpins with null when 'Latest published (no pin)' is chosen, and the badge goes", async () => {
    mount({ pinnedVersion: "1.0" });
    fireEvent.click(screen.getByTestId("reference-pin-open"));
    const select = (await screen.findByTestId("reference-pin-control")) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ fieldId: "fld-1", referencedEntityId: "ent-addr", pinnedVersion: null }));
    await waitFor(() => expect(screen.queryByTestId("reference-pin-badge")).toBeNull());
  });

  it("follows the pin the field carries when it changes (the server re-rendered it)", () => {
    const { rerender } = mount({ pinnedVersion: "1.0" });
    rerender(<ReferencePinControl fieldId="fld-1" referencedEntityId="ent-addr" controls={controls} pinnedVersion="2.1" />);
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v2.1");
    rerender(<ReferencePinControl fieldId="fld-1" referencedEntityId="ent-addr" controls={controls} />);
    expect(screen.queryByTestId("reference-pin-badge")).toBeNull();
  });

  it("says so, and offers only 'no pin', for an entity that was never published", async () => {
    listPublishedVersions.mockResolvedValue({ labels: [] });
    mount();

    fireEvent.click(screen.getByTestId("reference-pin-open"));

    await screen.findByTestId("reference-pin-control");
    expect(optionLabels()).toEqual([["", "Latest published (no pin)"]]);
    expect(screen.getByTestId("reference-pin-none-published").textContent).toMatch(/never been published/i);
  });

  it("shows why the versions could not be loaded, without a select", async () => {
    listPublishedVersions.mockResolvedValue({ error: "Entity not found" });
    mount();

    fireEvent.click(screen.getByTestId("reference-pin-open"));

    expect((await screen.findByRole("alert")).textContent).toBe("Entity not found");
    expect(screen.queryByTestId("reference-pin-control")).toBeNull();
  });

  it("shows a refused pin and keeps the previous one", async () => {
    setPin.mockResolvedValue({ error: "Address has no published version 2.0" });
    mount({ pinnedVersion: "1.0" });
    fireEvent.click(screen.getByTestId("reference-pin-open"));
    fireEvent.change(await screen.findByTestId("reference-pin-control"), { target: { value: "2.0" } });

    expect((await screen.findByRole("alert")).textContent).toBe("Address has no published version 2.0");
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.0");
  });

  it("is a badge only when read-only (nothing to open), and nothing at all when read-only and unpinned", () => {
    const { rerender } = mount({ pinnedVersion: "1.0", disabled: true });
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.0");
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();

    rerender(<ReferencePinControl fieldId="fld-1" referencedEntityId="ent-addr" controls={controls} disabled />);
    expect(screen.queryByTestId("reference-pin-badge")).toBeNull();
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();
  });
});

describe("FieldCard reference fields", () => {
  const FIELD = {
    id: "f9", slug: "billing-address", name: "billingAddress", type: "reference", precision: null, scale: null, nullable: true, isKey: false,
    fieldNumber: null, description: "", classification: null, aliases: [], sortOrder: 0,
    decorators: {
      referencedEntityId: "ent-addr",
      referencedEntityName: "Address",
      referencedQualifiedName: "Billing/Core/Address",
      referencedEntityVersion: "1.2",
    },
  };
  const handlers = { onFieldSelect: vi.fn(), onUpdateField: vi.fn(async () => {}), onDeleteField: vi.fn(async () => {}), onNavigateStudio: vi.fn() };

  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
  });

  function card(over: Partial<React.ComponentProps<typeof FieldCard>> = {}) {
    return (
      <DndContext>
        <SortableContext items={["f9"]}>
          <FieldCard field={FIELD} index={0} isSelected={false} isReadOnly={false} referenceControls={controls} {...handlers} {...over} />
        </SortableContext>
      </DndContext>
    );
  }

  it("shows the reference as domain / product / entity and its pin control, with the pinned version as a badge", () => {
    render(card());

    expect(screen.getByText("ref(Billing / Core / Address)")).toBeDefined();
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.2");
    expect(screen.getByTestId("reference-pin-open")).toBeDefined();
  });

  it("has the pin control on an array of references and a map of references too", () => {
    const decorators = { ...FIELD.decorators, arrayElementType: "reference", mapValueType: "reference" };
    const { rerender } = render(card({ field: { ...FIELD, type: "array", decorators } }));
    expect(screen.getByTestId("reference-pin-open")).toBeDefined();
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.2");

    rerender(card({ field: { ...FIELD, type: "map", decorators } }));
    expect(screen.getByTestId("reference-pin-open")).toBeDefined();
  });

  it("an array of something else shows no pin, even when it still carries a stale reference", () => {
    render(card({ field: { ...FIELD, type: "array", decorators: { ...FIELD.decorators, arrayElementType: "string" } } }));
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();
    expect(screen.queryByTestId("reference-pin-badge")).toBeNull();
  });

  it("opening the pin control asks for the REFERENCED entity's versions and pins on THIS field", async () => {
    render(card());
    fireEvent.click(screen.getByTestId("reference-pin-open"));
    fireEvent.change(await screen.findByTestId("reference-pin-control"), { target: { value: "2.0" } });

    expect(listPublishedVersions).toHaveBeenCalledWith("ent-addr");
    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ fieldId: "f9", referencedEntityId: "ent-addr", pinnedVersion: "2.0" }));
  });

  it("has no pin control for a legacy name-only reference (nothing to pin until it is qualified), and keeps its old display", () => {
    render(card({ field: { ...FIELD, decorators: { referencedEntityName: "Address" } } }));

    expect(screen.getByText("ref(Address)")).toBeDefined();
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();
    expect(screen.queryByTestId("reference-pin-badge")).toBeNull();
  });

  it("has no pin control for another type, or when no controls are wired", () => {
    const { rerender } = render(card({ field: { ...FIELD, type: "string", decorators: {} } }));
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();

    rerender(card({ referenceControls: undefined }));
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();
    // without controls the pin is still SHOWN
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.2");
  });

  it("is read-only on a read-only entity", () => {
    render(card({ isReadOnly: true }));
    expect(screen.getByTestId("reference-pin-badge").textContent).toContain("v1.2");
    expect(screen.queryByTestId("reference-pin-open")).toBeNull();
  });
});
