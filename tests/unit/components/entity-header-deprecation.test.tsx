/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityHeader } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityHeader";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(() => cleanup());

// The page's copy of the entity: its metadata has no schemaVersions (the page omits them), so a whole-copy write would drop them.
const entity = {
  id: "ent-1",
  name: "Order",
  description: "",
  status: "ACTIVE",
  version: 1,
  domainName: "Payments",
  domainSlug: "payments",
  productSlug: "checkout",
  productName: "Checkout",
  metadata: { tags: ["sales"], owner: "alice", schemaTargetTypeOverrides: { avro: [] } } as Record<string, unknown>,
};

describe("EntityHeader deprecation form", () => {
  it("sends only the deprecation notice, not the page's copy of the metadata", () => {
    const onStatusChange = vi.fn();
    render(
      <EntityHeader
        level="PRODUCT"
        entity={entity}
        onStatusChange={onStatusChange}
        readOnly={false}
        isPending={false}
        statusError={null}
        versionState={{ latestVersionLabel: "1.0", hasUnpublishedChanges: false }}
      />
    );

    fireEvent.click(screen.getByTestId("entity-status-trigger"));
    fireEvent.click(screen.getByTestId("entity-status-option-deprecated"));
    fireEvent.change(screen.getByTestId("deprecation-since"), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByTestId("deprecation-submit"));

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("DEPRECATED", {
      deprecation: { deprecated: true, since: "2026-11-01", replacementEntityId: null, migrationNotes: undefined },
    });
    expect(Object.keys(onStatusChange.mock.calls[0][1] as object)).toEqual(["deprecation"]);
  });
});
