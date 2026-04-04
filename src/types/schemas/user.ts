import { z } from "zod";

export const UpdateUserInputSchema = z.object({
  id: z.string().min(1, "User ID is required"),
  name: z.string().min(1, "Name is required").optional(),
});

export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;
