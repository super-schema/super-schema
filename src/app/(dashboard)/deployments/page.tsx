"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Rocket, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeploymentOverviewFilters, DeploymentOverviewTable } from "@/components/custom/DeploymentOverview";
import { getDeploymentOverviewAction } from "./actions";
import type { DeploymentOverviewFilters as OverviewFilters, DeploymentOverviewRow } from "@/services/deployment.service";
import type { DeploymentSummary } from "@/lib/deployments/contracts";

/** Rows per page of the overview: every entity of the tenant is reached by moving through the pages. */
const PAGE_SIZE = 25;

export default function DeploymentsPage() {
  const [rows, setRows] = useState<DeploymentOverviewRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeploymentSummary[]>([]);
  const [targetFormats, setTargetFormats] = useState<string[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<OverviewFilters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The number of the latest load. An answer to a load that a newer one has overtaken (the reader moved on) is dropped.
  const latestLoad = useRef(0);

  const load = useCallback(async (wantedPage: number, wantedFilters: OverviewFilters) => {
    const loadId = ++latestLoad.current;
    setLoading(true);
    setError(null);
    try {
      const res = await getDeploymentOverviewAction({
        offset: (wantedPage - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        filters: wantedFilters,
      });
      if (loadId !== latestLoad.current) return;
      if ("error" in res) {
        setError(res.error ?? "Request failed");
        return;
      }
      // The page lies past the last row (entities were removed since it was read): show the last page instead.
      const lastPage = Math.max(1, Math.ceil(res.data.total / PAGE_SIZE));
      if (res.data.rows.length === 0 && wantedPage > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(res.data.rows);
      setDeliveries(res.data.deliveries ?? []);
      setTargetFormats(res.data.targetFormats);
      setDomains(res.data.domains);
      setTotal(res.data.total);
    } catch {
      if (loadId === latestLoad.current) setError("Could not load deployments. Try again.");
    } finally {
      if (loadId === latestLoad.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch the page whenever it or the filters change; state updates occur after the async result resolves.
    void load(page, filters);
  }, [load, page, filters]);

  // A filter change starts again from the first page.
  function changeFilters(next: OverviewFilters) {
    setFilters(next);
    setPage(1);
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="flex-1 flex flex-col p-space-6 gap-space-4 overflow-auto">
      <div className="flex items-start justify-between gap-space-4">
        <div className="flex items-center gap-space-3">
          <div className="rounded-full bg-muted/40 p-space-2">
            <Rocket className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-heading-2 text-foreground">Deployments</h1>
            <p className="text-body-small text-muted-foreground">
              Delivery receipts and recorded environments. Configure and run workflows from each schema&apos;s Deployments tab.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-space-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(page, filters)}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Link href="/schemas">
            <Button variant="outline" size="sm" className="gap-1.5">
              Go to Schemas
            </Button>
          </Link>
        </div>
      </div>

      <DeploymentOverviewFilters
        domains={domains}
        targetFormats={targetFormats}
        filters={filters}
        onFilterChange={changeFilters}
      />

      {error && (
        <div
          role="alert"
          data-testid="deployments-error"
          className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

      {/* A failed load shows only its error: the rows and pager still on screen belong to an answer for other filters or another page. */}
      {loading ? (
        <div className="flex items-center gap-space-2 text-body-small text-muted-foreground py-space-6">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Loading deployments…
        </div>
      ) : error ? null : (
        <>
          <section className="space-y-2" aria-label="Recent deliveries">
            <h2 className="text-heading-3">Recent deliveries</h2>
            <p className="text-caption text-muted-foreground">Latest 50 attempts for the selected domain and format. A delivery receipt records the destination&apos;s response.</p>
            {deliveries.length === 0 ? <p className="text-body-small text-muted-foreground">No delivery attempts yet.</p> : <div className="overflow-hidden rounded-lg border"><Table className="text-body-small">
              <TableHeader className="bg-muted"><TableRow className="hover:bg-transparent">{["Schema", "Version", "Destination", "Environment", "Result"].map((title) => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{deliveries.map((delivery) => <TableRow key={delivery.id}>
                <TableCell className="whitespace-normal"><Link className="text-primary hover:underline" href={delivery.href}>{delivery.entityName}</Link></TableCell>
                <TableCell>{delivery.format} v{delivery.artifactVersion}</TableCell><TableCell className="whitespace-normal">{delivery.method === "http" ? "API" : delivery.method === "git" ? "Git PR" : "Registry"}</TableCell>
                <TableCell className="whitespace-normal">{delivery.environment}</TableCell><TableCell className="whitespace-normal">{delivery.url?.startsWith("https://") ? <a className="text-primary hover:underline" href={delivery.url} target="_blank" rel="noreferrer">{delivery.outcome ?? delivery.status}</a> : delivery.outcome ?? delivery.status}</TableCell>
              </TableRow>)}</TableBody>
            </Table></div>}
          </section>
          <h2 className="text-heading-3">Recorded environments</h2>
          <DeploymentOverviewTable rows={rows} targetFormats={targetFormats} />
          {total > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-caption text-muted-foreground">{`Showing ${from}–${to} of ${total}`}</span>
              <div className="flex items-center gap-space-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Next page"
                  disabled={page >= lastPage}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
