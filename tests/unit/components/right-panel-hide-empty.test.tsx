// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { RightPanel } from "@/components/layout/RightPanel";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import {
  RightPanelContentProvider,
  useRightPanelContent,
} from "@/hooks/useRightPanelContent";

afterEach(cleanup);

const noop = () => {};
const panelProps = {
  width: 400,
  isCollapsed: false,
  onMouseDown: noop,
  onDoubleClick: noop,
  onCollapse: noop,
};

/** Mirrors DashboardShell: the panel reads the flag and content from context. */
function Shell({ children }: { children?: ReactNode }) {
  const { content, hideWhenEmpty } = useRightPanelContent();
  return (
    <>
      {children}
      <RightPanel {...panelProps} hideWhenEmpty={hideWhenEmpty}>
        {content}
      </RightPanel>
    </>
  );
}

describe("RightPanel hideWhenEmpty", () => {
  it("still shows the empty Detail Panel by default", () => {
    render(<RightPanel {...panelProps} />);
    expect(screen.getByText("Detail Panel")).toBeDefined();
  });

  it("hides the empty placeholder when the flag is set", () => {
    render(<RightPanel {...panelProps} hideWhenEmpty />);
    expect(screen.queryByText("Detail Panel")).toBeNull();
    expect(screen.getByTestId("right-panel").getAttribute("data-collapsed")).toBe("true");
  });

  it("still shows pushed content with the flag set", () => {
    render(
      <RightPanel {...panelProps} hideWhenEmpty>
        <div>field editor</div>
      </RightPanel>
    );
    expect(screen.getByText("field editor")).toBeDefined();
  });
});

describe("HideEmptyRightPanel", () => {
  it("hides the placeholder while mounted and restores it on unmount", () => {
    const tree = (withFlag: boolean) => (
      <RightPanelContentProvider>
        <Shell>{withFlag ? <HideEmptyRightPanel /> : null}</Shell>
      </RightPanelContentProvider>
    );
    const { rerender } = render(tree(true));
    expect(screen.queryByText("Detail Panel")).toBeNull();

    rerender(tree(false));
    expect(screen.getByText("Detail Panel")).toBeDefined();
  });
});
