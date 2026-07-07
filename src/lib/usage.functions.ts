import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type UsageSummary = {
  totals: {
    allTime: { costUsd: number; events: number };
    last30d: { costUsd: number; events: number };
    last7d: { costUsd: number; events: number };
    today: { costUsd: number; events: number };
  };
  byKind: Array<{ kind: string; costUsd: number; events: number }>;
  byModel: Array<{ model: string; costUsd: number; events: number; inputTokens: number; outputTokens: number }>;
  byDay: Array<{ day: string; costUsd: number; events: number }>;
  recent: Array<{
    id: string;
    kind: string;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    created_at: string;
    metadata: Record<string, unknown> | null;
  }>;
};

export const getUsageSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<UsageSummary> => {
    // Pull the last 90 days of events. For heavy users we'd move this
    // to a materialized view, but a straight scan is fine at current volume.
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await context.supabase
      .from("usage_events")
      .select("id,kind,model,input_tokens,output_tokens,cost_usd,created_at,metadata")
      .eq("user_id", context.userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    const rows = data ?? [];

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const t = (ms: number) => now - ms;

    const zeroed = () => ({ costUsd: 0, events: 0 });
    const totals = { allTime: zeroed(), last30d: zeroed(), last7d: zeroed(), today: zeroed() };
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const kindMap = new Map<string, { costUsd: number; events: number }>();
    const modelMap = new Map<string, { costUsd: number; events: number; inputTokens: number; outputTokens: number }>();
    const dayMap = new Map<string, { costUsd: number; events: number }>();

    for (const r of rows) {
      const cost = Number(r.cost_usd) || 0;
      const ts = new Date(r.created_at).getTime();
      totals.allTime.costUsd += cost; totals.allTime.events += 1;
      if (ts >= t(30 * day)) { totals.last30d.costUsd += cost; totals.last30d.events += 1; }
      if (ts >= t(7 * day)) { totals.last7d.costUsd += cost; totals.last7d.events += 1; }
      if (ts >= todayStart.getTime()) { totals.today.costUsd += cost; totals.today.events += 1; }

      const k = kindMap.get(r.kind) ?? { costUsd: 0, events: 0 };
      k.costUsd += cost; k.events += 1; kindMap.set(r.kind, k);

      const mKey = r.model ?? "(no model)";
      const m = modelMap.get(mKey) ?? { costUsd: 0, events: 0, inputTokens: 0, outputTokens: 0 };
      m.costUsd += cost; m.events += 1;
      m.inputTokens += r.input_tokens ?? 0;
      m.outputTokens += r.output_tokens ?? 0;
      modelMap.set(mKey, m);

      const dayKey = r.created_at.slice(0, 10);
      const d = dayMap.get(dayKey) ?? { costUsd: 0, events: 0 };
      d.costUsd += cost; d.events += 1; dayMap.set(dayKey, d);
    }

    return {
      totals,
      byKind: [...kindMap.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.costUsd - a.costUsd),
      byModel: [...modelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.costUsd - a.costUsd),
      byDay: [...dayMap.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
      recent: rows.slice(0, 50).map((r) => ({
        ...r,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      })),
    };
  });