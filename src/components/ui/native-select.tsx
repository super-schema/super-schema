import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The app's form select: a native `<select>` styled to match `Input` (height, border, radius, focus ring, dark surface), with one
 * chevron drawn in CSS so it needs no wrapper and drops in wherever a `<select>` sits. Use `Select` (popup listbox) only when options
 * need rich content; a plain value choice belongs here.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 cursor-pointer appearance-none rounded-lg border border-input bg-transparent bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")] bg-size-[14px] bg-position-[right_0.5rem_center] bg-no-repeat py-1 pr-7 pl-2.5 text-sm text-foreground transition-[color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
