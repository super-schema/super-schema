import { describe, it, expect } from "vitest";
import { classifyChangeLevel } from "@/lib/validation/change-level";

describe("classifyChangeLevel", () => {
  it("classifies type change as major", () => {
    expect(classifyChangeLevel(["type"])).toBe("major");
  });

  it("classifies nullable change as major", () => {
    expect(classifyChangeLevel(["nullable"])).toBe("major");
  });

  it("classifies isKey change as major", () => {
    expect(classifyChangeLevel(["isKey"])).toBe("major");
  });

  it("classifies precision change as major", () => {
    expect(classifyChangeLevel(["precision"])).toBe("major");
  });

  it("classifies scale change as major", () => {
    expect(classifyChangeLevel(["scale"])).toBe("major");
  });

  it("classifies classification change as major", () => {
    expect(classifyChangeLevel(["classification"])).toBe("major");
  });

  it("classifies description change as minor", () => {
    expect(classifyChangeLevel(["description"])).toBe("minor");
  });

  it("classifies summary change as minor", () => {
    expect(classifyChangeLevel(["summary"])).toBe("minor");
  });

  it("classifies format change as minor", () => {
    expect(classifyChangeLevel(["format"])).toBe("minor");
  });

  it("classifies defaultValue change as minor", () => {
    expect(classifyChangeLevel(["defaultValue"])).toBe("minor");
  });

  it("classifies name change as minor", () => {
    expect(classifyChangeLevel(["name"])).toBe("minor");
  });

  it("classifies mixed changes as major (most restrictive wins)", () => {
    expect(classifyChangeLevel(["description", "type", "summary"])).toBe("major");
  });

  it("classifies mixed minor-only changes as minor", () => {
    expect(classifyChangeLevel(["description", "summary", "format"])).toBe("minor");
  });

  it("classifies empty changes as minor", () => {
    expect(classifyChangeLevel([])).toBe("minor");
  });

  it("returns major when major property appears last", () => {
    expect(classifyChangeLevel(["description", "format", "nullable"])).toBe("major");
  });
});
