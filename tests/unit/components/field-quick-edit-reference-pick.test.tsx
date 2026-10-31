/**
 * The selected-field panel of the entity page: choosing the `reference` type asks for the target (the same prompt as the field row),
 * the pick is saved with the panel's explicit Save as a fully qualified reference (id + qualified name, never a version, the pin of a
 * previous target dropped), and a field retyped away from `reference` is saved without its reference.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
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
beforeEach(() => {
  vi.clearAllMocks();
  onUpdateField.mockReset();
  onUpdateField.mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount(field: typeof STRING_FIELD | typeof REFERENCE_FIELD, referenceTargets: PickableEntity[] | null = TARGETS, overrides: Partial<ComponentProps<typeof FieldQuickEditPanel>> = {}) {
  return render(
    <FieldQuickEditPanel
      field={field}
      entityId="ent-1"
      domainSlug="payments"
      onUpdateField={onUpdateField as never}
      referenceTargets={referenceTargets ?? undefined}
      {...overrides}
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

describe("selected-field editing safety", () => {
  const editDescription = (value: string) => {
    if (!screen.queryByLabelText("Field description")) fireEvent.click(screen.getByText("Add description..."));
    fireEvent.change(screen.getByLabelText("Field description"), { target: { value } });
  };

  it("registers save/discard handlers and releases them when the panel unmounts", () => {
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const discardRef = { current: null as (() => void) | null };
    const { unmount } = mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, fieldDiscardRef: discardRef });
    expect(saveRef.current).toBeTypeOf("function");
    expect(discardRef.current).toBeTypeOf("function");
    unmount();
    expect(saveRef.current).toBeNull();
    expect(discardRef.current).toBeNull();
  });

  it("keeps rejected edits dirty and offers a working retry before server props refresh", async () => {
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const onDirtyChange = vi.fn();
    onUpdateField.mockRejectedValueOnce(new Error("Write rejected"));
    mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, onDirtyChange });
    editDescription("unsaved description");
    let result: boolean | undefined;
    await act(async () => { result = await saveRef.current!(); });
    expect(result).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Write rejected");
    expect(screen.getByRole("button", { name: "Retry save" })).toBeDefined();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => { result = await saveRef.current!(); });
    expect(result).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("field-save-btn")).toBeNull();
    expect(onUpdateField).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous shortcut and navigation saves into one write", async () => {
    let resolve!: () => void;
    onUpdateField.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef });
    editDescription("one write");
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = saveRef.current!();
      second = saveRef.current!();
    });
    expect(onUpdateField).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    let results: boolean[] = [];
    await act(async () => { resolve(); results = await Promise.all([first, second]); });
    expect(results).toEqual([true, true]);
  });

  it("keeps newer input when an older save response refreshes props and refuses to leave", async () => {
    let resolve!: () => void;
    onUpdateField.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const onDirtyChange = vi.fn();
    const { rerender } = mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, onDirtyChange });
    editDescription("submitted description");
    let pending!: Promise<boolean>;
    act(() => { pending = saveRef.current!(); });
    editDescription("newer description");
    rerender(<FieldQuickEditPanel field={{ ...STRING_FIELD, description: "submitted description" }} entityId="ent-1" domainSlug="payments" onUpdateField={onUpdateField as never} fieldSaveRef={saveRef} onDirtyChange={onDirtyChange} />);
    let result: boolean | undefined;
    await act(async () => { resolve(); result = await pending; });
    expect(result).toBe(false);
    expect((screen.getByLabelText("Field description") as HTMLTextAreaElement).value).toBe("newer description");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => { result = await saveRef.current!(); });
    expect(result).toBe(true);
    expect((screen.getByLabelText("Field description") as HTMLTextAreaElement).value).toBe("newer description");
    expect(onUpdateField.mock.calls[1][1]).toMatchObject({ description: "newer description" });
  });

  it("preserves a refreshed inline rename while saving a different local control", async () => {
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const { rerender } = mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef });
    editDescription("my local description");
    rerender(<FieldQuickEditPanel field={{ ...STRING_FIELD, name: "renamedShipTo" }} entityId="ent-1" domainSlug="payments" onUpdateField={onUpdateField as never} fieldSaveRef={saveRef} />);
    expect(screen.getByText("renamedShipTo")).toBeDefined();
    await act(async () => { await saveRef.current!(); });
    expect(onUpdateField.mock.calls[0][1]).toMatchObject({ name: "renamedShipTo", description: "my local description" });
  });

  it("merges independent nested decorator controls from a same-field refresh", async () => {
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const { rerender } = mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef });
    fireEvent.click(screen.getByRole("button", { name: "Constraints" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Partition/ }));
    const incoming = { ...STRING_FIELD, decorators: { keep: "me", typespec: { governance: { operationalHints: { index: true } } } } };
    rerender(<FieldQuickEditPanel field={incoming} entityId="ent-1" domainSlug="payments" onUpdateField={onUpdateField as never} fieldSaveRef={saveRef} />);
    await act(async () => { await saveRef.current!(); });
    expect(onUpdateField.mock.calls[0][1]).toMatchObject({ decorators: { typespec: { governance: { operationalHints: { partition: true, index: true } } } } });
  });

  it("reports footer saves as busy and stays protected after reverting to the old baseline", async () => {
    let resolve!: () => void;
    onUpdateField.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const discardRef = { current: null as (() => void) | null };
    const onDirtyChange = vi.fn();
    const onSavingChange = vi.fn();
    mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, fieldDiscardRef: discardRef, onDirtyChange, onSavingChange });
    editDescription("submitted B");
    fireEvent.click(screen.getByTestId("field-save-btn"));
    const pending = saveRef.current!();
    expect(onSavingChange).toHaveBeenLastCalledWith(true);
    editDescription("newer C");
    act(() => { discardRef.current!(); });
    expect((screen.getByLabelText("Field description") as HTMLTextAreaElement).value).toBe("newer C");
    editDescription("");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByTestId("field-discard-btn")).toBeNull();
    let result: boolean | undefined;
    await act(async () => { resolve(); result = await pending; });
    expect(result).toBe(false);
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("field-save-btn")).toBeDefined();
  });

  it("treats server normalization during a save as persisted rather than new local edits", async () => {
    let resolve!: () => void;
    onUpdateField.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const onDirtyChange = vi.fn();
    const { rerender } = mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, onDirtyChange });
    editDescription("submitted description");
    let pending!: Promise<boolean>;
    act(() => { pending = saveRef.current!(); });
    const incoming = { ...STRING_FIELD, description: "submitted description", decorators: { keep: "me", typespec: { identity: { format: null }, documentation: {} } } };
    rerender(<FieldQuickEditPanel field={incoming} entityId="ent-1" domainSlug="payments" onUpdateField={onUpdateField as never} fieldSaveRef={saveRef} onDirtyChange={onDirtyChange} />);
    let result: boolean | undefined;
    await act(async () => { resolve(); result = await pending; });
    expect(result).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("field-save-btn")).toBeNull();
  });

  it("ignores an unmounted panel's completion while another field is saving", async () => {
    let resolveOld!: () => void;
    let resolveNew!: () => void;
    onUpdateField.mockImplementationOnce(() => new Promise<void>((done) => { resolveOld = done; }));
    onUpdateField.mockImplementationOnce(() => new Promise<void>((done) => { resolveNew = done; }));
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const onDirtyChange = vi.fn();
    const onSavingChange = vi.fn();
    const old = mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, onDirtyChange, onSavingChange });
    editDescription("old field edit");
    let oldPending!: Promise<boolean>;
    act(() => { oldPending = saveRef.current!(); });
    old.unmount();
    mount({ ...STRING_FIELD, id: "f2", name: "secondField" }, TARGETS, { fieldSaveRef: saveRef, onDirtyChange, onSavingChange });
    editDescription("new field edit");
    let newPending!: Promise<boolean>;
    act(() => { newPending = saveRef.current!(); });
    onDirtyChange.mockClear();
    onSavingChange.mockClear();
    let oldResult: boolean | undefined;
    await act(async () => { resolveOld(); oldResult = await oldPending; });
    expect(oldResult).toBe(false);
    expect(onDirtyChange).not.toHaveBeenCalled();
    expect(onSavingChange).not.toHaveBeenCalled();
    await act(async () => { resolveNew(); await newPending; });
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("Escape dismisses the discard question while keeping the local edits", async () => {
    mount(STRING_FIELD);
    editDescription("keep these edits");
    fireEvent.click(screen.getByTestId("field-discard-btn"));
    expect(await screen.findByRole("dialog")).toBeDefined();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("field-edit-panel").textContent).toContain("keep these edits");
    expect(screen.getByTestId("field-save-btn")).toBeDefined();
    expect(onUpdateField).not.toHaveBeenCalled();
  });

  it("discard returns to the last successful save even before refreshed props arrive", async () => {
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const discardRef = { current: null as (() => void) | null };
    const onDirtyChange = vi.fn();
    mount(STRING_FIELD, TARGETS, { fieldSaveRef: saveRef, fieldDiscardRef: discardRef, onDirtyChange });
    editDescription("saved description");
    await act(async () => { await saveRef.current!(); });
    editDescription("discard this edit");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    act(() => { discardRef.current!(); });
    expect((screen.getByLabelText("Field description") as HTMLTextAreaElement).value).toBe("saved description");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

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
    fireEvent.click(await screen.findByTestId("field-confirm-discard"));

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
