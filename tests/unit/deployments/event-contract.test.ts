import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareEventContract } from "@/lib/deployments/event-contract";
import type { GitHubClient } from "@/lib/deployments/github";
import type { PreparedPlan } from "@/lib/deployments/contracts";

afterEach(() => vi.unstubAllEnvs());
describe("trusted contract preparation boundary", () => {
  const readFiles = vi.fn();
  const client = { repository: { host: "github.com", owner: "acme", repo: "contracts" }, readFiles } as unknown as GitHubClient;
  it("requires exact repository approval before fetching or executing any repository code", async () => {
    vi.stubEnv("DEPLOYMENT_EVENT_REPOSITORIES", "github.com/other/contracts,github.com/acme/contracts-extra");
    await expect(prepareEventContract(client, {} as PreparedPlan)).rejects.toThrow(/operator must approve/);
    expect(readFiles).not.toHaveBeenCalled();
  });
  it("requires an installed absolute toolchain even for an approved repository", async () => {
    vi.stubEnv("DEPLOYMENT_EVENT_REPOSITORIES", "github.com/acme/contracts");
    vi.stubEnv("DEPLOYMENT_EVENT_TOOLKIT", "../unreviewed-toolchain");
    await expect(prepareEventContract(client, {} as PreparedPlan)).rejects.toThrow(/installed Event Schema Central toolchain/);
    expect(readFiles).not.toHaveBeenCalled();
  });
});
