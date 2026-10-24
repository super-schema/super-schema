/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const mocks = vi.hoisted(() => ({ trackRecentEntity: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/recent-entities", () => ({ trackRecentEntity: mocks.trackRecentEntity }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: vi.fn(),
  publishEntityAction: vi.fn(),
  listEntityVersionsAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: { rows: [], truncated: false } }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor", () => ({ FieldEditor: () => <div>field-editor</div> }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab", () => ({ SchemasTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab", () => ({ TypeSpecSourceTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/RightPanelRouter", () => ({ RightPanelRouter: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta", () => ({ InlineEntityMeta: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab", () => ({ AlertsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiTab", () => ({ ApiTab: () => <div>api-tab</div> }));
vi.mock("@/components/custom/DiffViewer", () => ({ DiffViewer: () => null }));
vi.mock("@/components/custom/TypeMappingOverrideDialog", () => ({ TypeMappingOverrideDialog: () => null }));
vi.mock("@/components/custom/ChangeHistoryView", () => ({ ChangeHistoryView: () => null }));
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({
  RetentionPolicyEditor: () => null,
}));

afterEach(cleanup);

const BASE_ENTITY = {
  id: "ent-1",
  name: "Customer",
  slug: "customer",
  description: "",
  status: "DRAFT",
  version: 1,
  metadata: null,
};

function props(over: Partial<EntityWorkspaceProps>): EntityWorkspaceProps {
  return {
    level: "PRODUCT",
    entity: {
      ...BASE_ENTITY,
      domainId: "dom-1",
      domainName: "Payments",
      domainSlug: "payments",
      productSlug: "checkout",
      productName: "Checkout",
    },
    domainPolicy: null,
    fields: [],
    apiServiceId: null,
    apiOperations: [],
    ...over,
  };
}

const TENANT_PROPS = props({
  level: "TENANT",
  entity: {
    ...BASE_ENTITY,
    domainId: null,
    domainName: "Enterprise",
    domainSlug: null,
    productSlug: null,
    productName: null,
  },
});

describe("EntityWorkspace level", () => {
  it("tracks a tenant entity as a recent entry without domain or product slugs", () => {
    render(<EntityWorkspace {...TENANT_PROPS} />);
    expect(mocks.trackRecentEntity).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "ent-1", slug: "customer", domainSlug: null, productSlug: null })
    );
  });

  it("shows the APIs tab for a product entity", () => {
    render(<EntityWorkspace {...props({})} />);
    expect(screen.getByTestId("tab-api")).toBeDefined();
  });

  it("hides the APIs tab for an Enterprise entity", () => {
    render(<EntityWorkspace {...TENANT_PROPS} />);
    expect(screen.queryByTestId("tab-api")).toBeNull();
    expect(screen.getByTestId("tab-editor")).toBeDefined();
  });

  it("builds an 'Enterprise › <Entity>' breadcrumb through assetHref for a tenant entity", () => {
    render(<EntityWorkspace {...TENANT_PROPS} />);
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "Enterprise" }).getAttribute("href")).toBe("/schemas/enterprise");
    expect(crumbs.queryByRole("link", { name: "Domains" })).toBeNull();
    expect(crumbs.getByText("Customer")).toBeDefined();
  });

  it("builds a Domains › domain › product › entity breadcrumb for a product entity", () => {
    render(<EntityWorkspace {...props({})} />);
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "Domains" }).getAttribute("href")).toBe("/schemas");
    expect(crumbs.getByRole("link", { name: "Payments" }).getAttribute("href")).toBe("/schemas/payments");
    expect(crumbs.getByRole("link", { name: "Checkout" }).getAttribute("href")).toBe("/schemas/payments/checkout");
  });
});

describe("EntityWorkspace draft + publish header", () => {
  const productEntity = props({}).entity;

  it("shows 'Never published' and a Publish button for an unpublished draft", () => {
    render(<EntityWorkspace {...props({})} />);
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Never published");
    expect(screen.getByTestId("publish-entity-button")).toBeDefined();
  });

  it("shows the latest version with unpublished changes from the loader", () => {
    render(
      <EntityWorkspace {...props({ entity: { ...productEntity, latestVersionLabel: "2.1", hasUnpublishedChanges: true } })} />
    );
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Draft · unpublished changes · latest v2.1");
  });

  it("offers Publish on an Enterprise entity too", () => {
    render(<EntityWorkspace {...TENANT_PROPS} />);
    expect(screen.getByTestId("publish-entity-button")).toBeDefined();
  });

  it("hides Publish for a retired entity", () => {
    render(
      <EntityWorkspace
        {...props({ entity: { ...productEntity, status: "RETIRED", latestVersionLabel: "1.0", hasUnpublishedChanges: false } })}
      />
    );
    expect(screen.getByTestId("entity-version-state").textContent).toBe("Published · v1.0");
    expect(screen.queryByTestId("publish-entity-button")).toBeNull();
  });
});

describe("EntityWorkspace stale references (Task 8)", () => {
  // The completeness defaults (owner, description, retention) alert on this bare entity; a stale reference adds one more.
  const alertsLabel = () => screen.getByText(/^Alerts/).textContent;
  const stale = { ref: { entityId: "cust", domain: "Payments", product: "Checkout", entity: "Address" }, recorded: "1.0", latest: "1.1" };

  it("adds one alert to the Alerts tab when a referenced entity has a newer published version", () => {
    render(<EntityWorkspace {...props({})} />);
    const without = Number(/\((\d+)\)/.exec(alertsLabel() ?? "")?.[1]);
    expect(without).toBeGreaterThan(0);
    cleanup();
    render(<EntityWorkspace {...props({ referenceStaleness: [stale] })} />);
    expect(alertsLabel()).toBe(`Alerts (${without + 1})`);
  });

  it("an empty list changes nothing", () => {
    render(<EntityWorkspace {...props({})} />);
    const without = alertsLabel();
    cleanup();
    render(<EntityWorkspace {...props({ referenceStaleness: [] })} />);
    expect(alertsLabel()).toBe(without);
  });
});
