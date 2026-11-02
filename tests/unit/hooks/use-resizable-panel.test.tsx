/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useResizablePanel } from "@/hooks/useResizablePanel";

const PANEL = { minWidth: 200, maxWidth: 480, defaultWidth: 280, panelId: "left-panel", side: "left" as const };
const PANEL_KEY = "panel-width-left-panel";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(initial: Record<string, string>, overrides: Partial<Storage> = {}) {
  const store = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      ...overrides,
    },
  });
}

/** Browsers that block site storage make reading `window.localStorage` itself throw a SecurityError. */
function blockStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
}

function restoreStorage() {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
}

describe("useResizablePanel storage", () => {
  afterEach(() => {
    cleanup();
    restoreStorage();
  });

  it("restores the width stored for the panel", () => {
    installStorage({ [PANEL_KEY]: JSON.stringify({ width: 300, collapsed: false }) });

    const { result } = renderHook(() => useResizablePanel(PANEL));

    expect(result.current.width).toBe(300);
  });

  it("keeps the default width when storage access throws, instead of failing the dashboard render", () => {
    blockStorage();

    const { result } = renderHook(() => useResizablePanel(PANEL));

    expect(result.current.width).toBe(280);
  });

  it("keeps the default width when the stored panel state is not valid JSON", () => {
    installStorage({ [PANEL_KEY]: "{not json" });

    const { result } = renderHook(() => useResizablePanel(PANEL));

    expect(result.current.width).toBe(280);
  });

  it("keeps the panel usable when storage refuses writes (private browsing, full quota)", () => {
    installStorage({}, {
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
    });

    const { result } = renderHook(() => useResizablePanel(PANEL));

    expect(result.current.width).toBe(280);
  });
});
