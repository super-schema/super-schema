"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface RightPanelContentState {
  content: ReactNode | null;
  setContent: (content: ReactNode | null) => void;
  onExpandRequest: (() => void) | null;
  registerExpandHandler: (handler: () => void) => void;
}

const RightPanelContentContext = createContext<RightPanelContentState>({
  content: null,
  setContent: () => {},
  onExpandRequest: null,
  registerExpandHandler: () => {},
});

export function RightPanelContentProvider({ children }: { children: ReactNode }) {
  const [content, setContentState] = useState<ReactNode | null>(null);
  const [expandHandler, setExpandHandler] = useState<(() => void) | null>(null);

  const setContent = useCallback((node: ReactNode | null) => {
    setContentState(node);
    // Auto-expand when content is pushed
    if (node && expandHandler) {
      expandHandler();
    }
  }, [expandHandler]);

  const registerExpandHandler = useCallback((handler: () => void) => {
    setExpandHandler(() => handler);
  }, []);

  return (
    <RightPanelContentContext.Provider value={{ content, setContent, onExpandRequest: expandHandler, registerExpandHandler }}>
      {children}
    </RightPanelContentContext.Provider>
  );
}

export function useRightPanelContent() {
  return useContext(RightPanelContentContext);
}
