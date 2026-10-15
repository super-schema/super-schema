// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncApiPreview } from "@/features/events/event-specs/AsyncApiPreview";
import { buildPreviewSrcDoc } from "@/features/events/event-specs/preview-src-doc";

afterEach(() => cleanup());

const ORIGIN = "https://app.test";

/** Runs the srcdoc's inline bootstrap against a fresh document, with `globals` as `window`. */
function runBootstrap(html: string, globals: Record<string, unknown>) {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const inline = [...dom.querySelectorAll("script:not([src])")].map((s) => s.textContent ?? "").join("\n");
  const target = document.implementation.createHTMLDocument("t");
  target.body.innerHTML = '<div id="asyncapi"></div>';
  new Function("document", "window", inline)(target, globals);
  return target.getElementById("asyncapi") as HTMLElement;
}

describe("AsyncAPI preview (D14, iframe only)", () => {
  it("escapes the document so it cannot break out of the inline script", () => {
    const html = buildPreviewSrcDoc({ info: { title: "</script><script>alert(1)</script>" } }, ORIGIN);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain('<script src="https://app.test/api/asyncapi-preview/standalone.js"></script>');
    expect(html).toContain("AsyncApiStandalone.render(");
  });

  it("never lets a document close the script element, whatever it contains", () => {
    const hostile = { info: { title: "<!--<script>", description: "</SCRIPT ><img src=x onerror=alert(1)>" } };
    const html = buildPreviewSrcDoc(hostile, ORIGIN);
    const inline = html.slice(html.lastIndexOf("<script>"));
    // Exactly one closing tag after the final opening tag: the one we wrote.
    expect(inline.match(/<\/script/gi)).toHaveLength(1);
    expect(inline).not.toContain("<!--");
    // The literal round-trips: the browser would see the original document string.
    const literal = /schema: ("(?:[^"\\]|\\.)*")/.exec(inline)?.[1] ?? "";
    expect(JSON.parse(JSON.parse(literal))).toEqual(hostile);
  });

  it("locks the preview document down with a CSP that blocks every remote load", () => {
    const html = buildPreviewSrcDoc({ asyncapi: "3.0.0" }, ORIGIN);
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

  it("rejects an origin that is not plain scheme://host[:port]", () => {
    for (const bad of ["", "javascript:alert(1)", 'https://a.test"><script>x</script>', "https://a.test/path", "https://a.test;", "//a.test", "null", "https://a b.test"]) {
      expect(() => buildPreviewSrcDoc({}, bad), bad).toThrow(/Invalid preview origin/);
    }
    for (const ok of ["http://localhost:3000", "https://app.example.com", "http://127.0.0.1:8080", "http://[::1]:3000"]) {
      expect(() => buildPreviewSrcDoc({}, ok), ok).not.toThrow();
    }
  });

  it("bootstrap renders the document into #asyncapi when the bundle is loaded", () => {
    const doc = { asyncapi: "3.0.0", info: { title: "</script>x" } };
    const render = vi.fn();
    const el = runBootstrap(buildPreviewSrcDoc(doc, ORIGIN), { AsyncApiStandalone: { render } });
    expect(render).toHaveBeenCalledTimes(1);
    const [props, container] = render.mock.calls[0] as [{ schema: string }, HTMLElement];
    expect(JSON.parse(props.schema)).toEqual(doc);
    expect(container).toBe(el);
    expect(el.textContent).toBe("");
  });

  it("bootstrap fails visibly when the standalone bundle did not load", () => {
    const el = runBootstrap(buildPreviewSrcDoc({ asyncapi: "3.0.0" }, ORIGIN), {});
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.textContent).toMatch(/AsyncAPI preview unavailable: the AsyncAPI renderer bundle did not load/);
  });

  it("bootstrap fails visibly when render throws, without interpreting the message as HTML", () => {
    const render = vi.fn(() => {
      throw new Error("<img src=x onerror=alert(1)> boom");
    });
    const el = runBootstrap(buildPreviewSrcDoc({ asyncapi: "3.0.0" }, ORIGIN), { AsyncApiStandalone: { render } });
    expect(el.textContent).toBe("AsyncAPI preview unavailable: <img src=x onerror=alert(1)> boom");
    expect(el.querySelector("img")).toBeNull();
  });

  it("renders only the sandboxed iframe, never the component in the app DOM", () => {
    const { container } = render(<AsyncApiPreview document={{ asyncapi: "3.0.0" }} title="checkout-service" />);
    const frame = screen.getByTestId("asyncapi-preview-iframe");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("title")).toBe("checkout-service preview");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(container.querySelector(".aui-root")).toBeNull();
  });

  it("keeps the same srcdoc (no iframe reload) when an equal document arrives as a new object", () => {
    const { rerender } = render(<AsyncApiPreview document={{ asyncapi: "3.0.0", info: { title: "a" } }} title="t" />);
    const first = screen.getByTestId("asyncapi-preview-iframe");
    const before = first.getAttribute("srcdoc");
    rerender(<AsyncApiPreview document={{ asyncapi: "3.0.0", info: { title: "a" } }} title="t" />);
    expect(screen.getByTestId("asyncapi-preview-iframe")).toBe(first);
    expect(first.getAttribute("srcdoc")).toBe(before);
    rerender(<AsyncApiPreview document={{ asyncapi: "3.0.0", info: { title: "b" } }} title="t" />);
    expect(first.getAttribute("srcdoc")).not.toBe(before);
  });

  it("asks for a document when there is none", () => {
    render(<AsyncApiPreview document={null} title="t" />);
    expect(screen.getByText(/No document to preview/)).toBeDefined();
    expect(screen.queryByTestId("asyncapi-preview-iframe")).toBeNull();
  });
});
