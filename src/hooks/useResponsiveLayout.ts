"use client";

import { useState, useEffect } from "react";

type Breakpoint = "compact" | "standard" | "comfortable" | "spacious";

interface BreakpointConfig {
  breakpoint: Breakpoint;
  sidebar: number;
  rightPanel: number;
  autoCollapse: boolean;
}

const BREAKPOINTS: BreakpointConfig[] = [
  { breakpoint: "compact", sidebar: 0, rightPanel: 0, autoCollapse: true },
  { breakpoint: "standard", sidebar: 240, rightPanel: 320, autoCollapse: false },
  { breakpoint: "comfortable", sidebar: 280, rightPanel: 400, autoCollapse: false },
  { breakpoint: "spacious", sidebar: 320, rightPanel: 480, autoCollapse: false },
];

function getBreakpoint(width: number): BreakpointConfig {
  if (width < 1280) return BREAKPOINTS[0];
  if (width < 1600) return BREAKPOINTS[1];
  if (width < 1920) return BREAKPOINTS[2];
  return BREAKPOINTS[3];
}

export function useResponsiveLayout() {
  const [config, setConfig] = useState<BreakpointConfig>(BREAKPOINTS[1]);

  useEffect(() => {
    const update = () => {
      setConfig(getBreakpoint(window.innerWidth));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return config;
}
