import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The app's checkbox: a native `<input type="checkbox">` (so forms, labels, `onChange` and test `check()` calls keep working),
 * sized and colored to sit beside `text-sm` labels.
 */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded-[4px] accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Checkbox }
