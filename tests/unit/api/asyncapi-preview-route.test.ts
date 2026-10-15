import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/asyncapi-preview/[asset]/route";

const call = (asset: string) => GET(new Request(`http://x/api/asyncapi-preview/${asset}`), { params: Promise.resolve({ asset }) });

describe("asyncapi preview assets", () => {
  it("serves the standalone bundle and stylesheet from node_modules", async () => {
    const js = await call("standalone.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    // The UMD wrapper names the global at offset ~193, just past the 200-char mark the plan sliced to.
    expect((await js.text()).slice(0, 400)).toContain("AsyncApiStandalone");
    const css = await call("default.min.css");
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("serves nothing else", async () => {
    expect((await call("constructor")).status).toBe(404);
    expect((await call("../../package.json")).status).toBe(404);
    expect((await call("..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await call("standalone.js/../../package.json")).status).toBe(404);
    expect((await call("__proto__")).status).toBe(404);
  });

  it("serves the assets as inert, un-sniffable, cacheable files", async () => {
    const res = await call("standalone.js");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
  });
});
