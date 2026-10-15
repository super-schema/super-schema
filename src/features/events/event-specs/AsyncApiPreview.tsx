"use client";

import { useMemo, useSyncExternalStore } from "react";
import { buildPreviewSrcDocFromJson } from "./preview-src-doc";

const subscribeNoop = () => () => {};

/**
 * AsyncAPI document preview — rendered ONLY inside a CSP-locked, sandboxed iframe (see
 * `buildPreviewSrcDoc`), never in the app's own DOM. Decision R65 (2026-10-14): `@asyncapi/react-component`
 * renders user-authored markdown, and its DOMPurify defaults keep `<img src=https://…>`,
 * `<style>@import …`, `<form action=https://…>` and inline `style=url(…)`. Inside the app origin that
 * means tracking requests, global CSS injection and credential-overlay forms, and the app sets no CSP.
 * In the iframe the document has an opaque origin (`sandbox` without `allow-same-origin`), cannot reach
 * the app's cookies, storage or DOM, and its CSP blocks every remote load. The component also could not
 * be imported in-app anyway: `lib/esm` fails `next build` (`fs`), only the prebuilt bundle works.
 */
function IframePreview({ documentJson, title }: { documentJson: string; title: string }) {
  // The origin is only known in the browser. Until then (server render and the hydration pass) render
  // a placeholder: a srcdoc built with an empty origin would carry relative asset URLs and an invalid
  // CSP, and the iframe would load twice once the real origin arrived.
  const origin = useSyncExternalStore(subscribeNoop, () => window.location.origin, () => "");
  // Keyed on the serialized document, not object identity: a re-render with an equal document must not
  // produce a new srcdoc string, which would reload the iframe and lose the reader's scroll position.
  const built = useMemo(() => {
    if (!origin) return null;
    try {
      return { srcDoc: buildPreviewSrcDocFromJson(documentJson, origin) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [documentJson, origin]);
  if (!built) return <p className="text-body-small text-muted-foreground">Loading preview…</p>;
  if ("error" in built) {
    return <p role="alert" className="text-body-small text-destructive">Preview unavailable: {built.error}</p>;
  }
  return (
    <iframe
      title={`${title} preview`}
      sandbox="allow-scripts"
      srcDoc={built.srcDoc}
      className="h-[70vh] w-full rounded-lg border border-border bg-white"
      data-testid="asyncapi-preview-iframe"
    />
  );
}

export function AsyncApiPreview({ document, title }: { document: object | null; title: string }) {
  const documentJson = document ? JSON.stringify(document) : null;
  if (documentJson === null) {
    return <p className="text-body-small text-muted-foreground">No document to preview — fix the diagnostics first.</p>;
  }
  return <IframePreview documentJson={documentJson} title={title} />;
}
