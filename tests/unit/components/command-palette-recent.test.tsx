/**
 * CommandPalette "Recent" entries keep canonical URLs.
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/custom/CommandPalette/CommandPalette";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const ENTRIES_KEY = "super-schema:recent-entity-entries";
const emptyTree = { enterprise: { counts: { dataTypes: 0, entities: 0, traits: 0 }, entities: [] }, domains: [] };

function stubFetch(tree: unknown) {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("domains-tree")) return { ok: true, json: async () => tree } as Response;
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

// This jsdom environment ships no localStorage; install a Map-backed one.
function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

function seedRecent(entries: unknown[]) {
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
}

describe("CommandPalette recent entries", () => {
  beforeEach(() => {
    push.mockReset();
    installLocalStorage();
    // cmdk relies on these browser APIs, which jsdom lacks.
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => cleanup());

  it("navigates a Recent product entity with its stored slugs even before the entity list resolves it", async () => {
    seedRecent([
      {
        entityId: "e1",
        domainSlug: "payments",
        entityName: "Order",
        domainName: "Payments",
        slug: "order",
        productSlug: "checkout",
      },
    ]);
    stubFetch(emptyTree);
    render(<CommandPalette isOpen onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText("Order"));
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout/order");
  });

  it("navigates a Recent tenant-level entity to the canonical enterprise URL", async () => {
    seedRecent([
      {
        entityId: "e0",
        domainSlug: null,
        entityName: "Customer",
        domainName: "Enterprise",
        slug: "customer",
        productSlug: null,
      },
    ]);
    stubFetch(emptyTree);
    render(<CommandPalette isOpen onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText("Customer"));
    expect(push).toHaveBeenCalledWith("/schemas/enterprise/entities/customer");
  });

  it("hides a legacy Recent entry without slugs until the fetched list resolves it, and never links from its id", async () => {
    seedRecent([
      { entityId: "e1", domainSlug: "payments", entityName: "Order", domainName: "Payments" },
    ]);
    let resolveTree: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveTree = resolve;
    });
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("domains-tree")) {
        return { ok: true, json: async () => pending } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as typeof fetch;

    render(<CommandPalette isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Recent")).toBeNull();
    expect(screen.queryByText("Order")).toBeNull();

    resolveTree({
      ...emptyTree,
      domains: [
        {
          id: "d1",
          name: "Payments",
          slug: "payments",
          isSystem: false,
          counts: { dataTypes: 0, apis: 0, traits: 0 },
          products: [
            {
              id: "p1",
              name: "Checkout",
              slug: "checkout",
              isSystem: false,
              counts: { dataTypes: 0, apis: 0, entities: 1, traits: 0, events: 0 },
              entities: [{ id: "e1", name: "Order", slug: "order", status: "ACTIVE" }],
            },
          ],
        },
      ],
    });

    // Resolved: the entry appears in Recent and in Entities; both link canonically.
    const rows = await screen.findAllByText("Order");
    expect(rows.length).toBe(2);
    fireEvent.click(rows[0]);
    expect(push).toHaveBeenCalledWith("/schemas/payments/checkout/order");
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining("/entities/e1"));
  });

  describe("field navigation", () => {
    function stubFieldFetch(fields: unknown[]) {
      global.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("domains-tree")) return { ok: true, json: async () => emptyTree } as Response;
        if (u.includes("command-palette-fields")) return { ok: true, json: async () => fields } as Response;
        return { ok: false, json: async () => ({}) } as Response;
      }) as typeof fetch;
    }

    // The row renders "<entity> → <field>" as split text nodes, so match on textContent.
    const findFieldRow = (entity: string, field: string) =>
      screen.findByText((_, el) => el?.textContent === `${entity}\u2192${field}`);

    it("navigates a product field through assetHref", async () => {
      stubFieldFetch([
        {
          id: "f1",
          slug: "email",
          name: "email",
          type: "string",
          entityId: "e1",
          entitySlug: "order",
          entityName: "Order",
          domainSlug: "payments",
          productSlug: "checkout",
        },
      ]);
      render(<CommandPalette isOpen onClose={vi.fn()} />);

      fireEvent.click(await findFieldRow("Order", "email"));
      expect(push).toHaveBeenCalledWith("/schemas/payments/checkout/order/fields/email");
    });

    it("navigates a tenant-level field (null slugs) to the enterprise URL", async () => {
      stubFieldFetch([
        {
          id: "f2",
          slug: "email",
          name: "email",
          type: "string",
          entityId: "e0",
          entitySlug: "customer",
          entityName: "Customer",
          domainSlug: null,
          productSlug: null,
        },
      ]);
      render(<CommandPalette isOpen onClose={vi.fn()} />);

      fireEvent.click(await findFieldRow("Customer", "email"));
      expect(push).toHaveBeenCalledWith("/schemas/enterprise/entities/customer/fields/email");
    });
  });
});
