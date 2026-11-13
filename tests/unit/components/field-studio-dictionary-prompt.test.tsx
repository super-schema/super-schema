/**
 * R11 / B1: "Save to field dictionary" on a clashing name. A tenant admin may confirm the overwrite; anyone else is told to ask a tenant admin
 * and is offered no overwrite button.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FieldStudio } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio";

const h = vi.hoisted(() => ({ update: vi.fn(), saveToDictionary: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  updateFieldAction: h.update,
  saveFieldToDictionaryAction: h.saveToDictionary,
}));

const FIELD = {
  id: "f1", name: "email", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [] as string[], decorators: {} as Record<string, unknown>,
};
const ENTITY = { id: "ent-1", name: "Order", slug: "order", domainSlug: "payments", productSlug: "checkout" };
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
beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockResolvedValue({ success: true });
});
afterEach(cleanup);

async function openPrompt() {
  render(<FieldStudio field={FIELD} entity={ENTITY} domain={DOMAIN} />);
  const trigger = screen.getByTestId("field-studio-actions");
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId("field-studio-save-to-dictionary"));
  return screen.findByTestId("field-studio-dictionary-confirm");
}

describe("FieldStudio: dictionary clash prompt (R11, B1)", () => {
  it("offers the overwrite to a tenant admin", async () => {
    h.saveToDictionary.mockResolvedValue({ needsConfirmation: true, code: "DUPLICATE_NAME", targetName: "email", matchedBy: "name", canOverwrite: true, error: 'This updates the dictionary entry "email".' });
    const dialog = await openPrompt();
    expect(dialog.textContent).toContain('This updates the dictionary entry "email".');
    expect(screen.getByTestId("field-studio-update-dictionary")).toBeDefined();
  });

  it("tells anyone else to ask a tenant admin, with no overwrite button", async () => {
    h.saveToDictionary.mockResolvedValue({
      needsConfirmation: true, code: "DUPLICATE_NAME", targetName: "email", matchedBy: "name", canOverwrite: false,
      error: 'The dictionary already has an entry "email". Ask a tenant admin to update the dictionary entry.',
    });
    const dialog = await openPrompt();
    expect(dialog.textContent).toContain("Ask a tenant admin to update the dictionary entry");
    expect(screen.queryByTestId("field-studio-update-dictionary")).toBeNull();
  });
});
