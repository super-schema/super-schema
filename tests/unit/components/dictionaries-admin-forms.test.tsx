/**
 * U4 / U9: the dictionaries admin page confirms tenant-wide removals (entry delete, definition delete, pack uninstall) before running them,
 * and its Fields form reuses the schema type picker, including type descriptions and tenant-defined types.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  overview: vi.fn(), deleteField: vi.fn(), deleteAttr: vi.fn(), uninstall: vi.fn(), createField: vi.fn(),
}));
vi.mock("@/app/(dashboard)/admin/settings/dictionaries/actions", () => ({
  dictionariesOverviewAction: h.overview,
  fieldEntryUsageAction: vi.fn(),
  deleteFieldEntryAction: h.deleteField,
  createFieldEntryAction: h.createField,
  updateFieldEntryAction: vi.fn(),
  createAttributeAction: vi.fn(),
  updateAttributeAction: vi.fn(),
  deleteAttributeAction: h.deleteAttr,
  installPackAction: vi.fn(),
  uninstallPackAction: h.uninstall,
}));

import { DictionariesAdmin } from "@/components/custom/admin/DictionariesAdmin";

const ENTRY = {
  id: "d1", tenantId: "t1", name: "email", aliases: [], type: "string", description: "", classification: null, attributes: {},
  conceptId: null, createdAt: new Date(), updatedAt: new Date(),
};
const ATTR = {
  id: "a1", tenantId: "t1", key: "x-note", label: "Note", description: "", valueSchema: { type: "string" }, targets: ["field"], scope: "schema",
  placement: "field", derive: null, requiredWhen: "never", pack: null, protobufOptionNumber: 50000, createdAt: new Date(), updatedAt: new Date(),
} as const;
const PACK = { id: "p1", name: "Security pack", description: "", keys: ["x-sec"], installed: true };
const INITIAL = {
  fields: [ENTRY], usage: {}, attributes: [ATTR], packs: [PACK],
  formOptions: { levels: [{ name: "NEVER_STORED", classNumber: 1 }, { name: "PII", classNumber: 2 }, { name: "FINANCIAL", classNumber: 2 }], customTypes: ["Currency"] },
} as never;

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
  h.overview.mockResolvedValue({ data: INITIAL });
  for (const f of [h.deleteField, h.deleteAttr, h.uninstall, h.createField]) f.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("DictionariesAdmin confirmations (U4)", () => {
  it("asks before deleting a field entry; Cancel runs nothing, Delete runs the action", async () => {
    render(<DictionariesAdmin initial={INITIAL} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete email" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Delete "email"\?/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.deleteField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete email" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.deleteField).toHaveBeenCalledWith("d1"));
  });

  it("asks before deleting an attribute definition", async () => {
    render(<DictionariesAdmin initial={INITIAL} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Metadata attributes" }));
    fireEvent.click(screen.getByRole("tab", { name: "Metadata attributes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete x-note" }));
    const dialog = await screen.findByRole("dialog");
    expect(h.deleteAttr).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.deleteAttr).toHaveBeenCalledWith("a1"));
  });

  it("asks before uninstalling a pack, saying stored values remain", async () => {
    render(<DictionariesAdmin initial={INITIAL} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Metadata attributes" }));
    fireEvent.click(screen.getByRole("tab", { name: "Metadata attributes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall Security pack" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/stored values remain/i);
    expect(h.uninstall).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(h.uninstall).toHaveBeenCalledWith("p1"));
  });
});

describe("DictionariesAdmin Fields form (U9)", () => {
  it("Default classification is a select of the levels plus None", () => {
    render(<DictionariesAdmin initial={INITIAL} />);
    const select = screen.getByLabelText("Default classification") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(["None", "Class 1 — Never Stored", "Class 2 — PII", "FINANCIAL (Class 2)"]);
    expect(select.value).toBe("");
  });

  it("uses the schema type picker with built-in descriptions and selectable tenant-defined types", async () => {
    render(<DictionariesAdmin initial={INITIAL} />);
    const type = screen.getByLabelText("Type");
    expect(type.tagName).toBe("BUTTON");
    fireEvent.click(type);
    fireEvent.change(screen.getByPlaceholderText("Search types..."), { target: { value: "int32" } });
    expect(await screen.findByText("32-bit signed integer (most common)")).toBeDefined();
    fireEvent.click(screen.getByRole("option", { name: /^int32 / }));
    expect(type.textContent).toMatch(/int32/);

    fireEvent.click(type);
    fireEvent.change(screen.getByPlaceholderText("Search types..."), { target: { value: "Currency" } });
    fireEvent.click(await screen.findByRole("option", { name: /Currency/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "amount" } });
    fireEvent.change(screen.getByLabelText("Default classification"), { target: { value: "FINANCIAL" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(h.createField).toHaveBeenCalledWith(expect.objectContaining({ type: "Currency", classification: "FINANCIAL" })));
  });

  it("an entry whose stored classification is not a known level keeps it as an option", () => {
    render(<DictionariesAdmin initial={{ ...(INITIAL as object), fields: [{ ...ENTRY, classification: "LEGACY" }] } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit email" }));
    const select = screen.getByLabelText("Default classification") as HTMLSelectElement;
    expect(select.value).toBe("LEGACY");
  });
});
