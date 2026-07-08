import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, DollarSign } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getUsageSummary } from "@/lib/usage.functions";
import { getSpendStatus, setSpendCap } from "@/lib/spend-cap.functions";

export const Route = createFileRoute("/_authenticated/usage")({
  ssr: false,
  head: () => ({ meta: [{ title: "Spend — BPA Bot" }] }),
  component: UsagePage,
});

function fmt(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function UsagePage() {
  const load = useServerFn(getUsageSummary);
  const loadCap = useServerFn(getSpendStatus);
  const saveCap = useServerFn(setSpendCap);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["usage-summary"], queryFn: () => load({}) });
  const capQ = useQuery({ queryKey: ["spend-cap"], queryFn: () => loadCap({}) });
  const [capInput, setCapInput] = useState<string>("");
  const capMut = useMutation({
    mutationFn: (capUsd: number) => saveCap({ data: { capUsd } }),
    onSuccess: () => {
      toast.success("Monthly cap updated");
      qc.invalidateQueries({ queryKey: ["spend-cap"] });
      setCapInput("");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update cap"),
  });

  const data = q.data;
  const maxDay = Math.max(0.0001, ...(data?.byDay.map((d) => d.costUsd) ?? [0]));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 flex items-center gap-3">
        <Link to="/chat" className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <DollarSign size={18} /> Spend across tools
        </h1>
      </header>
      <main className="max-w-5xl mx-auto p-4 space-y-6">
        {capQ.data && (
          <section className={`rounded-lg border p-4 ${capQ.data.blocked ? "border-destructive bg-destructive/10" : "border-border bg-card"}`}>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="text-sm font-semibold">Monthly spend cap</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {fmt(capQ.data.monthUsd)} used of {fmt(capQ.data.capUsd)} this month
                  {capQ.data.blocked && " — AI is paused until you raise the cap."}
                </div>
                <div className="mt-2 h-1.5 w-64 max-w-full rounded bg-secondary overflow-hidden">
                  <div
                    className={`h-full ${capQ.data.blocked ? "bg-destructive" : "bg-primary"}`}
                    style={{ width: `${Math.min(100, (capQ.data.monthUsd / Math.max(0.0001, capQ.data.capUsd)) * 100).toFixed(1)}%` }}
                  />
                </div>
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(capInput);
                  if (!Number.isFinite(n) || n < 0) { toast.error("Enter a valid amount"); return; }
                  capMut.mutate(n);
                }}
              >
                <span className="text-xs text-muted-foreground">New cap $</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder={String(capQ.data.capUsd)}
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  disabled={capMut.isPending || !capInput}
                  className="rounded-md bg-primary text-primary-foreground text-xs font-medium px-3 py-1.5 disabled:opacity-50"
                >
                  {capMut.isPending ? "Saving…" : "Update"}
                </button>
              </form>
            </div>
          </section>
        )}
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">Failed to load: {(q.error as Error).message}</p>}
        {data && (
          <>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Today" value={fmt(data.totals.today.costUsd)} sub={`${data.totals.today.events} events`} />
              <Stat label="Last 7 days" value={fmt(data.totals.last7d.costUsd)} sub={`${data.totals.last7d.events} events`} />
              <Stat label="Last 30 days" value={fmt(data.totals.last30d.costUsd)} sub={`${data.totals.last30d.events} events`} />
              <Stat label="Last 90 days" value={fmt(data.totals.allTime.costUsd)} sub={`${data.totals.allTime.events} events`} />
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3">Daily spend</h2>
              {data.byDay.length === 0 ? (
                <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
              ) : (
                <div className="flex items-end gap-1 h-32">
                  {data.byDay.slice(-30).map((d) => (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1" title={`${d.day}: ${fmt(d.costUsd)}`}>
                      <div
                        className="w-full bg-primary/70 rounded-t"
                        style={{ height: `${Math.max(2, (d.costUsd / maxDay) * 100)}%` }}
                      />
                      <span className="text-[9px] text-muted-foreground">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="grid md:grid-cols-2 gap-4">
              <Table title="By category" rows={data.byKind.map((k) => ({ label: k.kind, cost: k.costUsd, events: k.events }))} />
              <Table
                title="By model"
                rows={data.byModel.map((m) => ({
                  label: m.model,
                  cost: m.costUsd,
                  events: m.events,
                  extra: `${(m.inputTokens / 1000).toFixed(1)}k in / ${(m.outputTokens / 1000).toFixed(1)}k out`,
                }))}
              />
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3">Recent events</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-3">When</th>
                      <th className="text-left py-1 pr-3">Kind</th>
                      <th className="text-left py-1 pr-3">Model</th>
                      <th className="text-right py-1 pr-3">Tokens</th>
                      <th className="text-right py-1">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => (
                      <tr key={r.id} className="border-t border-border/50">
                        <td className="py-1 pr-3 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="py-1 pr-3">{r.kind}</td>
                        <td className="py-1 pr-3 text-muted-foreground">{r.model ?? "—"}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {r.input_tokens + r.output_tokens > 0 ? `${r.input_tokens}/${r.output_tokens}` : "—"}
                        </td>
                        <td className="py-1 text-right tabular-nums">{fmt(Number(r.cost_usd) || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Costs are estimates using standard provider list prices. Voice sessions log a marker event only — per-minute audio costs aren't itemized yet.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: Array<{ label: string; cost: number; events: number; extra?: string }> }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-border/50 first:border-t-0">
                <td className="py-1.5 pr-3">
                  <div>{r.label}</div>
                  {r.extra && <div className="text-[10px] text-muted-foreground">{r.extra}</div>}
                </td>
                <td className="py-1.5 pr-3 text-right text-muted-foreground tabular-nums">{r.events}</td>
                <td className="py-1.5 text-right tabular-nums">{fmt(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}