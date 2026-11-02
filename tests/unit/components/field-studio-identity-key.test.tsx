/**
 * The Field Studio's @key checkbox is the field's key: ticking it saves Field.isKey (and the key is required, so the field is not
 * optional), unticking it clears it, and the checkbox shows the column, the source of truth the generator and the source sync read,
 * so a key stored before the studio opened (the quick editor and the primary-key dialog write only the column) is shown and kept by
 * an unrelated save. A key set after the studio opened is not shown until it reloads, and the next save writes the checkbox back.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldStudio } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio";

const update = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({ updateFieldAction: update }));

const base = {
  id: "f1", name: "id", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [] as string[],
};
const ENTITY = { id: "ent-1", name: "Order", slug: "order", domainSlug: "payments", productSlug: "checkout" };
const DOMAIN = { name: "Payments", policy: null };
const TEST_TIMEOUT = 15_000;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  // The studio keeps which panels are open in localStorage.
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ success: true });
});
afterEach(cleanup);

function mount(field: typeof base & { decorators: Record<string, unknown> }) {
  return render(<FieldStudio field={field} entity={ENTITY} domain={DOMAIN} />);
}
const keyCheckbox = () => screen.getByRole("checkbox", { name: "@key" }) as HTMLInputElement;
const optionalCheckbox = () => screen.getByRole("checkbox", { name: /Optional/ }) as HTMLInputElement;
const rename = (value: string) => fireEvent.change(screen.getByTestId("field-studio-name"), { target: { value } });
/** The autosave fires after its debounce: wait for it and read what it wrote. */
async function saved() {
  await waitFor(() => expect(update).toHaveBeenCalled(), { timeout: 3000 });
  expect(update).toHaveBeenCalledTimes(1);
  return update.mock.calls[0][1] as { isKey: boolean; nullable: boolean; decorators: { typespec?: { identity?: { key?: boolean } } } };
}

describe("Field Studio: the @key checkbox", () => {
  it("ticking @key saves the field as a key, required, with the decorator mirror set", async () => {
    mount({ ...base, decorators: {} });
    expect(keyCheckbox().checked).toBe(false);

    fireEvent.click(keyCheckbox());
    const data = await saved();

    expect(data.isKey).toBe(true);
    expect(data.nullable).toBe(false);
    expect(data.decorators.typespec?.identity?.key).toBe(true);
  }, TEST_TIMEOUT);

  it("a key stored when the studio opens shows ticked, and an unrelated save keeps it", async () => {
    mount({ ...base, isKey: true, nullable: false, decorators: {} });
    expect(keyCheckbox().checked).toBe(true);

    rename("orderId");
    const data = await saved();

    expect(data.isKey).toBe(true);
    expect(data.nullable).toBe(false);
    expect(data.decorators.typespec?.identity?.key).toBe(true);
  }, TEST_TIMEOUT);

  it("a key set elsewhere after the studio opened is written back as the checkbox shows it: the studio saves the whole field", async () => {
    const view = mount({ ...base, isKey: false, nullable: true, decorators: {} });
    // Another tab (or the primary-key dialog) makes the field a key while this studio stays open.
    view.rerender(<FieldStudio field={{ ...base, isKey: true, nullable: false, decorators: {} }} entity={ENTITY} domain={DOMAIN} />);
    expect(keyCheckbox().checked).toBe(false);

    rename("orderId");
    const data = await saved();

    expect(data.isKey).toBe(false);
    // No mirror was ever written for this field (it is undefined, not false): what matters is that the mirror does not say key.
    expect(data.decorators.typespec?.identity?.key).not.toBe(true);
  }, TEST_TIMEOUT);

  it("a key stored as optional is shown and saved as required", async () => {
    mount({ ...base, isKey: true, nullable: true, decorators: {} });
    expect(optionalCheckbox().checked).toBe(false);

    rename("orderId");
    const data = await saved();

    expect(data.isKey).toBe(true);
    expect(data.nullable).toBe(false);
  }, TEST_TIMEOUT);

  it("unticking @key saves the field as not a key", async () => {
    mount({ ...base, isKey: true, nullable: false, decorators: { typespec: { identity: { key: true } } } });

    fireEvent.click(keyCheckbox());
    const data = await saved();

    expect(data.isKey).toBe(false);
    expect(data.decorators.typespec?.identity?.key).toBe(false);
  }, TEST_TIMEOUT);

  it("a stale decorator mirror that disagrees with the column does not make the field a key", async () => {
    mount({ ...base, isKey: false, decorators: { typespec: { identity: { key: true } } } });
    expect(keyCheckbox().checked).toBe(false);

    rename("orderId");
    const data = await saved();

    expect(data.isKey).toBe(false);
    expect(data.decorators.typespec?.identity?.key).toBe(false);
  }, TEST_TIMEOUT);
});
