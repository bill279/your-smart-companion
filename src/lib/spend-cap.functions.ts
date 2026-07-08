import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type SpendStatus = {
  monthUsd: number;
  capUsd: number;
  blocked: boolean;
  monthStart: string;
};

async function loadStatus(
  supabase: { from: (t: string) => unknown },
  userId: string,
): Promise<SpendStatus> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const monthStart = start.toISOString();

  const [{ data: settings }, { data: events }] = await Promise.all([
    sb.from("assistant_settings").select("monthly_cap_usd").eq("user_id", userId).maybeSingle(),
    sb
      .from("usage_events")
      .select("cost_usd")
      .eq("user_id", userId)
      .gte("created_at", monthStart),
  ]);

  const capUsd = Number(settings?.monthly_cap_usd ?? 100);
  const monthUsd = (events ?? []).reduce(
    (sum: number, r: { cost_usd: number | string | null }) => sum + (Number(r.cost_usd) || 0),
    0,
  );
  return {
    monthStart,
    capUsd,
    monthUsd,
    blocked: capUsd > 0 && monthUsd >= capUsd,
  };
}

export const getSpendStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadStatus(context.supabase, context.userId));

export const setSpendCap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ capUsd: z.number().min(0).max(100000) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = context.supabase as any;
    const { error } = await sb
      .from("assistant_settings")
      .upsert(
        { user_id: context.userId, monthly_cap_usd: data.capUsd },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return loadStatus(context.supabase, context.userId);
  });

// Server-only helper for other handlers to enforce the cap.
export async function assertUnderCap(
  supabase: { from: (t: string) => unknown },
  userId: string,
): Promise<SpendStatus> {
  const status = await loadStatus(supabase, userId);
  if (status.blocked) {
    const err = new Error(
      `Monthly spend cap reached ($${status.monthUsd.toFixed(2)} of $${status.capUsd.toFixed(2)}). Raise it on the Spend page to keep using AI.`,
    );
    (err as Error & { code?: string }).code = "SPEND_CAP_REACHED";
    throw err;
  }
  return status;
}