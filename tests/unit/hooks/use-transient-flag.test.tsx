/**
 * FINAL WAVE 2b, G11: a "Copied!" flag that clears itself after a while must not leave a timer behind when the component goes away
 * (or is asked to flash again): the timer of `setTimeout(() => setCopied(false), 2000)` fired after the jsdom window was torn down
 * and made vitest exit 1 with every test green ("window is not defined").
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useTransientFlag } from "@/hooks/useTransientFlag";
import { EmissionPreviewPanel } from "@/components/custom/EmissionPreviewPanel/EmissionPreviewPanel";
import { SchemaCodePreview } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemaCodePreview";
import type { EmissionResult } from "@/lib/emission/emission.types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTransientFlag", () => {
  it("is off, flashes on, and goes off by itself after the delay", () => {
    const { result } = renderHook(() => useTransientFlag(2000));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(1999));
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flashing again restarts the clock (one timer, the later one), instead of the first cutting the second short", () => {
    const { result } = renderHook(() => useTransientFlag(2000));
    act(() => result.current[1]());
    act(() => vi.advanceTimersByTime(1500));
    act(() => result.current[1]());
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current[0]).toBe(false);
  });

  it("leaves no timer behind when the component unmounts before it fires (nothing can run after teardown)", () => {
    const { result, unmount } = renderHook(() => useTransientFlag(2000));
    act(() => result.current[1]());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

const EMISSION: EmissionResult = {
  typespec: "model Customer {}",
  targets: { bigquery: { name: "bigquery", targetFormat: "bigquery", output: "CREATE TABLE customer (id STRING);", isValid: true, validationStatus: "VALID", warnings: [], errors: [] } },
  success: true,
  summary: { totalTargets: 1, validCount: 1, warningCount: 0, invalidCount: 0 },
};

describe("the Copy buttons clear their own timers", () => {
  // The panel's tooltips and tabs own timers of their own, so this follows the ONE two-second timer a Copy click arms: it must be cleared
  // (clearTimeout with its id) when the component unmounts before it fires.
  async function armedByCopy(ui: () => React.ReactElement, click: () => Promise<void>): Promise<{ armed: number; clearedAtUnmount: boolean }> {
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      const rendered = render(ui());
      await click();
      const ids = set.mock.calls.flatMap((call, i) => (call[1] === 2000 ? [set.mock.results[i].value as unknown] : []));
      rendered.unmount();
      const cleared = new Set(clear.mock.calls.map((call) => call[0] as unknown));
      return { armed: ids.length, clearedAtUnmount: ids.every((id) => cleared.has(id)) };
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  }

  it("EmissionPreviewPanel: 'Copy all' arms one timer, cleared at unmount", async () => {
    const result = await armedByCopy(
      () => <EmissionPreviewPanel result={EMISSION} open onClose={vi.fn()} />,
      async () => {
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /copy all outputs/i }));
        });
      }
    );
    expect(result).toEqual({ armed: 1, clearedAtUnmount: true });
  });

  it("EmissionPreviewPanel: the per-block copy button arms one timer, cleared at unmount", async () => {
    const result = await armedByCopy(
      () => <EmissionPreviewPanel result={EMISSION} open onClose={vi.fn()} />,
      async () => {
        await act(async () => {
          fireEvent.click(screen.getAllByRole("button", { name: "Copy to clipboard" })[0]);
        });
      }
    );
    expect(result).toEqual({ armed: 1, clearedAtUnmount: true });
  });

  it("SchemaCodePreview: Copy arms one timer, cleared at unmount", async () => {
    const result = await armedByCopy(
      () => <SchemaCodePreview code="select 1" language="sql" onCopy={vi.fn()} />,
      async () => {
        fireEvent.click(screen.getByTestId("schema-code-copy"));
      }
    );
    expect(result).toEqual({ armed: 1, clearedAtUnmount: true });
  });

  it("EmissionPreviewPanel: 'Copy all' clears itself after two seconds, and copying again restarts the clock", async () => {
    render(<EmissionPreviewPanel result={EMISSION} open onClose={vi.fn()} />);
    const copyAll = () => screen.getByRole("button", { name: /copy all outputs/i });
    await act(async () => {
      fireEvent.click(copyAll());
    });
    expect(copyAll().textContent).toMatch(/copied/i);
    act(() => vi.advanceTimersByTime(1500));
    await act(async () => {
      fireEvent.click(copyAll());
    });
    act(() => vi.advanceTimersByTime(1500));
    expect(copyAll().textContent).toMatch(/copied/i);
    act(() => vi.advanceTimersByTime(500));
    expect(copyAll().textContent).not.toMatch(/copied/i);
  });
});
