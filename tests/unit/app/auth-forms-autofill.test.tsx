// @vitest-environment jsdom
/**
 * Browser autofill (and password managers) can put a value in a field without firing the `change` event React listens to, so the
 * state of a controlled input is then "" while the DOM has the address. The forms must send what the DOM has (the user sees it),
 * and must keep it after a refusal.
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

import { LoginForm as LoginPage } from "@/app/(auth)/login/login-form";
import { RegisterForm as RegisterPage } from "@/app/(auth)/register/register-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

/** What autofill does: the DOM value changes through the prototype's setter, and no event reaches React. */
function autofill(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
}

describe("login page", () => {
  it("signs in with the address the DOM holds, though the state never heard of it", async () => {
    signIn.mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);

    autofill(input("login-email"), "autofilled@example.com");
    autofill(input("login-password"), "secret-from-the-manager");
    await act(async () => {
      fireEvent.submit(screen.getByTestId("login-form"));
    });

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith("credentials", expect.objectContaining({ email: "autofilled@example.com", password: "secret-from-the-manager" }));
    // ... and the refusal keeps the address in the field.
    await waitFor(() => expect(screen.getByTestId("login-error")).toBeTruthy());
    expect(input("login-email").value).toBe("autofilled@example.com");
  });
});

describe("register page", () => {
  it("keeps the address the DOM holds after the server refused the form", async () => {
    registerAction.mockResolvedValue({ fieldErrors: { confirmPassword: "Passwords do not match" } });
    render(<RegisterPage />);

    fireEvent.change(input("register-password"), { target: { value: "Str0ng!Passw0rd" } });
    fireEvent.change(input("register-confirm-password"), { target: { value: "Str0ng!Passw0rdx" } });
    // Last: any later render would put the state's "" back into the field, as React does for a controlled input.
    autofill(input("register-email"), "autofilled@example.com");
    await act(async () => {
      fireEvent.submit(screen.getByTestId("register-form"));
    });

    await waitFor(() => expect(screen.getByTestId("register-confirm-password-error").textContent).toBe("Passwords do not match"));
    expect(input("register-email").value).toBe("autofilled@example.com");
  });
});
