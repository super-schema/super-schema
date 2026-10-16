// @vitest-environment jsdom
/**
 * The Domain / Enterprise trait page has nothing for the global right panel, so it must opt out of the empty "Detail Panel —
 * Select a field…" placeholder while mounted (it squeezes the editor otherwise). The Event page fills the panel with its live
 * code, so it is not covered here.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { RightPanelContentProvider, useRightPanelContent } from "@/hooks/useRightPanelContent";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: vi.fn(async () => ({ success: true, data: [] })) }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ updateTraitAction: vi.fn(), deleteTraitAction: vi.fn() }));

import { TraitEditor } from "@/features/events/traits/TraitEditor";

afterEach(cleanup);

/** Stands in for the shell's right panel: reports whether the empty placeholder is hidden. */
function Probe() {
  const { hideWhenEmpty } = useRightPanelContent();
  return <span data-testid="hide-empty">{String(hideWhenEmpty)}</span>;
}
function renderInShell(page: ReactNode) {
  return render(
    <RightPanelContentProvider>
      <Probe />
      {page}
    </RightPanelContentProvider>
  );
}

const crumbs = [{ label: "Events" }];

describe("Trait detail page hides the empty right panel", () => {
  it("trait page", () => {
    renderInShell(
      <TraitEditor
        owner={{ level: "TENANT", tenantId: "t" }} crumbs={crumbs} listHref="/l" entityOptions={[]}
        trait={{ id: "t1", name: "CloudEvents", kind: "OPERATION", spec: {}, headers: null, tenantId: "t", domainId: null, productId: null }}
      />
    );
    expect(screen.getByTestId("hide-empty").textContent).toBe("true");
  });
});
