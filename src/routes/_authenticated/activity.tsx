import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Brain, Trash2, Mail, Calendar, UserPlus, Sparkles, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { listActions, listFacts, deleteFact } from "@/lib/memory.functions";

export const Route = createFileRoute("/_authenticated/activity")({
  ssr: false,
  head: () => ({ meta: [{ title: "Activity & Memory — BPA Bot" }] }),
  component: ActivityPage,
});

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  send_email: Mail,
  create_calendar_event: Calendar,
  save_contact: UserPlus,
  remember_fact: Brain,
  forget_fact: Brain,
};

function ActivityPage() {
  const qc = useQueryClient();
  const acts = useServerFn(listActions);
  const facts = useServerFn(listFacts);
  const del = useServerFn(deleteFact);
  const [tab, setTab] = useState<"activity" | "memory">("activity");

  const actionsQ = useQuery({ queryKey: ["agent-actions"], queryFn: () => acts({}) });
  const factsQ = useQuery({ queryKey: ["user-facts"], queryFn: () => facts({}) });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-facts"] });
      toast.success("Forgotten");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 flex items-center gap-3 sticky top-0 bg-card/95 backdrop-blur z-10">
        <Link to="/chat" className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm">
          <ArrowLeft size={16} /> Back
        </Link>
        <h1 className="text-base font-semibold flex-1">Activity & memory</h1>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-4">
        <div className="inline-flex rounded-md border border-border bg-card p-0.5 mb-4">
          <button
            onClick={() => setTab("activity")}
            className={`px-3 py-1.5 text-sm rounded ${tab === "activity" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
          >
            <Sparkles size={12} className="inline mr-1" /> Audit log
          </button>
          <button
            onClick={() => setTab("memory")}
            className={`px-3 py-1.5 text-sm rounded ${tab === "memory" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
          >
            <Brain size={12} className="inline mr-1" /> Memory
          </button>
        </div>

        {tab === "activity" && (
          <>
            <p className="text-sm text-muted-foreground mb-3">
              Every email, calendar event, contact save, and memory write BPA Bot has made on your behalf.
            </p>
            {actionsQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : actionsQ.data && actionsQ.data.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border bg-card">
                {actionsQ.data.map((a) => {
                  const Icon = ICONS[a.action] ?? Sparkles;
                  const failed = a.status !== "ok";
                  return (
                    <li key={a.id} className="flex items-start gap-3 p-3">
                      <div className={`mt-0.5 ${failed ? "text-destructive" : "text-primary"}`}>
                        {failed ? <AlertCircle size={16} /> : <Icon size={16} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium break-words">{a.summary}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {new Date(a.created_at).toLocaleString()} · {a.action}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-8 text-center">
                No actions yet.
              </div>
            )}
          </>
        )}

        {tab === "memory" && (
          <>
            <p className="text-sm text-muted-foreground mb-3">
              Durable facts BPA Bot remembers about you across every chat. Tell it "remember that…" to add more, or delete here.
            </p>
            {factsQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : factsQ.data && factsQ.data.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border bg-card">
                {factsQ.data.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 p-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">{f.key}</div>
                      <div className="text-sm break-words">{f.value}</div>
                    </div>
                    <button
                      onClick={() => {
                        if (confirm(`Forget "${f.key}"?`)) delMut.mutate(f.id);
                      }}
                      className="p-1.5 text-muted-foreground hover:text-destructive"
                      aria-label="Forget"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-8 text-center">
                Nothing remembered yet. Try saying "remember that my company is BP Automation."
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}