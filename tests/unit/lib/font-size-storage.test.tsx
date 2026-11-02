/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { useFontSize } from "@/lib/font-size";
import { Providers } from "@/components/providers";

const STORAGE_KEY = "super-schema:font-scale";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
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

beforeAll(() => {
  // jsdom has no matchMedia; the theme provider that Providers mounts asks for it.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  restoreStorage();
  document.documentElement.style.removeProperty("--font-scale");
});

describe("font scale storage", () => {
  it("applies the stored scale", () => {
    installStorage({ [STORAGE_KEY]: "large" });

    const { result } = renderHook(() => useFontSize());

    expect(result.current.scale).toBe("large");
  });

  it("falls back to medium when reading storage throws, instead of failing the render", () => {
    blockStorage();

    const { result } = renderHook(() => useFontSize());

    expect(result.current.scale).toBe("medium");
  });

  it("rejects a stored value that is only inherited from Object.prototype", () => {
    installStorage({ [STORAGE_KEY]: "constructor" });

    const { result } = renderHook(() => useFontSize());

    expect(result.current.scale).toBe("medium");
  });

  it("does not throw when the chosen scale cannot be written", () => {
    blockStorage();
    const { result } = renderHook(() => useFontSize());

    expect(() => act(() => result.current.setScale("large"))).not.toThrow();
  });

  it("the root providers still render their children when storage access throws", () => {
    blockStorage();

    render(
      <Providers>
        <p>sign in</p>
      </Providers>
    );

    expect(screen.getByText("sign in")).toBeDefined();
  });
});
