import { expect, it } from "vitest";
import { fileDiff } from "@/lib/deployments/file-diff";
import { generatedGitPrTitle } from "@/lib/deployments/pr-title";
it("shows deleted and added text with independent old/new line numbers", () => {
  expect(fileDiff("same\nold\nend\n", "same\nnew\nend\n")).toEqual([
    { kind: "context", text: "same", oldLine: 1, newLine: 1 },
    { kind: "removed", text: "old", oldLine: 2 },
    { kind: "added", text: "new", newLine: 2 },
    { kind: "context", text: "end", oldLine: 3, newLine: 3 },
  ]);
});
it("represents new and removed files without inventing context", () => {
  expect(fileDiff("", "new\n")).toEqual([{ kind: "added", text: "new", newLine: 1 }]);
  expect(fileDiff("old\n", "")).toEqual([{ kind: "removed", text: "old", oldLine: 1 }]);
  expect(fileDiff("", "")).toEqual([]);
});
it("bounds work on large files", () => { expect(fileDiff("x".repeat(1_500_001), "")).toBeNull(); });
it("generates one bounded standard PR title", () => {
  expect(generatedGitPrTitle({ schema: "account", format: "avro", version: 3, environment: "staging", contractVersion: "1.0.0_snapshot" })).toBe("Publish account: avro v3 → staging (1.0.0_snapshot)");
  expect(generatedGitPrTitle({ schema: "x".repeat(400), format: "avro", version: 1, environment: "staging", contractVersion: "1.0.0" }).length).toBe(250);
});
