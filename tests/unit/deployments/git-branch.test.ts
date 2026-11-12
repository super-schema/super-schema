import { describe, expect, it } from "vitest";
import { branchDate, deliveryBranchName, gitBranchForEnvironment } from "@/lib/deployments/git-branch";
import { EnvironmentDefinitionsSchema } from "@/lib/deployments/contracts";

describe("Git delivery branches", () => {
  it("uses the environment's branch override, otherwise a branch named after the environment", () => {
    const details = { staging: { branch: "release/staging" }, qa: { description: "Shared QA" } };
    expect(gitBranchForEnvironment(details, "staging")).toEqual({ branch: "release/staging", overridden: true });
    expect(gitBranchForEnvironment(details, "qa")).toEqual({ branch: "qa", overridden: false });
    expect(gitBranchForEnvironment(undefined, "Pre Prod")).toEqual({ branch: "pre-prod", overridden: false });
  });
  it("validates ordered environment definitions", () => {
    expect(EnvironmentDefinitionsSchema.parse([{ name: " development ", description: "First stage" }, { name: "qa", branch: "" }])).toEqual([{ name: "development", description: "First stage" }, { name: "qa", description: "", branch: "" }]);
    expect(() => EnvironmentDefinitionsSchema.parse([{ name: "qa" }, { name: "QA" }])).toThrow(/unique/);
    expect(() => EnvironmentDefinitionsSchema.parse([{ name: "qa", branch: "bad..branch" }])).toThrow();
    expect(() => EnvironmentDefinitionsSchema.parse([])).toThrow();
  });
  it("builds short dated branch names", () => {
    expect(branchDate(new Date("2026-11-12T23:59:00Z"))).toBe("2026-11-12");
    expect(deliveryBranchName({ schema: "accountactivationdecisiondata", contractVersion: "1.0.0_snapshot", date: "2026-11-12" })).toBe("accountactivationdecisiondata-1.0.0_snapshot-2026-11-12");
    expect(deliveryBranchName({ schema: "account", contractVersion: "1.0.0", date: "2026-11-12", attempt: 3 })).toBe("account-1.0.0-2026-11-12-3");
  });
});
