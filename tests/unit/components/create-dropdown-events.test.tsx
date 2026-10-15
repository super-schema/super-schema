// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateDropdown } from "@/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown";

afterEach(() => cleanup());

describe("CreateDropdown — events items", () => {
  it("offers New Event Spec / Message / Channel / Trait only when the level passes the callbacks", () => {
    const onNewMessage = vi.fn();
    render(
      <CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewEventSpec={vi.fn()} onNewMessage={onNewMessage} onNewChannel={vi.fn()} onNewTrait={vi.fn()} />
    );
    fireEvent.click(screen.getByTitle("More options"));
    for (const label of ["New Event Spec", "New Message", "New Channel", "New Trait"]) expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: /New Message/ }));
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the single New Custom Data Type entry and hides events items by default", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} />);
    fireEvent.click(screen.getByTitle("More options"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "New EntitySchema entity with fields",
      "New Custom Data TypeEnum, scalar or union",
    ]);
  });

  it("offers only Trait at a level that allows traits but not events kinds (Domain / Enterprise)", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewTrait={vi.fn()} />);
    fireEvent.click(screen.getByTitle("More options"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "New EntitySchema entity with fields",
      "New Custom Data TypeEnum, scalar or union",
      "New TraitReusable message or operation trait",
    ]);
  });
});
