// `@asyncapi/react-component` ships no types for its prebuilt browser (UMD) bundle. The bundle is
// self-contained apart from React, which is why the preview imports it instead of `lib/esm` —
// that build pulls `@asyncapi/parser`'s Node entry (`fs`, ...), which Turbopack cannot bundle for
// the browser. Its default export is the same component the package root exports.
declare module "@asyncapi/react-component/browser/index.js" {
  import type { ComponentType } from "react";

  const AsyncApiComponent: ComponentType<{ schema: string; config?: Record<string, unknown> }>;
  export default AsyncApiComponent;
}
