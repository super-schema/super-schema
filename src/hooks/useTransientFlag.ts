"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A flag that is on for `ms` after `flash()` and then goes off by itself (a "Copied!" label, a "Saved" flash).
 *
 * The timer is owned by the hook: it is cleared when the component unmounts and before it is armed again. A bare
 * `setTimeout(() => setCopied(false), 2000)` runs after the component is gone, and in a test after the jsdom window is torn down
 * ("window is not defined", which makes vitest exit 1 with every test green); flashing twice also lets the first timer cut the second
 * short.
 */
export function useTransientFlag(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    []
  );

  const flash = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setOn(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setOn(false);
    }, ms);
  }, [ms]);

  return [on, flash];
}
