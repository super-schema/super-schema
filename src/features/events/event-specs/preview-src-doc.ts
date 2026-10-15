export const PREVIEW_ASSET_BASE = "/api/asyncapi-preview";

/** `window.location.origin` of the app: scheme + host[:port] only. Anything else never reaches the srcdoc. */
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/;

/**
 * Content-Security-Policy for the preview document (set as a `<meta>` because `srcdoc` documents
 * have no response headers). Nothing remote loads: the only external resources are the two
 * same-app assets below; images and fonts may be `data:` URIs; network, forms and `<base>` are
 * closed and every other fetch directive falls back to `default-src 'none'`. The inline bootstrap
 * script needs `'unsafe-inline'` (it embeds the escaped document, see below) and the bundled
 * AsyncAPI parser compiles its JSON-Schema validators with `new Function` (ajv), so it needs
 * `'unsafe-eval'` too — verified in Chromium: without it the bundle fails to initialise. Neither
 * opens a network path (`connect-src 'none'`), and the iframe is sandboxed without
 * `allow-same-origin`, so it has an opaque origin and cannot reach the app.
 */
function previewCsp(origin: string): string {
  const assets = `${origin}${PREVIEW_ASSET_BASE}`;
  return [
    "default-src 'none'",
    `script-src ${assets}/standalone.js 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${assets}/default.min.css 'unsafe-inline'`,
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * D14: HTML for a `sandbox="allow-scripts"` iframe that renders the document with the standalone
 * `@asyncapi/react-component` bundle. The document is passed as a JS string literal with `<`
 * escaped, so no `</script>` can break out of the inline script. The bootstrap fails visibly: if
 * the bundle did not load (asset 4xx/5xx, blocked) or `render` throws, the reason is written into
 * the page instead of leaving a blank frame.
 */
export function buildPreviewSrcDocFromJson(documentJson: string, origin: string): string {
  if (!ORIGIN_PATTERN.test(origin)) throw new Error("Invalid preview origin");
  const literal = JSON.stringify(documentJson).replace(/</g, "\\u003c");
  const bootstrap = [
    "(function () {",
    "var el = document.getElementById(\"asyncapi\");",
    "try {",
    "if (!window.AsyncApiStandalone) throw new Error(\"the AsyncAPI renderer bundle did not load\");",
    `window.AsyncApiStandalone.render({ schema: ${literal}, config: { show: { sidebar: true } } }, el);`,
    "} catch (e) {",
    "el.setAttribute(\"role\", \"alert\");",
    "el.textContent = \"AsyncAPI preview unavailable: \" + (e && e.message ? e.message : String(e));",
    "}",
    "})();",
  ].join("\n");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${previewCsp(origin)}">`,
    `<link rel="stylesheet" href="${origin}${PREVIEW_ASSET_BASE}/default.min.css">`,
    "</head><body><div id=\"asyncapi\"></div>",
    `<script src="${origin}${PREVIEW_ASSET_BASE}/standalone.js"></script>`,
    `<script>${bootstrap}</script>`,
    "</body></html>",
  ].join("");
}

export function buildPreviewSrcDoc(document: object, origin: string): string {
  return buildPreviewSrcDocFromJson(JSON.stringify(document), origin);
}
