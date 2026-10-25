import { beforeEach, describe, expect, it, vi } from "vitest";

const { hashMock, signInMock, mockPrisma } = vi.hoisted(() => ({
  hashMock: vi.fn(),
  signInMock: vi.fn(),
  mockPrisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    userRole: { create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

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
    mockPrisma.user.create.mockResolvedValue({ id: "new-user" });
    hashMock.mockResolvedValue("hashed-password");
    signInMock.mockResolvedValue(undefined);
  });

  it("creates a user with no role at all, even when it is the first user of an empty database", async () => {
    await registerAction(undefined, registrationData());

    expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { email: "first@example.com", password: "hashed-password" },
    });
    // No bootstrap, no role of any kind is written by registering (the first administrator comes from the seed or `admin:create`).
    expect(mockPrisma.userRole.create).not.toHaveBeenCalled();
    expect(mockPrisma.userRole.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      email: "first@example.com",
      password: "password123",
      redirectTo: "/schemas",
    });
  });

  it("answers that the e-mail is taken when it exists, without creating anything", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "someone" });

    const state = await registerAction(undefined, registrationData());

    expect(state).toEqual({ fieldErrors: { email: "An account with this email already exists" } });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("answers the same when the database refuses a duplicate that won the race (or differs only by letter case)", async () => {
    mockPrisma.user.create.mockRejectedValue(new Error("Unique constraint failed on the fields: (`email`)"));

    const state = await registerAction(undefined, registrationData());

    expect(state).toEqual({ fieldErrors: { email: "An account with this email already exists" } });
    expect(signInMock).not.toHaveBeenCalled();
  });
});
