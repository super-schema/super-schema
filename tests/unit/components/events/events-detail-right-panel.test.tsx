// @vitest-environment jsdom
/**
 * Every Events detail page (message, channel, trait, event spec) has nothing for the global right panel, so each must opt out of
 * the empty "Detail Panel — Select a field…" placeholder while mounted (it squeezes the editors otherwise).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { RightPanelContentProvider, useRightPanelContent } from "@/hooks/useRightPanelContent";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: vi.fn(async () => ({ success: true, data: [] })) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions", () => ({
  updateChannelAction: vi.fn(), setChannelMessagesAction: vi.fn(), deleteChannelAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ updateTraitAction: vi.fn(), deleteTraitAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions", () => ({ updateMessageAction: vi.fn(), deleteMessageAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions", () => ({
  getMessagePublishPreviewAction: vi.fn(), publishMessageAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions", () => ({
  emitEventSpecDraftAction: vi.fn(async () => ({ success: false, error: "n/a" })), getEventSpecVersionDocumentAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions", () => ({
  getEventSpecPublishPreviewAction: vi.fn(), publishEventSpecAction: vi.fn(),
}));
vi.mock("@/features/events/messages/MessageEditor", () => ({ MessageEditor: () => null }));
vi.mock("@/features/events/event-specs/EventSpecEditor", () => ({ EventSpecEditor: () => null }));
vi.mock("@/features/events/shared/UsedByPanel", () => ({ UsedByPanel: () => null }));
vi.mock("@/features/events/shared/PublishVersionButton", () => ({ PublishVersionButton: () => null }));

import { ChannelEditor } from "@/features/events/channels/ChannelEditor";
import { TraitEditor } from "@/features/events/traits/TraitEditor";
import { MessagePage } from "@/features/events/messages/MessagePage";
import { EventSpecPage } from "@/features/events/event-specs/EventSpecPage";

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

describe("Events detail pages hide the empty right panel", () => {
  it("channel page", () => {
    renderInShell(
      <ChannelEditor
        productId="p1" listHref="/l" crumbs={crumbs} messageOptions={[]}
        channel={{ id: "c1", name: "orders", address: "a", protocol: "kafka", format: "avro", formatDialect: null, spec: {}, allowedMessageIds: [], tenantId: "t", domainId: "d1", productId: "p1" }}
      />
    );
    expect(screen.getByTestId("hide-empty").textContent).toBe("true");
  });

  it("trait page", () => {
    renderInShell(
      <TraitEditor
        owner={{ level: "TENANT", tenantId: "t" }} crumbs={crumbs} listHref="/l" entityOptions={[]}
        trait={{ id: "t1", name: "CloudEvents", kind: "OPERATION", spec: {}, headers: null, tenantId: "t", domainId: null, productId: null }}
      />
    );
    expect(screen.getByTestId("hide-empty").textContent).toBe("true");
  });

  it("message page", () => {
    renderInShell(
      <MessagePage
        productId="p1" domainSlug="payments" productSlug="checkout" crumbs={crumbs} listHref="/l" entityOptions={[]} traitOptions={[]}
        message={{ id: "m1", name: "OrderCreated", spec: { traitIds: [] }, payload: { entityId: "e1", entityVersionId: "v1" }, headers: null, key: null, latestVersionLabel: null, hasUnpublishedChanges: false, tenantId: "t", domainId: "d1", productId: "p1" }}
        versions={[]} viewing={null}
      />
    );
    expect(screen.getByTestId("hide-empty").textContent).toBe("true");
  });

  it("event spec page", () => {
    renderInShell(
      <EventSpecPage
        productId="p1" domainSlug="payments" productSlug="checkout" crumbs={crumbs} channelOptions={[]} messageOptions={[]} operationTraits={[]}
        owner={null} versions={[]} viewingVersion={null} initialTab="editor"
        spec={{ id: "s1", name: "checkout-service", specType: "asyncapi@3.0", latestVersionLabel: null, hasUnpublishedChanges: false, tenantId: "t", domainId: "d1", productId: "p1", document: { info: { title: "x" }, servers: [], operations: [] } }}
      />
    );
    expect(screen.getByTestId("hide-empty").textContent).toBe("true");
  });
});
