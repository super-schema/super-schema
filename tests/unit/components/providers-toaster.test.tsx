// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Providers } from "@/components/providers";

beforeAll(() => {
  // This jsdom environment ships no localStorage (the theme and font-scale hooks read it); install a Map-backed one.
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
  // jsdom has no matchMedia; the theme provider and the toaster both ask for it.
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
  toast.dismiss();
  cleanup();
});

describe("Providers — toast outlet", () => {
  it("renders the toasts that server-action callers raise (a `toast.success` is invisible without a mounted Toaster)", async () => {
    render(
      <Providers>
        <p>page</p>
      </Providers>
    );
    expect(screen.getByText("page")).toBeDefined();

    act(() => {
      toast.success("Draft saved");
    });

    expect(await screen.findByText("Draft saved")).toBeDefined();
  });

  it("mounts exactly one toast outlet", () => {
    const { container } = render(
      <Providers>
        <p>page</p>
      </Providers>
    );
    // Sonner renders its list region once per <Toaster />; two outlets would show every toast twice.
    expect(document.querySelectorAll("section[aria-label^='Notifications']")).toHaveLength(1);
    expect(container).toBeDefined();
  });
});
