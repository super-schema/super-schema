/**
 * The selected-field panel of the entity page: choosing the `reference` type asks for the target (the same prompt as the field row),
 * the pick is saved with the panel's explicit Save as a fully qualified reference (id + qualified name, never a version, the pin of a
 * previous target dropped), and a field retyped away from `reference` is saved without its reference.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldQuickEditPanel } from "@/components/custom/FieldQuickEditPanel";
import type { PickableEntity } from "@/lib/references/entity-reference";

const TARGETS: PickableEntity[] = [
  { id: "e-addr", name: "Address", domain: "Billing", product: "Core" },
  { id: "e-cust", name: "Customer", domain: "Sales", product: "Crm" },
];

const base = {
  id: "f1", slug: "ship-to", name: "shipTo", type: "string", precision: null, scale: null, nullable: true, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [] as string[], sortOrder: 0,
};
const STRING_FIELD = { ...base, decorators: { keep: "me" } as Record<string, unknown> };
const REFERENCE_FIELD = {
  ...base,
  type: "reference",
  decorators: {
    keep: "me",
    referencedEntityId: "e-cust",
    referencedEntityName: "Customer",
    referencedQualifiedName: "Sales/Crm/Customer",
    referencedDomain: "Sales",
    referencedProduct: "Crm",
    referencedEntity: "Customer",
    referencedEntityVersion: "1.2",
  } as Record<string, unknown>,
};

type Update = (id: string, data: Record<string, unknown>) => Promise<void>;
const onUpdateField = vi.fn<Update>(async () => {});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function mount(field: typeof STRING_FIELD | typeof REFERENCE_FIELD, referenceTargets: PickableEntity[] | null = TARGETS) {
  return render(
    <FieldQuickEditPanel
      field={field}
      entityId="ent-1"
      domainSlug="payments"
      onUpdateField={onUpdateField as never}
      referenceTargets={referenceTargets ?? undefined}
    />,
  );
}

/** The panel's Data Type picker is the one whose trigger shows the field's current type. */
const openTypePicker = (current: string) => fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^${current}$`, "i") })[0]);
const search = (text: string) => fireEvent.change(screen.getByPlaceholderText("Search or type entity name..."), { target: { value: text } });
const confirm = () => fireEvent.click(screen.getByText(/Confirm ref/));
const save = async () => {
  fireEvent.click(await screen.findByTestId("field-save-btn"));
  await waitFor(() => expect(onUpdateField).toHaveBeenCalledTimes(1));
  return onUpdateField.mock.calls[0][1] as { type: string; decorators: Record<string, unknown> };
};
const referenceKeys = (d: Record<string, unknown>) => Object.keys(d).filter((k) => k.startsWith("referenced"));

describe("choosing the reference type in the selected-field panel", () => {
  it("asks for the target, shows it before saving, and saves the type with the qualified reference (no version)", async () => {
    mount(STRING_FIELD);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));
    search("Addr");
    fireEvent.click(screen.getByText("Billing / Core / Address"));
    confirm();

    expect(screen.getByTestId("field-reference-target").textContent).toContain("Billing / Core / Address");
    const data = await save();

    expect(data.type).toBe("reference");
    expect(data.decorators).toMatchObject({
      keep: "me",
      referencedEntityId: "e-addr",
      referencedEntityName: "Address",
      referencedQualifiedName: "Billing/Core/Address",
    });
    expect(data.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("a name that matches no entity is saved as a plain name", async () => {
    mount(STRING_FIELD);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));
    search("Elsewhere");
    confirm();

    const data = await save();

    expect(data.decorators).toMatchObject({ referencedEntityName: "Elsewhere" });
    expect(data.decorators).not.toHaveProperty("referencedEntityId");
  });

  it("re-pointing a pinned reference saves the new target WITHOUT the pin of the old one", async () => {
    mount(REFERENCE_FIELD);
    expect(screen.getByTestId("field-reference-target").textContent).toContain("Sales / Crm / Customer");
    openTypePicker("reference");
    // the picker's trigger and its grid row both read "reference": the row is the one in the open popover (last in the document)
    fireEvent.click(screen.getAllByText("reference").at(-1) as HTMLElement);
    search("Addr");
    fireEvent.click(screen.getByText("Billing / Core / Address"));
    confirm();

    const data = await save();

    expect(data.decorators).toMatchObject({ referencedEntityId: "e-addr", keep: "me" });
    expect(data.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("re-picking the SAME target of an unpinned reference changes nothing: the panel is not dirty (no Save, nothing to Discard)", async () => {
    const { referencedEntityVersion: _pin, ...unpinned } = REFERENCE_FIELD.decorators;
    void _pin;
    mount({ ...REFERENCE_FIELD, decorators: unpinned });
    openTypePicker("reference");
    fireEvent.click(screen.getAllByText("reference").at(-1) as HTMLElement);
    search("Customer");
    fireEvent.click(screen.getByText("Sales / Crm / Customer"));
    confirm();

    expect(screen.queryByTestId("field-save-btn")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    // the target on show is still the stored one
    expect(screen.getByTestId("field-reference-target").textContent).toContain("Sales / Crm / Customer");
  });

  it("re-picking the same target of a PINNED reference is a change (the pin goes): dirty, and saved without the pin", async () => {
    mount(REFERENCE_FIELD);
    openTypePicker("reference");
    fireEvent.click(screen.getAllByText("reference").at(-1) as HTMLElement);
    search("Customer");
    fireEvent.click(screen.getByText("Sales / Crm / Customer"));
    confirm();

    const data = await save();

    expect(data.decorators).toMatchObject({ referencedEntityId: "e-cust" });
    expect(data.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("a pick identical to the stored one after a DIFFERENT pick was made first is clean again", async () => {
    const { referencedEntityVersion: _pin, ...unpinned } = REFERENCE_FIELD.decorators;
    void _pin;
    mount({ ...REFERENCE_FIELD, decorators: unpinned });
    for (const [text, label] of [["Addr", "Billing / Core / Address"], ["Customer", "Sales / Crm / Customer"]]) {
      openTypePicker("reference");
      fireEvent.click(screen.getAllByText("reference").at(-1) as HTMLElement);
      search(text);
      fireEvent.click(screen.getByText(label));
      confirm();
      if (text === "Addr") expect(screen.getByTestId("field-save-btn")).toBeDefined();
    }

    expect(screen.queryByTestId("field-save-btn")).toBeNull();
  });

  it("an edit that leaves the reference alone keeps it and its pin", async () => {
    mount(REFERENCE_FIELD);
    fireEvent.click(screen.getByText("Add description..."));
    fireEvent.change(screen.getByPlaceholderText("Add description..."), { target: { value: "where it ships" } });

    const data = await save();

    expect(data.decorators).toMatchObject({ referencedEntityId: "e-cust", referencedEntityVersion: "1.2" });
  });

  it("Discard forgets a target that was only picked", async () => {
    mount(STRING_FIELD);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));
    search("Customer");
    confirm();
    expect(screen.getByTestId("field-reference-target")).toBeDefined();

    fireEvent.click(await screen.findByTestId("field-discard-btn"));

    expect(screen.queryByTestId("field-reference-target")).toBeNull();
    expect(screen.queryByTestId("field-save-btn")).toBeNull();
  });

  it("a reference picked and then replaced by another type is not saved", async () => {
    mount(STRING_FIELD);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));
    search("Customer");
    confirm();
    openTypePicker("reference");
    fireEvent.click(screen.getByText("integer"));

    const data = await save();

    expect(data.type).toBe("integer");
    expect(referenceKeys(data.decorators)).toEqual([]);
  });

  it("without a list of entities it is the plain type change, as before", async () => {
    mount(STRING_FIELD, null);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));

    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
    const data = await save();
    expect(data.type).toBe("reference");
    expect(referenceKeys(data.decorators)).toEqual([]);
  });
});

describe("retyping a reference field in the selected-field panel", () => {
  it("is saved without the target, its id and its pin", async () => {
    mount(REFERENCE_FIELD);
    openTypePicker("reference");
    fireEvent.click(screen.getByText("string"));

    const data = await save();

    expect(data.type).toBe("string");
    expect(referenceKeys(data.decorators)).toEqual([]);
    expect(data.decorators).toMatchObject({ keep: "me" });
  });

  it("an array of references keeps its reference when other things are edited", async () => {
    const list = {
      ...base,
      type: "array",
      decorators: { arrayElementType: "reference", referencedEntityId: "e-cust", referencedEntityName: "Customer", referencedQualifiedName: "Sales/Crm/Customer", referencedEntityVersion: "1.0" },
    };
    mount(list as never);
    fireEvent.click(screen.getByText("Add description..."));
    fireEvent.change(screen.getByPlaceholderText("Add description..."), { target: { value: "many" } });

    const data = await save();

    expect(data.decorators).toMatchObject({ referencedEntityId: "e-cust", referencedEntityVersion: "1.0", arrayElementType: "reference" });
  });
});
