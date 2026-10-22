import { describe, it, expect, vi, afterEach } from "vitest";
import { sweep, assertLoopback, SPANNER_PREFIX, BIGQUERY_PREFIX } from "../../helpers/corpus/emulators";

// The final sweep must see objects on EVERY page of the emulators' lists, and may only delete what carries this run's prefix.
afterEach(() => vi.unstubAllGlobals());

describe("sweep", () => {
  it("follows nextPageToken for Spanner and BigQuery and deletes only prefixed objects", async () => {
    const deleted: string[] = [];
    const gone = new Set<string>();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (init?.method === "DELETE") {
        deleted.push(url.pathname.split("/").pop() ?? "");
        gone.add(url.pathname.split("/").pop() ?? "");
        return respond({});
      }
      const page2 = url.searchParams.get("pageToken") === "p2";
      if (url.pathname.includes("/databases")) {
        const all = page2 ? [{ name: `projects/p/instances/i/databases/${SPANNER_PREFIX}9` }] : [{ name: "projects/p/instances/i/databases/orders_db" }];
        return respond({ databases: all.filter((d) => !gone.has(d.name.split("/").pop()!)), ...(page2 ? {} : { nextPageToken: "p2" }) });
      }
      const sets = page2 ? [{ datasetReference: { datasetId: `${BIGQUERY_PREFIX}7` } }] : [{ datasetReference: { datasetId: "app_analytics" } }];
      return respond({ datasets: sets.filter((d) => !gone.has(d.datasetReference.datasetId)), ...(page2 ? {} : { nextPageToken: "p2" }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const remaining = await sweep();
    expect(deleted.sort()).toEqual([`${BIGQUERY_PREFIX}7`, `${SPANNER_PREFIX}9`].sort());
    expect(remaining).toEqual({ spanner: [], bigquery: [] });
  });

  it("refuses a non-loopback or https emulator URL", () => {
    expect(() => assertLoopback("https://127.0.0.1:5387/x")).toThrow();
    expect(() => assertLoopback("http://bigquery.googleapis.com/x")).toThrow();
    expect(() => assertLoopback("http://127.0.0.1:5388/x")).not.toThrow();
  });
});
