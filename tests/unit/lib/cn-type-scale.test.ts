import { cn } from "@/lib/utils";
import { it, expect } from "vitest";
it("keeps type scale next to colours", () => {
  expect(cn("text-caption", "text-muted-foreground")).toBe("text-caption text-muted-foreground");
  expect(cn("text-sm", "text-caption")).toBe("text-caption");
  expect(cn("text-foreground", "text-destructive")).toBe("text-destructive");
});
