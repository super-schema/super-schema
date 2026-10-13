import { beforeEach, describe, expect, it, vi } from "vitest";

const { hashMock, signInMock, tx, mockPrisma } = vi.hoisted(() => {
  const transactionClient = {
    user: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    userRole: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };

  return {
    hashMock: vi.fn(),
    signInMock: vi.fn(),
    tx: transactionClient,
    mockPrisma: {
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(
        async (callback: (client: typeof transactionClient) => Promise<void>) =>
          callback(transactionClient)
      ),
    },
  };
});

vi.mock("bcryptjs", () => ({
  default: { hash: hashMock },
}));

vi.mock("@/lib/auth", () => ({
  signIn: signInMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

import { registerAction } from "@/app/(auth)/register/actions";

function registrationData() {
  const formData = new FormData();
  formData.set("email", "first@example.com");
  formData.set("password", "password123");
  formData.set("confirmPassword", "password123");
  return formData;
}

describe("registerAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(null);
    hashMock.mockResolvedValue("hashed-password");
    tx.user.create.mockResolvedValue({ id: "first-user" });
    tx.userRole.findFirst.mockResolvedValue(null);
    tx.user.findFirst.mockResolvedValue({ id: "first-user" });
    tx.userRole.create.mockResolvedValue({ id: "admin-role" });
    signInMock.mockResolvedValue(undefined);
  });

  it("creates the user and initial Admin assignment in one transaction", async () => {
    await registerAction(undefined, registrationData());

    expect(tx.user.create).toHaveBeenCalledWith({
      data: {
        email: "first@example.com",
        password: "hashed-password",
      },
    });
    expect(tx.userRole.create).toHaveBeenCalledWith({
      data: {
        id: "system-bootstrap-global-admin",
        userId: "first-user",
        role: "ADMIN",
        domainId: null,
      },
    });
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      email: "first@example.com",
      password: "password123",
      redirectTo: "/schemas",
    });
  });
});
