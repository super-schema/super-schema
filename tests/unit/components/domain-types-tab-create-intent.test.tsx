/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DomainTypesTab } from "@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createSharedEnumAction: vi.fn(),
  updateSharedEnumAction: vi.fn(),
  deleteSharedEnumAction: vi.fn(),
  createCustomScalarAction: vi.fn(),
  deleteCustomScalarAction: vi.fn(),
  createUnionTypeAction: vi.fn(),
  updateUnionTypeAction: vi.fn(),
  deleteUnionTypeAction: vi.fn(),
}));

afterEach(cleanup);

describe("DomainTypesTab create intent", () => {
  it("opens the requested creation form when parent navigation chooses a type", () => {
    const onCreateIntentConsumed = vi.fn();

    render(
      <DomainTypesTab
        domainId="domain-1"
        target={{ level: "DOMAIN", domainId: "domain-1" }}
        sharedEnums={[]}
        customScalars={[]}
        unionTypes={[]}
        createIntent="scalar"
        onCreateIntentConsumed={onCreateIntentConsumed}
      />
    );

    expect(screen.getByPlaceholderText("ScalarName")).toBeDefined();
    expect(screen.getByRole("button", { name: /Scalars/i }).getAttribute("class")).toContain("bg-accent");
    expect(onCreateIntentConsumed).toHaveBeenCalledTimes(1);
  });
});

describe("DomainTypesTab kind selector (choose intent)", () => {
  function renderChoose(onCreateIntentConsumed = vi.fn()) {
    render(
      <DomainTypesTab
        domainId="domain-1"
        target={{ level: "PRODUCT", productId: "product-1" }}
        sharedEnums={[]}
        customScalars={[]}
        unionTypes={[]}
        createIntent="choose"
        onCreateIntentConsumed={onCreateIntentConsumed}
      />
    );
    return onCreateIntentConsumed;
  }

  it("shows a kind selector instead of opening a form", () => {
    const consumed = renderChoose();
    const chooser = screen.getByTestId("type-kind-chooser");
    expect(within(chooser).getByRole("button", { name: "Enum" })).toBeDefined();
    expect(within(chooser).getByRole("button", { name: "Scalar" })).toBeDefined();
    expect(within(chooser).getByRole("button", { name: "Union" })).toBeDefined();
    expect(screen.queryByPlaceholderText("EnumName")).toBeNull();
    expect(screen.queryByPlaceholderText("ScalarName")).toBeNull();
    expect(screen.queryByPlaceholderText("UnionName")).toBeNull();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Enum", "EnumName", "Enums"],
    ["Scalar", "ScalarName", "Scalars"],
    ["Union", "UnionName", "Unions"],
  ])("choosing %s opens that kind's form on its sub-tab and closes the selector", (kind, placeholder, subTab) => {
    renderChoose();
    fireEvent.click(within(screen.getByTestId("type-kind-chooser")).getByRole("button", { name: kind }));
    expect(screen.queryByTestId("type-kind-chooser")).toBeNull();
    expect(screen.getByPlaceholderText(placeholder)).toBeDefined();
    expect(screen.getByRole("button", { name: new RegExp(subTab) }).getAttribute("class")).toContain("bg-accent");
  });

  it("Cancel dismisses the selector without opening a form", () => {
    renderChoose();
    fireEvent.click(within(screen.getByTestId("type-kind-chooser")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("type-kind-chooser")).toBeNull();
    expect(screen.queryByPlaceholderText("EnumName")).toBeNull();
  });
});
