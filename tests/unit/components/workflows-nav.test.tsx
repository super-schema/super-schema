// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pathname: "/admin/workflows/environments" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
import { WorkflowsNav } from "@/components/custom/admin/WorkflowsNav";

afterEach(cleanup);
it("links every workflow section and marks the current one", () => {
  h.pathname = "/admin/workflows/gitops";
  render(<WorkflowsNav />);
  const nav = screen.getByRole("navigation", { name: "Workflow settings" });
  expect(nav.querySelectorAll("a")).toHaveLength(4);
  expect(screen.getByRole("link", { name: /Environments/ })).toHaveAttribute("href", "/admin/workflows/environments");
  expect(screen.getByRole("link", { name: /Connections/ })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("link", { name: /GitOps/ })).toHaveAttribute("aria-current", "page");
});
