"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ButtonProps = React.ComponentProps<typeof Button>;

interface GuardedButtonProps extends Omit<ButtonProps, "disabled"> {
  /** The reason the control is unavailable, in the server's own words; `null` or absent leaves it working. */
  blockedReason?: string | null;
}

/**
 * A button that can be unavailable FOR A REASON the person needs to read (you cannot disable yourself, the last administrator stays). A native `disabled`
 * button cannot be focused and says nothing, so this one stays in the tab order with `aria-disabled`, does nothing when activated, shows the reason as its
 * tooltip (`title`) and is described by it for screen readers. The server refuses the same act whatever the button does: this is the explanation, not the guard.
 */
export function GuardedButton({ blockedReason, onClick, className, children, ...props }: GuardedButtonProps) {
  const reasonId = useId();
  const blocked = typeof blockedReason === "string" && blockedReason !== "";
  return (
    <>
      <Button
        {...props}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={blocked ? reasonId : props["aria-describedby"]}
        title={blocked ? blockedReason : props.title}
        data-blocked={blocked ? "true" : undefined}
        className={cn(blocked && "cursor-not-allowed opacity-50", className)}
        onClick={blocked ? (event) => event.preventDefault() : onClick}
      >
        {children}
      </Button>
      {blocked && (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      )}
    </>
  );
}
