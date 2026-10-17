/**
 * The command palette navigates with `router.push` from a select handler, which nothing can stop once Next has started rendering the
 * new route. So it asks the page first (`canNavigate`): a page with unsaved work (the event builder) vetoes it and asks the user
 * itself. A vetoed selection does not push, does not count as a recent entity, and the palette still closes.
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/custom/CommandPalette/CommandPalette";
import { BEFORE_NAVIGATE_EVENT, beforeNavigateHref } from "@/lib/navigation/before-navigate";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const ENTRIES_KEY = "super-schema:recent-entity-entries";
const emptyTree = { enterprise: { counts: { dataTypes: 0, entities: 0, traits: 0 }, entities: [] }, domains: [] };
const ORDER = { entityId: "e1", domainSlug: "payments", entityName: "Order", domainName: "Payments", slug: "order", productSlug: "checkout" };
const INVOICE = { entityId: "e2", domainSlug: "payments", entityName: "Invoice", domainName: "Payments", slug: "invoice", productSlug: "checkout" };
const INVOICE_HREF = "/schemas/payments/checkout/invoice";
const EMAIL_FIELD = {
  id: "f1", slug: "email", name: "email", type: "string", entityId: "e1", entitySlug: "order", entityName: "Order",
  domainSlug: "payments", productSlug: "checkout",
};
const EMAIL_HREF = "/schemas/payments/checkout/order/fields/email";

function stubFetch(fields: unknown[] = []) {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("domains-tree")) return { ok: true, json: async () => emptyTree } as Response;
    if (u.includes("command-palette-fields")) return { ok: true, json: async () => fields } as Response;
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
const recentIds = () => (JSON.parse(localStorage.getItem(ENTRIES_KEY) ?? "[]") as Array<{ entityId: string }>).map((e) => e.entityId);

// The page with unsaved work: it is asked where the palette is going and may veto it.
const asked: Array<string | null> = [];
let veto = false;
const listener = (e: Event) => {
  asked.push(beforeNavigateHref(e));
  if (veto) e.preventDefault();
};
const listenFor = (vetoes: boolean) => {
  veto = vetoes;
  document.addEventListener(BEFORE_NAVIGATE_EVENT, listener);
};

const findFieldRow = () => screen.findByText((_, el) => el?.textContent === "Order→email");

describe("CommandPalette: a page with unsaved work can veto the palette's navigation", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    push.mockReset();
    onClose.mockReset();
    asked.length = 0;
    veto = false;
    installLocalStorage();
    localStorage.setItem(ENTRIES_KEY, JSON.stringify([ORDER, INVOICE]));
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = vi.fn();
    stubFetch([EMAIL_FIELD]);
  });
  afterEach(() => {
    document.removeEventListener(BEFORE_NAVIGATE_EVENT, listener);
    cleanup();
  });

  describe("go to an entity", () => {
    it("pushes, counts it as a recent entity and closes when the page vetoes nothing", async () => {
      listenFor(false);
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await screen.findByText("Invoice"));

      expect(asked).toEqual([INVOICE_HREF]);
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(INVOICE_HREF);
      expect(recentIds()).toEqual(["e2", "e1"]); // Invoice moved to the front
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not push and does not count it as a recent entity when the page vetoes, and still closes", async () => {
      listenFor(true);
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await screen.findByText("Invoice"));

      expect(asked).toEqual([INVOICE_HREF]);
      expect(push).not.toHaveBeenCalled();
      expect(recentIds()).toEqual(["e1", "e2"]); // unchanged: the user did not go there
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("behaves exactly as before when no page listens", async () => {
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await screen.findByText("Invoice"));

      expect(push).toHaveBeenCalledWith(INVOICE_HREF);
      expect(recentIds()).toEqual(["e2", "e1"]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("go to a field", () => {
    it("asks where it goes, pushes and closes when the page vetoes nothing", async () => {
      listenFor(false);
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await findFieldRow());

      expect(asked).toEqual([EMAIL_HREF]);
      expect(push).toHaveBeenCalledWith(EMAIL_HREF);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not push when the page vetoes, and still closes", async () => {
      listenFor(true);
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await findFieldRow());

      expect(asked).toEqual([EMAIL_HREF]);
      expect(push).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("behaves exactly as before when no page listens", async () => {
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await findFieldRow());

      expect(push).toHaveBeenCalledWith(EMAIL_HREF);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Go to Domains", () => {
    it("asks where it goes, pushes and closes when the page vetoes nothing", async () => {
      listenFor(false);
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await screen.findByText("Go to Domains"));

      expect(asked).toEqual(["/schemas"]);
      expect(push).toHaveBeenCalledWith("/schemas");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not push when the page vetoes, and still closes", async () => {
      listenFor(true);
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await screen.findByText("Go to Domains"));

      expect(asked).toEqual(["/schemas"]);
      expect(push).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("behaves exactly as before when no page listens", async () => {
      render(<CommandPalette isOpen onClose={onClose} />);
      fireEvent.click(await screen.findByText("Go to Domains"));

      expect(push).toHaveBeenCalledWith("/schemas");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
