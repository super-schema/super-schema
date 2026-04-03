import { describe, it, expect } from "vitest";
import { ok, err } from "@/types/result";
import type { Result, ServiceError } from "@/types/result";

describe("Result type helpers", () => {
  it("ok() returns a success result", () => {
    const result = ok({ id: "1", name: "Test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id: "1", name: "Test" });
    }
  });

  it("err() returns a failure result", () => {
    const result = err({
      code: "NOT_FOUND",
      message: "Entity not found",
      suggestedFix: "Check the entity ID",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("Entity not found");
      expect(result.error.suggestedFix).toBe("Check the entity ID");
    }
  });

  it("Result type can be used in conditional narrowing", () => {
    const result: Result<string> = ok("hello");

    if (result.success) {
      const data: string = result.data;
      expect(data).toBe("hello");
    } else {
      const error: ServiceError = result.error;
      expect(error).toBeDefined();
    }
  });

  it("err() with details object", () => {
    const result = err({
      code: "VALIDATION_ERROR",
      message: "Invalid input",
      details: { field: "email", value: "not-an-email" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.details).toEqual({
        field: "email",
        value: "not-an-email",
      });
    }
  });
});
