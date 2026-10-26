// @vitest-environment node
/** The "no access yet" screen (a placeholder the sign-in task completes): it says what happened, tells nothing about why, and offers a way out. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NoAccessPage from "@/app/(auth)/no-access/page";
import { NO_ACCESS_PATH } from "@/lib/access/no-tenant-access";

describe("/no-access", () => {
  it("is the path the dashboard sends a user with no tenant access to", () => {
    expect(NO_ACCESS_PATH).toBe("/no-access");
  });

  it("explains that no role has been assigned, says the same to a disabled account (no reason given), and offers sign out", () => {
    const html = renderToStaticMarkup(<NoAccessPage />);
    expect(html).toContain('data-testid="no-access"');
    expect(html).toContain("No access yet");
    expect(html).toContain("no role has been assigned");
    expect(html).toContain('href="/api/auth/signout"');
    expect(html).not.toMatch(/disabled|suspended|deactivated/i);
  });
});
