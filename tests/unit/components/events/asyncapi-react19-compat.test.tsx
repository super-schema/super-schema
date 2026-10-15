// @vitest-environment jsdom
import { Component, type ReactNode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
// The prebuilt browser (UMD) bundle is what AsyncApiPreview ships: `lib/esm` cannot be bundled by Turbopack (needs `fs`).
import AsyncApiComponent from "@asyncapi/react-component/browser/index.js";

afterEach(() => cleanup());

// jsdom has no ResizeObserver; the component's layout uses it through `use-resize-observer`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const doc = {
  asyncapi: "3.0.0",
  info: { title: "Compat Probe", version: "1.0.0", description: "React 19 probe" },
  channels: {
    orders: { address: "orders", messages: { OrderCreated: { payload: { type: "object", properties: { id: { type: "string" } } } } } },
  },
  operations: { sendOrder: { action: "send", channel: { $ref: "#/channels/orders" } } },
};

class Catcher extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? <p>FAILED</p> : this.props.children;
  }
}

/**
 * D14 evidence (2026-10-14): `@asyncapi/react-component` 3.2.1 declares `react >=18` and its browser
 * bundle renders under the repo's React 19.2.4 with no thrown error and no console error/warning.
 * `AsyncApiPreview` still ships the sandboxed-iframe fallback (error boundary) as the plan decided;
 * this test fails loudly if a dependency bump ever breaks the primary renderer.
 */
describe("@asyncapi/react-component under React 19", () => {
  it("renders an AsyncAPI 3 document without errors or warnings", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(`error: ${String(a[0])}`));
    vi.spyOn(console, "warn").mockImplementation((...a) => void logged.push(`warn: ${String(a[0])}`));
    let caught: unknown = null;
    const Cmp = AsyncApiComponent;
    const { container } = render(
      <Catcher onError={(e) => (caught = e)}>
        <Cmp schema={JSON.stringify(doc)} />
      </Catcher>
    );
    await waitFor(() => expect(container.textContent).toContain("Compat Probe"), { timeout: 15000 });
    await waitFor(() => expect(container.textContent).toContain("OrderCreated"));
    expect(caught).toBeNull();
    expect(container.querySelector(".aui-root")).not.toBeNull();
    expect(logged).toEqual([]);
  }, 30000);
});
