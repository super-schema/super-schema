// @vitest-environment jsdom
/**
 * A refused login or registration must leave the e-mail address in its field: the user mistyped a password (or the confirmation), not
 * the address. Found by the browser suite (tests/e2e/auth.spec.ts): the login page re-keyed its whole card to restart the "shake"
 * animation, which remounted the form and emptied the uncontrolled e-mail input; the register page's server action reset its form
 * (React resets a `<form action>` after the action), which emptied the same field.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const signIn = vi.fn();
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => signIn(...args) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const registerAction = vi.fn();
vi.mock("@/app/(auth)/register/actions", () => ({ registerAction: (...args: unknown[]) => registerAction(...args) }));

import { LoginForm as LoginPage } from "@/app/(auth)/login/login-form";
import { RegisterForm as RegisterPage } from "@/app/(auth)/register/register-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

describe("login page", () => {
  it("keeps the e-mail address after a refused login, shows the message, and clears nothing but the password", async () => {
    signIn.mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);

    fireEvent.change(input("login-email"), { target: { value: "me@example.com" } });
    fireEvent.change(input("login-password"), { target: { value: "wrong-password" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });

    await waitFor(() => expect(screen.getByTestId("login-error").textContent).toBe("Invalid email or password"));
    expect(input("login-email").value).toBe("me@example.com");
    // Only the password goes: a refused secret is not left in the field.
    expect(input("login-password").value).toBe("");
    // A second refusal keeps it too (the shake restarts on every refusal).
    fireEvent.change(input("login-password"), { target: { value: "wrong-again" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));
    expect(input("login-email").value).toBe("me@example.com");
    await waitFor(() => expect(input("login-password").value).toBe(""));
  });
});

describe("register page", () => {
  it("keeps the e-mail address after the server refuses the form (a mismatching confirmation)", async () => {
    registerAction.mockResolvedValue({ fieldErrors: { confirmPassword: "Passwords do not match" } });
    render(<RegisterPage />);

    fireEvent.change(input("register-email"), { target: { value: "new@example.com" } });
    fireEvent.change(input("register-password"), { target: { value: "Str0ng!Passw0rd" } });
    fireEvent.change(input("register-confirm-password"), { target: { value: "Str0ng!Passw0rdx" } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("register-form"));
    });

    await waitFor(() => expect(screen.getByTestId("register-confirm-password-error").textContent).toBe("Passwords do not match"));
    expect(input("register-email").value).toBe("new@example.com");
  });
});
