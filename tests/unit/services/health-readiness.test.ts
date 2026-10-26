import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FINAL FIX WAVE 4, I2 and M2. `/api/v1/health` is what an orchestrator probes to decide whether the pod can serve: its status code is READINESS
// (the database answers and the compiler core is there), not the presence of every emitter package. The Docker image's standalone output ships
// `@typespec/compiler` and no emitter, so with the package check the endpoint answered 503 in that image where it had always answered 200.
// A missing emitter is `degraded` (200); the compiler core or the database missing is `unhealthy` (503). And the unauthenticated body names no
// package and no version (a fingerprint of the install); the administrators' Health keeps both, in `detail`.

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
    entity: { count: vi.fn() },
    field: { count: vi.fn() },
    domain: { count: vi.fn() },
    user: { count: vi.fn() },
    emissionTargetStatus: { count: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
    governanceRequest: { count: vi.fn() },
  },
}));

import { GET } from "@/app/api/v1/health/route";
import {
  _resetHealthStore,
  _setCompilerChecker,
  _setDbChecker,
  _setEmitterChecker,
  checkInstalledPackages,
  runHealthCheck,
} from "@/services/health.service";
import type { ComponentStatus } from "@/types/schemas/health";
import type { ServiceContext } from "@/types/service-context";
import { assign } from "../../helpers/access-mocks";

const ctx: ServiceContext = { userId: "system", userRole: "ADMIN", assignments: [assign.global()], prisma: null as unknown as ServiceContext["prisma"] };

const healthy = (name: string): ComponentStatus => ({ name, status: "healthy", message: "ok" });
const status = (name: string, s: ComponentStatus["status"], message: string = s): ComponentStatus => ({ name, status: s, message });

function inject(parts: { db?: ComponentStatus; compiler?: ComponentStatus; emitters?: ComponentStatus | Error }) {
  _setDbChecker(async () => parts.db ?? healthy("Database"));
  _setCompilerChecker(async () => parts.compiler ?? healthy("TypeSpec Compiler"));
  _setEmitterChecker(async () => {
    if (parts.emitters instanceof Error) throw parts.emitters;
    return parts.emitters ?? healthy("Emitters");
  });
}

beforeEach(() => {
  _resetHealthStore();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the overall status (what the status code follows)", () => {
  it("emitters missing: degraded, and the endpoint answers 200", async () => {
    inject({ emitters: status("Emitters", "degraded", "1 of 14 emitter packages installed") });
    const result = await runHealthCheck(ctx);
    expect(result.success && result.data.status).toBe("degraded");
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("degraded");
  });

  it("every emitter missing, or the emitter check itself failing, is still only degraded: the pod can serve requests", async () => {
    for (const emitters of [status("Emitters", "unhealthy", "0 of 14 emitter packages installed"), new Error("emitter probe crashed")]) {
      inject({ emitters });
      const result = await runHealthCheck(ctx);
      expect(result.success && result.data.status, String(emitters)).toBe("degraded");
      expect((await GET()).status).toBe(200);
    }
  });

  it("the compiler core missing is unhealthy (503): the application cannot compile anything", async () => {
    inject({ compiler: status("TypeSpec Compiler", "unhealthy", "not installed") });
    const result = await runHealthCheck(ctx);
    expect(result.success && result.data.status).toBe("unhealthy");
    expect((await GET()).status).toBe(503);
  });

  it("the database unavailable is unhealthy (503), whatever the emitters say", async () => {
    inject({ db: status("Database", "unhealthy", "Database unavailable") });
    expect((await GET()).status).toBe(503);
    const result = await runHealthCheck(ctx);
    expect(result.success && result.data.status).toBe("unhealthy");
  });

  it("all healthy: healthy, 200; a slow database: degraded, 200", async () => {
    inject({});
    expect((await GET()).status).toBe(200);
    inject({ db: status("Database", "degraded", "Slow answer") });
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("degraded");
  });
});

describe("checkInstalledPackages", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "health-readiness-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function install(name: string, version: string) {
    const dir = path.join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  }

  it("emitters: none installed is degraded (never unhealthy); the names are in the detail, not in the message", async () => {
    const out = await checkInstalledPackages("Emitters", ["@typespec/avro", "@typespec/openapi3"], root, "optional");
    expect(out.status).toBe("degraded");
    expect(out.message).toBe("0 of 2 emitter packages installed");
    expect(out.detail).toContain("@typespec/avro");
    expect(out.detail).toContain("@typespec/openapi3");
  });

  it("emitters: some installed is degraded, with the missing names (and the installed versions) in the detail only", async () => {
    await install("@typespec/avro", "7.7.7");
    const out = await checkInstalledPackages("Emitters", ["@typespec/avro", "@typespec/openapi3"], root, "optional");
    expect(out.status).toBe("degraded");
    expect(out.message).toBe("1 of 2 emitter packages installed");
    expect(out.message).not.toMatch(/avro|openapi3|7\.7\.7/);
    expect(out.detail).toMatch(/missing: @typespec\/openapi3/i);
    expect(out.detail).toContain("@typespec/avro 7.7.7");
  });

  it("emitters: all installed is healthy", async () => {
    await install("@typespec/avro", "7.7.7");
    expect((await checkInstalledPackages("Emitters", ["@typespec/avro"], root, "optional")).status).toBe("healthy");
  });

  it("the compiler core: missing is unhealthy, installed is healthy with the version in the detail only", async () => {
    expect((await checkInstalledPackages("TypeSpec Compiler", ["@typespec/compiler"], root)).status).toBe("unhealthy");
    await install("@typespec/compiler", "9.9.9");
    const out = await checkInstalledPackages("TypeSpec Compiler", ["@typespec/compiler"], root);
    expect(out.status).toBe("healthy");
    expect(out.message).not.toContain("9.9.9");
    expect(out.message).not.toContain("@typespec");
    expect(out.detail).toContain("9.9.9");
  });
});

describe("what an unauthenticated caller is told (M2)", () => {
  const installed = (): { compiler: ComponentStatus; emitters: ComponentStatus } => ({
    compiler: { name: "TypeSpec Compiler", status: "healthy", message: "Installed", detail: "@typespec/compiler 9.9.9 installed" },
    emitters: { name: "Emitters", status: "degraded", message: "1 of 2 emitter packages installed", detail: "Missing: @typespec/avro" },
  });

  it("runHealthCheck leaves the detail out unless the caller is an administrator's", async () => {
    inject(installed());
    const publicView = await runHealthCheck(ctx);
    expect(publicView.success && JSON.stringify(publicView.data)).not.toMatch(/9\.9\.9|@typespec|detail/);
    const adminView = await runHealthCheck(ctx, { detail: "admin" });
    expect(adminView.success && adminView.data.components.compiler.detail).toContain("9.9.9");
    expect(adminView.success && adminView.data.components.emitters.detail).toContain("@typespec/avro");
  });

  it("GET /api/v1/health carries no version, no package name and no detail", async () => {
    inject(installed());
    const text = await (await GET()).text();
    expect(text).not.toMatch(/9\.9\.9|@typespec|detail|version/i);
  });

  it("the real checks, through the endpoint, say no version and no package name either", async () => {
    // the real compiler / emitter checks against this repository's own node_modules
    _resetHealthStore();
    _setDbChecker(async () => healthy("Database"));
    const text = await (await GET()).text();
    expect(text).not.toMatch(/\d+\.\d+\.\d+/);
    expect(text).not.toContain("@typespec");
  });
});
