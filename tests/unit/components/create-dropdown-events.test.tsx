// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateDropdown } from "@/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown";

afterEach(() => cleanup());

const ENTITY = "New EntitySchema entity with fields";
const DATA_TYPE = "New Custom Data TypeEnum, scalar or union";
const API = "New APIAPI service definition";
const EVENT = "New EventAsyncAPI event specification";
const TRAIT = "New Message PropertiesReusable message properties (Trait)";

const openMenu = () => fireEvent.click(screen.getByTitle("More options"));
const items = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

describe("CreateDropdown: product menu (events)", () => {
  it("lists exactly New Entity, New Custom Data Type, New API and New Event", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} onNewEvent={vi.fn()} />);
    openMenu();
    expect(items()).toEqual([ENTITY, DATA_TYPE, API, EVENT]);
  });

  it("describes New Event as the AsyncAPI event specification", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewEvent={vi.fn()} />);
    openMenu();
    const item = screen.getByRole("menuitem", { name: /New Event/ });
    expect(item.textContent).toContain("AsyncAPI event specification");
  });

  it("calls onNewEvent once and closes the menu when New Event is chosen", () => {
    const onNewEvent = vi.fn();
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} onNewEvent={onNewEvent} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New Event/ }));
    expect(onNewEvent).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("never offers the retired New Event Spec, New Message or New Channel entries", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} onNewEvent={vi.fn()} onNewTrait={vi.fn()} />);
    openMenu();
    for (const retired of [/New Event Spec/, /New Message(?! Properties)/, /New Channel/]) expect(screen.queryByRole("menuitem", { name: retired })).toBeNull();
    // The only entry that may say Message is New Message Properties.
    expect(screen.getByRole("menu").textContent?.replace(TRAIT, "")).not.toMatch(/Event Spec|Message|Channel/);
  });

  it("does not call any other callback when New Event is chosen", () => {
    const onNewEntity = vi.fn();
    const onNewCustomDataType = vi.fn();
    const onNewApi = vi.fn();
    render(<CreateDropdown onNewEntity={onNewEntity} onNewCustomDataType={onNewCustomDataType} onNewApi={onNewApi} onNewEvent={vi.fn()} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /New Event/ }));
    expect(onNewEntity).not.toHaveBeenCalled();
    expect(onNewCustomDataType).not.toHaveBeenCalled();
    expect(onNewApi).not.toHaveBeenCalled();
  });
});

describe("CreateDropdown: optional items", () => {
  it("keeps the single New Custom Data Type entry and hides New API, New Event and New Message Properties by default", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} />);
    openMenu();
    expect(items()).toEqual([ENTITY, DATA_TYPE]);
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("shows New API only where the level passes it (not at the Enterprise level)", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} />);
    openMenu();
    expect(items()).toEqual([ENTITY, DATA_TYPE, API]);
  });

  it("separates the events group (New Event, New Message Properties) from the assets, only when the group is not empty", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} onNewEvent={vi.fn()} />);
    openMenu();
    const menu = screen.getByRole("menu");
    const children = Array.from(menu.children).map((c) => c.getAttribute("role") === "separator" ? "separator" : c.textContent);
    expect(children).toEqual([ENTITY, DATA_TYPE, API, EVENT]);
  });
});

describe("CreateDropdown: New Message Properties (Domain / Enterprise library levels)", () => {
  it("offers only New Message Properties at a level that allows library sets but not events (Domain / Enterprise)", () => {
    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewTrait={vi.fn()} />);
    openMenu();
    expect(items()).toEqual([ENTITY, DATA_TYPE, TRAIT]);
  });

  it("renders New Message Properties only when onNewTrait is passed, and calls it once", () => {
    const onNewTrait = vi.fn();
    const { unmount } = render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} onNewEvent={vi.fn()} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /New Message Properties/ })).toBeNull();
    unmount();

    render(<CreateDropdown onNewEntity={vi.fn()} onNewCustomDataType={vi.fn()} onNewApi={vi.fn()} onNewEvent={vi.fn()} onNewTrait={onNewTrait} />);
    openMenu();
    expect(items()).toEqual([ENTITY, DATA_TYPE, API, EVENT, TRAIT]);
    fireEvent.click(screen.getByRole("menuitem", { name: /New Message Properties/ }));
    expect(onNewTrait).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("CreateDropdown: the primary button", () => {
  it("creates an entity from the primary button without opening the menu", () => {
    const onNewEntity = vi.fn();
    render(<CreateDropdown onNewEntity={onNewEntity} onNewCustomDataType={vi.fn()} onNewEvent={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^New Entity$/ }));
    expect(onNewEntity).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
