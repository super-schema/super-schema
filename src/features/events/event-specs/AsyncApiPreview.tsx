"use client";

import { Component, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import dynamic from "next/dynamic";
import "@asyncapi/react-component/styles/default.min.css";
import { buildPreviewSrcDoc } from "./preview-src-doc";

type RendererProps = { schema: string };

/**
 * Client-only (spec §9): the component bundles @asyncapi/parser for the browser. Its CSS is scoped
 * under `.aui-root`. Imports the package's prebuilt browser bundle — `lib/esm` pulls the parser's
 * Node entry (`fs`), which `next build` (Turbopack) cannot bundle for the client.
 */
const AsyncApiReact = dynamic<RendererProps>(
  () => import("@asyncapi/react-component/browser/index.js").then((m) => m.default as ComponentType<RendererProps>),
  { ssr: false, loading: () => <p className="text-body-small text-muted-foreground">Loading preview…</p> }
);

class PreviewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const subscribeNoop = () => () => {};

function IframePreview({ document, title }: { document: object; title: string }) {
  // The origin is only known in the browser. Until then (server render and the hydration pass) render
  // a placeholder: a srcdoc built with an empty origin would carry relative asset URLs and an invalid
  // CSP, and the iframe would load twice once the real origin arrives.
  const origin = useSyncExternalStore(subscribeNoop, () => window.location.origin, () => "");
  const srcDoc = useMemo(() => (origin ? buildPreviewSrcDoc(document, origin) : ""), [document, origin]);
  if (!srcDoc) return <p className="text-body-small text-muted-foreground">Loading preview…</p>;
  return (
    <iframe
      title={`${title} preview`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="h-[70vh] w-full rounded-lg border border-border bg-white"
      data-testid="asyncapi-preview-iframe"
    />
  );
}

export function AsyncApiPreview({
  document, title, forceIframe = false, renderer: Renderer = AsyncApiReact,
}: {
  document: object | null;
  title: string;
  forceIframe?: boolean;
  /** Injectable for tests; defaults to the dynamic `@asyncapi/react-component`. */
  renderer?: ComponentType<RendererProps>;
}) {
  const schema = useMemo(() => (document ? JSON.stringify(document) : ""), [document]);
  if (!document) return <p className="text-body-small text-muted-foreground">No document to preview — fix the diagnostics first.</p>;
  const iframe = <IframePreview document={document} title={title} />;
  if (forceIframe) return iframe;
  return (
    <div className="rounded-lg border border-border bg-white" data-testid="asyncapi-preview">
      <PreviewBoundary fallback={iframe}>
        <Renderer schema={schema} />
      </PreviewBoundary>
    </div>
  );
}
