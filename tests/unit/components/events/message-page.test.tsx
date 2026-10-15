// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ preview: vi.fn(), publish: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/features/events/messages/MessageEditor", () => ({
  MessageEditor: (p: { productId: string }) => <div data-testid="message-editor" data-product={p.productId} />,
}));
vi.mock("@/features/events/shared/UsedByPanel", () => ({ UsedByPanel: (p: { subject: unknown }) => <div data-testid="used-by">{JSON.stringify(p.subject)}</div> }));
// The real button's open/confirm flow is covered by its own test; here it just exposes the props the page wires into it.
vi.mock("@/features/events/shared/PublishVersionButton", () => ({
  PublishVersionButton: (p: { subjectName: string; loadPreview: () => void; publish: (input: { bump: "MINOR" }) => void }) => (
    <button data-testid="publish" onClick={() => { p.loadPreview(); p.publish({ bump: "MINOR" }); }}>{p.subjectName}</button>
  ),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions", () => ({
  getMessagePublishPreviewAction: h.preview, publishMessageAction: h.publish,
}));
import { MessagePage } from "@/features/events/messages/MessagePage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const base = {
  productId: "p1", domainSlug: "payments", productSlug: "checkout", crumbs: [{ label: "Messages" }], listHref: "/l",
  entityOptions: [], traitOptions: [],
  message: { id: "m1", name: "OrderCreated", spec: { traitIds: [] }, payload: { entityId: "e1", entityVersionId: "v1" }, headers: null, key: null, latestVersionLabel: "1.3", hasUnpublishedChanges: true, tenantId: "t", domainId: "d1", productId: "p1" },
  versions: [{ id: "mv1", major: 1, minor: 3, label: "1.3", sequence: 4, changeKind: "MINOR" as const, changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z" }],
};
const resolvedSpec = {
  name: "OrderCreated", spec: { traitIds: [] },
  payload: { entityId: "e1", entityName: "Order", entityVersionId: "v1", label: "2.1", major: 2 }, headers: null, key: null,
};

describe("MessagePage", () => {
  it("shows the draft editor, publish button, versions with deep links and the Used-by panel", () => {
    render(<MessagePage {...base} viewing={null} />);
    expect(screen.getByTestId("message-editor").getAttribute("data-product")).toBe("p1");
    expect(screen.getByTestId("publish").textContent).toBe("OrderCreated");
    expect(screen.getByRole("link", { name: "v1.3" }).getAttribute("href")).toBe("/schemas/payments/checkout/messages/m1?version=1.3");
    expect(screen.getByText("unpublished changes")).toBeDefined();
    expect(screen.getByTestId("used-by").textContent).toBe(JSON.stringify({ kind: "message", messageId: "m1" }));
  });

  it("passes the owning product to preview and publish (ownership is enforced server-side per product)", () => {
    render(<MessagePage {...base} viewing={null} />);
    fireEvent.click(screen.getByTestId("publish"));
    expect(h.preview).toHaveBeenCalledWith("m1", "p1");
    expect(h.publish).toHaveBeenCalledWith("m1", "p1", { bump: "MINOR" });
  });

  it("shows an unpublished message without the 'unpublished changes' flag and an empty version list", () => {
    render(<MessagePage {...base} message={{ ...base.message, latestVersionLabel: null }} versions={[]} viewing={null} />);
    expect(screen.getByText("unpublished")).toBeDefined();
    expect(screen.queryByText("unpublished changes")).toBeNull();
    expect(screen.getByTestId("event-version-list-empty")).toBeDefined();
  });

  it("shows a published version read-only", () => {
    render(<MessagePage {...base} viewing={{ label: "1.3", resolvedSpec }} />);
    expect(screen.queryByTestId("message-editor")).toBeNull();
    expect(screen.queryByTestId("publish")).toBeNull();
    expect(screen.getByText(/Viewing v1\.3/)).toBeDefined();
    expect(screen.getByText(/Order v2\.1/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Back to draft" }).getAttribute("href")).toBe("/schemas/payments/checkout/messages/m1");
  });

  it("lists every pin of a published version, even when two roles pin the same entity version", () => {
    const pin = resolvedSpec.payload;
    render(<MessagePage {...base} viewing={{ label: "1.3", resolvedSpec: { ...resolvedSpec, headers: pin, key: { ...pin, entityName: "OrderKey", label: "1.0" } } }} />);
    expect(screen.getByText("Payload: Order v2.1")).toBeDefined();
    expect(screen.getByText("Headers: Order v2.1")).toBeDefined();
    expect(screen.getByText("Kafka key: OrderKey v1.0")).toBeDefined();
  });

  it("shows another product's message read-only: no draft editor, no publish, a link to the owner and version links on this page", () => {
    render(
      <MessagePage
        {...base}
        owner={{ label: "Fraud / Scoring", href: "/schemas/fraud/scoring/messages/m1?version=1.3" }}
        message={{ ...base.message, spec: { traitIds: [] }, hasUnpublishedChanges: false }}
        viewing={{ label: "1.3", resolvedSpec }}
      />
    );
    expect(screen.queryByTestId("message-editor")).toBeNull();
    expect(screen.queryByTestId("publish")).toBeNull();
    expect(screen.queryByRole("link", { name: "Back to draft" })).toBeNull();
    expect(screen.getByText(/Owned by Fraud \/ Scoring/)).toBeDefined();
    expect(screen.getByRole("link", { name: "open in its own product" }).getAttribute("href")).toBe("/schemas/fraud/scoring/messages/m1?version=1.3");
    expect(screen.getByRole("link", { name: "v1.3" }).getAttribute("href")).toBe("/schemas/payments/checkout/messages/m1?version=1.3");
    expect(screen.getByTestId("used-by")).toBeDefined();
  });

  it("never offers the editor or publish for another product's message, even if no version is being viewed", () => {
    render(<MessagePage {...base} owner={{ label: "Fraud / Scoring", href: "/schemas/fraud/scoring/messages/m1" }} viewing={null} />);
    expect(screen.queryByTestId("message-editor")).toBeNull();
    expect(screen.queryByTestId("publish")).toBeNull();
  });
});
