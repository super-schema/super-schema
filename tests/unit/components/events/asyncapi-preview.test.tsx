// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/dynamic", () => ({ default: () => function DynamicStub() { return <div data-testid="react-preview" />; } }));
import { AsyncApiPreview } from "@/features/events/event-specs/AsyncApiPreview";
import { buildPreviewSrcDoc } from "@/features/events/event-specs/preview-src-doc";

afterEach(() => cleanup());

describe("AsyncAPI preview (D14)", () => {
  it("escapes the document so it cannot break out of the inline script", () => {
    const html = buildPreviewSrcDoc({ info: { title: "</script><script>alert(1)</script>" } }, "https://app.test");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain('<script src="https://app.test/api/asyncapi-preview/standalone.js"></script>');
    expect(html).toContain("AsyncApiStandalone.render(");
  });

  it("uses the React renderer and falls back to the sandboxed iframe when it throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Throwing = () => {
      throw new Error("React 19 incompatibility");
    };
    render(<AsyncApiPreview document={{ asyncapi: "3.0.0" }} title="checkout-service" renderer={Throwing} />);
    const frame = screen.getByTestId("asyncapi-preview-iframe");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("asyncapi");
    cleanup();
    render(<AsyncApiPreview document={{ asyncapi: "3.0.0" }} title="t" />);
    expect(screen.getByTestId("react-preview")).toBeDefined();
  });

  it("asks for a document when there is none", () => {
    render(<AsyncApiPreview document={null} title="t" />);
    expect(screen.getByText(/No document to preview/)).toBeDefined();
  });

  it("never lets a document close the script element, whatever it contains", () => {
    const hostile = { info: { title: "<!--<script>", description: "</SCRIPT ><img src=x onerror=alert(1)>" } };
    const html = buildPreviewSrcDoc(hostile, "https://app.test");
    const inline = html.slice(html.lastIndexOf("<script>"));
    // Exactly one closing tag after the final opening tag: the one we wrote.
    expect(inline.match(/<\/script/gi)).toHaveLength(1);
    expect(inline).not.toContain("<!--");
    // The literal round-trips: the browser would see the original document string.
    const literal = /schema: ("(?:[^"\\]|\\.)*")/.exec(inline)?.[1] ?? "";
    expect(JSON.parse(JSON.parse(literal))).toEqual(hostile);
  });

  it("locks the preview document down with a CSP that blocks every remote load", () => {
    const html = buildPreviewSrcDoc({ asyncapi: "3.0.0" }, "https://app.test");
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Only the two same-app assets are allowed as external sources — no wildcards, no other hosts.
    const hosts = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(hosts.sort()).toEqual([
      "https://app.test/api/asyncapi-preview/default.min.css",
      "https://app.test/api/asyncapi-preview/standalone.js",
    ]);
    expect(csp).not.toContain("*");
    // The CSP meta is first in <head>, so it is in force before any resource is requested.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<link"));
  });

  it("sandboxes the forced iframe without allow-same-origin", () => {
    render(<AsyncApiPreview document={{ asyncapi: "3.0.0" }} title="t" forceIframe />);
    const frame = screen.getByTestId("asyncapi-preview-iframe");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(screen.queryByTestId("react-preview")).toBeNull();
  });
});
