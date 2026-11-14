"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={cn(
      "group inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted p-0.5 transition-colors data-checked:border-primary data-checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50", className
    )} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb"
        className="pointer-events-none block size-4.5 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-5 motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}
