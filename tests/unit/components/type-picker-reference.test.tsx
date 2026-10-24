/**
 * The type picker's reference prompt: a reference is chosen together with its target entity, listed as `domain / product / entity`.
 * A PICKED entity reports its id and qualified name; a typed name that matches exactly one entity counts as picked; one that matches
 * several must be picked from the list; a name that matches none stays a plain name.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TypePicker } from "@/components/custom/TypePicker";
import type { PickableEntity } from "@/lib/references/entity-reference";

const ENTITIES: PickableEntity[] = [
  { id: "e-addr-b", name: "Address", domain: "Billing", product: "Core" },
  { id: "e-addr-s", name: "Address", domain: "Sales", product: "Crm" },
  { id: "e-cust", name: "Customer", domain: "Sales", product: "Crm" },
];

beforeAll(() => {
  // cmdk (the search list) needs these browser APIs.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

function mount(over: Partial<React.ComponentProps<typeof TypePicker>> = {}) {
  const onChange = vi.fn();
  const onComplexTypeConfig = vi.fn();
  render(
    <TypePicker value="string" onChange={onChange} onComplexTypeConfig={onComplexTypeConfig} promptTypes={["reference"]} entities={ENTITIES} {...over} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /string/ }));
  return { onChange, onComplexTypeConfig };
}

const chooseReference = () => fireEvent.click(screen.getByText("reference"));
const search = (text: string) => fireEvent.change(screen.getByPlaceholderText("Search or type entity name..."), { target: { value: text } });
const confirm = () => screen.getByRole("button", { name: /Confirm ref/ }) as HTMLButtonElement;

describe("TypePicker reference prompt", () => {
  it("opens the prompt for a reference and lists the matches as domain / product / entity", () => {
    mount();
    chooseReference();
    search("Addr");

    expect(screen.getByText("Billing / Core / Address")).toBeDefined();
    expect(screen.getByText("Sales / Crm / Address")).toBeDefined();
    expect(screen.queryByText("Sales / Crm / Customer")).toBeNull();
  });

  it("a picked entity is reported with its id and qualified name, together with the type, in the one confirm", () => {
    const { onChange, onComplexTypeConfig } = mount();
    chooseReference();
    search("Addr");
    fireEvent.click(screen.getByText("Sales / Crm / Address"));

    fireEvent.click(confirm());

    expect(onChange).toHaveBeenCalledWith("reference");
    expect(onComplexTypeConfig).toHaveBeenCalledTimes(1);
    expect(onComplexTypeConfig).toHaveBeenCalledWith("reference", {
      referencedEntityName: "Address",
      referencedEntityId: "e-addr-s",
      referencedQualifiedName: "Sales/Crm/Address",
      referenceCardinality: "many-to-one",
    });
  });

  it("a typed name that matches exactly ONE entity is that entity (id and qualified name), without clicking it", () => {
    const { onComplexTypeConfig } = mount();
    chooseReference();
    search("Customer");

    fireEvent.click(confirm());

    expect(onComplexTypeConfig).toHaveBeenCalledWith("reference", expect.objectContaining({ referencedEntityId: "e-cust", referencedQualifiedName: "Sales/Crm/Customer" }));
  });

  it("a typed name that matches SEVERAL entities cannot be confirmed until one is picked from the list", () => {
    const { onComplexTypeConfig } = mount();
    chooseReference();
    search("Address");

    expect(confirm().disabled).toBe(true);
    expect(screen.getByTestId("reference-prompt-ambiguous").textContent).toContain("2 entities are named");

    fireEvent.click(screen.getByText("Billing / Core / Address"));
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());

    expect(onComplexTypeConfig).toHaveBeenCalledWith("reference", expect.objectContaining({ referencedEntityId: "e-addr-b" }));
  });

  it("a typed name that matches no entity stays a plain name (no id, no qualified name)", () => {
    const { onComplexTypeConfig } = mount();
    chooseReference();
    search("Elsewhere");

    fireEvent.click(confirm());

    const config = onComplexTypeConfig.mock.calls[0][1];
    expect(config).toEqual({ referencedEntityName: "Elsewhere", referenceCardinality: "many-to-one" });
  });

  it("editing the text after a pick forgets the pick", () => {
    const { onComplexTypeConfig } = mount();
    chooseReference();
    search("Addr");
    fireEvent.click(screen.getByText("Sales / Crm / Address"));
    search("Unknown");

    fireEvent.click(confirm());

    expect(onComplexTypeConfig.mock.calls[0][1]).toEqual({ referencedEntityName: "Unknown", referenceCardinality: "many-to-one" });
  });

  it("the types the caller does not handle are chosen directly, as before", () => {
    const { onChange, onComplexTypeConfig } = mount();

    fireEvent.click(screen.getByText("array"));

    expect(onChange).toHaveBeenCalledWith("array");
    expect(onComplexTypeConfig).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
  });

  it("the type search does not list entities as types when the reference prompt is on (it would set the field's type to an entity name)", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("Search types..."), { target: { value: "Addr" } });

    expect(screen.queryByText("entity reference")).toBeNull();
  });

  it("without a complex-type handler a reference is chosen directly (unchanged)", () => {
    const onChange = vi.fn();
    render(<TypePicker value="string" onChange={onChange} entities={ENTITIES} />);
    fireEvent.click(screen.getByRole("button", { name: /string/ }));

    fireEvent.click(screen.getByText("reference"));

    expect(onChange).toHaveBeenCalledWith("reference");
    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
  });

  it("without a complex-type handler the type search still lists the entities (unchanged)", () => {
    render(<TypePicker value="string" onChange={vi.fn()} entities={ENTITIES} />);
    fireEvent.click(screen.getByRole("button", { name: /string/ }));

    fireEvent.change(screen.getByPlaceholderText("Search types..."), { target: { value: "Addr" } });

    expect(screen.getAllByText("entity reference")).toHaveLength(2);
  });
});
