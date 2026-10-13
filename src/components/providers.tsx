"use client";

import { QueryProvider } from "@/components/QueryProvider";
import { ThemeProvider } from "@/lib/theme";
import { useFontSize } from "@/lib/font-size";

/**
 * Applies the app theme and font scale without rendering inline hydration
 * scripts from a client component.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  useFontSize();

  return (
    <QueryProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryProvider>
  );
}
