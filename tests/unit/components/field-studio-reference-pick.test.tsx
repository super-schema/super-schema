/**
 * The Field Studio page: choosing the `reference` type asks for the target (the same prompt as the field row), and the studio's
 * autosave writes the type with the fully qualified reference (id + qualified name, never a version, the old pin dropped); a field
 * retyped away from `reference` is saved without its reference.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldStudio } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/field-studio";
import type { PickableEntity } from "@/lib/references/entity-reference";

const update = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({ updateFieldAction: update }));

const TARGETS: PickableEntity[] = [
  { id: "e-addr", name: "Address", domain: "Billing", product: "Core" },
  { id: "e-cust", name: "Customer", domain: "Sales", product: "Crm" },
];

const base = {
  id: "f1", name: "shipTo", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [] as string[],
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
    referencedEntityVersion: "1.2",
  } as Record<string, unknown>,
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

function mount(field: typeof STRING_FIELD | typeof REFERENCE_FIELD, referenceTargets: PickableEntity[] | null = TARGETS) {
  return render(<FieldStudio field={field} entity={ENTITY} domain={DOMAIN} referenceTargets={referenceTargets ?? undefined} />);
}

const openTypePicker = (current: string) => fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^${current}$`, "i") })[0]);
const search = (text: string) => fireEvent.change(screen.getByPlaceholderText("Search or type entity name..."), { target: { value: text } });
const confirm = () => fireEvent.click(screen.getByText(/Confirm ref/));
/** The autosave fires after its debounce: wait for it and read what it wrote. */
async function saved() {
  await waitFor(() => expect(update).toHaveBeenCalled(), { timeout: 3000 });
  expect(update).toHaveBeenCalledTimes(1);
  return update.mock.calls[0][1] as { type: string; decorators: Record<string, unknown> };
}
const referenceKeys = (d: Record<string, unknown>) => Object.keys(d).filter((k) => k.startsWith("referenced"));

describe("Field Studio: choosing the reference type", () => {
  it("asks for the target and autosaves the type with the qualified reference, in ONE save (no version)", async () => {
    mount(STRING_FIELD);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));
    search("Addr");
    fireEvent.click(screen.getByText("Billing / Core / Address"));
    confirm();

    expect(screen.getByTestId("field-reference-target").textContent).toContain("Billing / Core / Address");
    const data = await saved();

    expect(update.mock.calls[0][0]).toBe("f1");
    expect(data.type).toBe("reference");
    expect(data.decorators).toMatchObject({ keep: "me", referencedEntityId: "e-addr", referencedEntityName: "Address", referencedQualifiedName: "Billing/Core/Address" });
    expect(data.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("re-pointing a pinned reference saves the new target without the old pin", async () => {
    mount(REFERENCE_FIELD);
    expect(screen.getByTestId("field-reference-target").textContent).toContain("Sales / Crm / Customer");
    openTypePicker("reference");
    // the picker's trigger and its grid row both read "reference": the row is the one in the open popover (last in the document)
    fireEvent.click(screen.getAllByText("reference").at(-1) as HTMLElement);
    search("Addr");
    fireEvent.click(screen.getByText("Billing / Core / Address"));
    confirm();

    const data = await saved();

    expect(data.decorators).toMatchObject({ referencedEntityId: "e-addr" });
    expect(data.decorators).not.toHaveProperty("referencedEntityVersion");
  });

  it("a field retyped away from reference is saved without the target, its id and its pin", async () => {
    mount(REFERENCE_FIELD);
    openTypePicker("reference");
    fireEvent.click(screen.getByText("integer"));

    const data = await saved();

    expect(data.type).toBe("integer");
    expect(referenceKeys(data.decorators)).toEqual([]);
    expect(data.decorators).toMatchObject({ keep: "me" });
  });

  it("a reference picked and then replaced by another type is not saved", async () => {
    mount(STRING_FIELD);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));
    search("Customer");
    confirm();
    openTypePicker("reference");
    fireEvent.click(screen.getByText("integer"));

    const data = await saved();

    expect(data.type).toBe("integer");
    expect(referenceKeys(data.decorators)).toEqual([]);
  });

  it("without a list of entities it is the plain type change, as before", async () => {
    mount(STRING_FIELD, null);
    openTypePicker("string");
    fireEvent.click(screen.getByText("reference"));

    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
    const data = await saved();
    expect(data.type).toBe("reference");
    expect(referenceKeys(data.decorators)).toEqual([]);
  });
});
