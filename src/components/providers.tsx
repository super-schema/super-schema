"use client";

import { ThemeProvider } from "next-themes";

/**
 * App-level providers.
 *
 * Wraps children with next-themes ThemeProvider so that useTheme() works
 * throughout the component tree.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
