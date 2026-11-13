/**
 * D2 / D3: the dictionaries admin page shows a failure instead of swallowing it: a write whose action rejects shows an error (and frees the
 * buttons), and the usage drawer shows an error instead of a stuck "Loading...".
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  overview: vi.fn(), usage: vi.fn(), deleteField: vi.fn(),
}));
vi.mock("@/app/(dashboard)/admin/settings/dictionaries/actions", () => ({
  dictionariesOverviewAction: h.overview,
  fieldEntryUsageAction: h.usage,
  deleteFieldEntryAction: h.deleteField,
  createFieldEntryAction: vi.fn(),
  updateFieldEntryAction: vi.fn(),
  createAttributeAction: vi.fn(),
  updateAttributeAction: vi.fn(),
  deleteAttributeAction: vi.fn(),
  installPackAction: vi.fn(),
  uninstallPackAction: vi.fn(),
}));

import { DictionariesAdmin } from "@/components/custom/admin/DictionariesAdmin";

const ENTRY = {
  id: "d1", tenantId: "t1", name: "email", aliases: [], type: "string", description: "", classification: null, attributes: {},
  conceptId: null, createdAt: new Date(), updatedAt: new Date(),
};
const INITIAL = { fields: [ENTRY], usage: { d1: 2 }, attributes: [], packs: [] };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  quiet.mockRestore();
});

describe("DictionariesAdmin failures", () => {
  it("a write whose action rejects shows an error and frees the buttons (D2)", async () => {
    h.deleteField.mockRejectedValue(new Error("network down"));
    render(<DictionariesAdmin initial={INITIAL} />);
    const del = screen.getByRole("button", { name: "Delete email" });
    fireEvent.click(del);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be completed|try again/i);
    expect(alert.textContent).not.toContain("network down");
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete email" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("the usage drawer shows an error when the usage action rejects, not a stuck Loading (D3)", async () => {
    h.usage.mockRejectedValue(new Error("boom"));
    render(<DictionariesAdmin initial={INITIAL} />);
    fireEvent.click(screen.getByRole("button", { name: "Usage of email" }));
    await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be loaded/i);
    expect(alert.textContent).not.toContain("boom");
  });
});
