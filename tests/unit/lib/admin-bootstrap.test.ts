import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { ensureFirstAdminAssignment } from "@/lib/admin-bootstrap";

const findAdmin = vi.fn();
const findFirstUser = vi.fn();
const createRole = vi.fn();

const db = {
  user: { findFirst: findFirstUser },
  userRole: {
    findFirst: findAdmin,
    create: createRole,
  },
} as unknown as Pick<Prisma.TransactionClient, "user" | "userRole">;

describe("ensureFirstAdminAssignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an existing global Admin without creating another role", async () => {
    findAdmin.mockResolvedValue({ userId: "admin-1" });

    await expect(ensureFirstAdminAssignment(db)).resolves.toBe("admin-1");
    expect(findFirstUser).not.toHaveBeenCalled();
    expect(createRole).not.toHaveBeenCalled();
  });

  it("assigns the initial global Admin role to the earliest user", async () => {
    findAdmin.mockResolvedValue(null);
    findFirstUser.mockResolvedValue({ id: "first-user" });
    createRole.mockResolvedValue({ id: "role-1" });

    await expect(ensureFirstAdminAssignment(db)).resolves.toBe("first-user");
    expect(findFirstUser).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(createRole).toHaveBeenCalledWith({
      data: {
        id: "system-bootstrap-global-admin",
        userId: "first-user",
        role: "ADMIN",
        domainId: null,
      },
    });
  });

  it("returns null when the installation has no users", async () => {
    findAdmin.mockResolvedValue(null);
    findFirstUser.mockResolvedValue(null);

    await expect(ensureFirstAdminAssignment(db)).resolves.toBeNull();
    expect(createRole).not.toHaveBeenCalled();
  });

  it("accepts a concurrent bootstrap winner", async () => {
    findAdmin
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: "first-user" });
    findFirstUser.mockResolvedValue({ id: "first-user" });
    createRole.mockRejectedValue(new Error("Unique constraint"));

    await expect(ensureFirstAdminAssignment(db)).resolves.toBe("first-user");
  });
});
