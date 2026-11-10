// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("@/services/deployment-workflow.service", () => ({ processDueDeployments: h.process }));
import { POST } from "@/app/api/deployments/process/route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("deployment worker authentication", () => {
  it("requires a configured exact bearer token before reading any work", async () => {
    vi.stubEnv("DEPLOYMENT_WORKER_TOKEN", "worker-secret");
    for (const authorization of ["", "Bearer short", "Bearer worker-secrex", "worker-secret"]) {
      expect((await POST(new Request("https://app.example/api/deployments/process", { method: "POST", headers: { authorization } }))).status).toBe(401);
    }
    expect(h.process).not.toHaveBeenCalled();
  });
  it("drains a bounded batch and keeps internal errors private", async () => {
    vi.stubEnv("DEPLOYMENT_WORKER_TOKEN", "worker-secret"); h.process.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error("database password"));
    const request = () => new Request("https://app.example/api/deployments/process", { method: "POST", headers: { authorization: "Bearer worker-secret" } });
    expect(await (await POST(request())).json()).toEqual({ processed: 3 }); expect(h.process).toHaveBeenCalledWith(5);
    const failure = await POST(request()); expect(failure.status).toBe(500); expect(await failure.text()).not.toContain("password");
  });
});
