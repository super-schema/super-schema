import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { productionSecretProblem } from "@/lib/auth-secret";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    // In production the secret must be strong (32+ characters, not a development value): the session cookie is signed with it. Development
    // and test accept any non-empty value. The same rule is enforced when the server starts (src/instrumentation.ts), because this schema is
    // only checked where it is imported.
    NEXTAUTH_SECRET: z
      .string()
      .min(1)
      .superRefine((value, ctx) => {
        if (process.env.NODE_ENV !== "production") return;
        const problem = productionSecretProblem(value);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    NEXTAUTH_URL: z.string().url(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  },
});
