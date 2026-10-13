/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("DomainTypesTab create intent", () => {
  it("opens the requested creation form when parent navigation chooses a type", () => {
    const onCreateIntentConsumed = vi.fn();

    render(
      <DomainTypesTab
        domainId="domain-1"
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
