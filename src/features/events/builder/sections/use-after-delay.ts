"use client";

// src/features/events/builder/sections/use-after-delay.ts
// "Has this been wanted for a moment?": false at first, true once `on` has stayed true for `ms`. Used to hold back a request that costs
// the server seconds until the user has stopped on something, rather than only passed over it (arrowing through a strip of tabs).
// Once it has elapsed it stays true for this component instance, so coming back to the same thing is not delayed again.
import { useEffect, useState } from "react";

export function useAfterDelay(on: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!on) return undefined;
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && elapsed;
}
