"use server";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { signIn } from "@/lib/auth";

const registerSchema = z
  .object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type RegisterState = {
  error?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
    confirmPassword?: string;
  };
};

export async function registerAction(
  _prevState: RegisterState | undefined,
  formData: FormData
): Promise<RegisterState | undefined> {
  const raw = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
    confirmPassword: formData.get("confirmPassword") as string,
  };

  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: RegisterState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof typeof fieldErrors;
      if (field && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
    }
    return { fieldErrors };
  }

  const { email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { fieldErrors: { email: "An account with this email already exists" } };
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: { email, password: hashedPassword },
  });

  await signIn("credentials", {
    email,
    password,
    redirectTo: "/schemas",
  });
}
