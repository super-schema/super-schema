"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface RightPanelContentState {
  content: ReactNode | null;
  setContent: (content: ReactNode | null) => void;
}

const RightPanelContentContext = createContext<RightPanelContentState>({
  content: null,
  setContent: () => {},
});

export function RightPanelContentProvider({ children }: { children: ReactNode }) {
  const [content, setContentState] = useState<ReactNode | null>(null);

  const setContent = useCallback((node: ReactNode | null) => {
    setContentState(node);
  }, []);

  return (
    <RightPanelContentContext.Provider value={{ content, setContent }}>
      {children}
    </RightPanelContentContext.Provider>
  );
}

export function useRightPanelContent() {
  return useContext(RightPanelContentContext);
}
