// @vitest-environment jsdom
/**
 * A login form that is submitted BEFORE React has hydrated it is submitted by the browser itself: without a `method` that is a GET, and
 * the password lands in the address bar, the history, the Referer of the next request and the server's access log. Two defences, each
 * checked here on the HTML the server sends (what a browser has before any script ran):
 *   - the form says `method="post"`, so credentials can never be put in a query string, whatever happens;
 *   - the submit button is disabled until the component has mounted on the client, which also stops Enter in a field (implicit
 *     submission is blocked while the default button is disabled).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import LoginPage from "@/app/(auth)/login/page";

afterEach(cleanup);

/** The attributes of the first tag of `html` that carries the test id. */
function tagOf(html: string, testId: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!match) throw new Error(`no element with data-testid="${testId}" in the server HTML`);
  return match[0];
}

describe("login page before hydration (the server's HTML)", () => {
  const html = renderToString(<LoginPage />);

  it("has a form that posts, never a GET", () => {
    expect(tagOf(html, "login-form")).toMatch(/\smethod="post"/i);
  });

  it("has a submit button that is disabled until the page is interactive", () => {
    expect(tagOf(html, "login-submit")).toMatch(/\sdisabled(=""|\s|>)/);
  });
});

describe("login page after it mounted", () => {
  it("enables the submit button", () => {
    render(<LoginPage />);
    expect((screen.getByTestId("login-submit") as HTMLButtonElement).disabled).toBe(false);
  });
});
