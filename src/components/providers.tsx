"use client";

import { QueryProvider } from "@/components/QueryProvider";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/lib/theme";
import { useFontSize } from "@/lib/font-size";

/**
 * Applies the app theme and font scale without rendering inline hydration
 * scripts from a client component. Also hosts the toast outlet: every
 * `toast.success / toast.error` call in the app ("Draft saved", "Published … v1.0", …)
 * is invisible unless a `<Toaster />` is mounted once, here.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  useFontSize();

  return (
    <QueryProvider>
      <ThemeProvider>
        {children}
        <Toaster />
      </ThemeProvider>
    </QueryProvider>
  );
}
