// @vitest-environment jsdom
/**
 * The login and register forms for someone who does not see them: every field has a label it is tied to (the password field of the login
 * page had no accessible name at all), a refusal is announced (role="alert"), and after a refusal the focus is in the field to fix
 * (the login card is re-keyed for its shake animation, which drops the focused element).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const signIn = vi.fn();
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => signIn(...args) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const registerAction = vi.fn();
vi.mock("@/app/(auth)/register/actions", () => ({ registerAction: (...args: unknown[]) => registerAction(...args) }));

import LoginPage from "@/app/(auth)/login/page";
import RegisterPage from "@/app/(auth)/register/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

describe("login page", () => {
  it("ties a label to every field: getByLabel finds the e-mail and the password input", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText("Email")).toBe(input("login-email"));
    expect(screen.getByLabelText("Password")).toBe(input("login-password"));
  });

  it("announces a refusal with role=alert, links the fields to it, and puts the focus in the e-mail field", async () => {
    signIn.mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);
    fireEvent.change(input("login-email"), { target: { value: "me@example.com" } });
    fireEvent.change(input("login-password"), { target: { value: "wrong" } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("login-form"));
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Invalid email or password");
    // The card was re-keyed (shake): the field that has the focus is the NEW e-mail field.
    await waitFor(() => expect(document.activeElement).toBe(input("login-email")));
    expect(input("login-email").getAttribute("aria-describedby")).toBe(alert.id);
    expect(input("login-password").getAttribute("aria-describedby")).toBe(alert.id);
    // The shake is still there.
    expect(screen.getByTestId("login-card").className).toContain("animate-auth-shake");
  });
});

describe("register page", () => {
  it("ties a label to every field", () => {
    render(<RegisterPage />);
    expect(screen.getByLabelText("Email")).toBe(input("register-email"));
    expect(screen.getByLabelText("Password")).toBe(input("register-password"));
    expect(screen.getByLabelText("Confirm Password")).toBe(input("register-confirm-password"));
  });

  async function submitWith(result: unknown) {
    registerAction.mockResolvedValue(result);
    render(<RegisterPage />);
    fireEvent.change(input("register-email"), { target: { value: "new@example.com" } });
    fireEvent.change(input("register-password"), { target: { value: "Str0ng!Passw0rd" } });
    fireEvent.change(input("register-confirm-password"), { target: { value: "Str0ng!Passw0rd" } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("register-form"));
    });
  }

  it("announces a general refusal with role=alert and focuses the e-mail field", async () => {
    await submitWith({ error: "Registration failed. Please try again." });
    expect((await screen.findByRole("alert")).textContent).toBe("Registration failed. Please try again.");
    await waitFor(() => expect(document.activeElement).toBe(input("register-email")));
  });

  it("focuses the first field that has an error, and links it to its message", async () => {
    await submitWith({ fieldErrors: { email: "An account with this email already exists" } });
    await waitFor(() => expect(document.activeElement).toBe(input("register-email")));
    const message = screen.getByTestId("register-email-error");
    expect(input("register-email").getAttribute("aria-describedby")).toBe(message.id);
  });

  it("focuses the confirmation when that is the only field with an error", async () => {
    await submitWith({ fieldErrors: { confirmPassword: "Passwords do not match" } });
    await waitFor(() => expect(document.activeElement).toBe(input("register-confirm-password")));
    expect(input("register-confirm-password").getAttribute("aria-describedby")).toBe(screen.getByTestId("register-confirm-password-error").id);
  });

  it("focuses the password when the password has the first error", async () => {
    await submitWith({ fieldErrors: { password: "Password must be at least 8 characters", confirmPassword: "Passwords do not match" } });
    await waitFor(() => expect(document.activeElement).toBe(input("register-password")));
  });
});
