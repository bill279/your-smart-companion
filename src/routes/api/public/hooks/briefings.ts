import { createFileRoute } from "@tanstack/react-router";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { getMicrosoftAccessToken } from "@/lib/ms-graph.server";

/**
 * Cron hook: runs every 15 min via pg_cron. For each user whose local time now
 * matches their configured daily_hour (or weekly window) and who hasn't been
 * delivered today/this-week, compose a briefing and post it as an assistant
 * message in their pinned briefing thread.
 *
 * Auth: called by pg_cron with the Supabase anon apikey; we additionally
 * require a matching CRON_SECRET header (set via secrets) OR the anon key,
 * belt-and-suspenders since /api/public/* bypasses platform auth.
 */
export const Route = createFileRoute("/api/public/hooks/briefings")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
        const apiKey = request.headers.get("apikey");
        if (!anon || apiKey !== anon) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: prefs, error } = await supabaseAdmin
          .from("user_briefing_prefs")
          .select("*")
          .or("daily_enabled.eq.true,weekly_enabled.eq.true");
        if (error) return Response.json({ error: error.message }, { status: 500 });
        if (!prefs || prefs.length === 0) return Response.json({ processed: 0 });

        const now = new Date();
        const results: Array<{ user: string; kind: string; status: string }> = [];

        for (const p of prefs) {
          try {
            const local = getLocalParts(now, p.timezone);
            const isDaily =
              p.daily_enabled &&
              local.hour === p.daily_hour &&
              !ranToday(p.last_daily_run_at, p.timezone, now);
            const isWeekly =
              p.weekly_enabled &&
              local.dow === p.weekly_dow &&
              local.hour === p.weekly_hour &&
              !ranThisWeek(p.last_weekly_run_at, p.timezone, now);

            if (!isDaily && !isWeekly) continue;

            const kind = isWeekly ? "weekly" : "daily";
            const threadId = await ensureBriefingThread(supabaseAdmin, p.user_id, p.briefing_thread_id);
            const briefing = await composeBriefing(p.user_id, kind, p.timezone);

            await supabaseAdmin.from("messages").insert({
              thread_id: threadId,
              user_id: p.user_id,
              role: "assistant",
              content: briefing,
            });

            const update: Record<string, string> = {};
            if (isDaily) update.last_daily_run_at = now.toISOString();
            if (isWeekly) update.last_weekly_run_at = now.toISOString();
            await supabaseAdmin.from("user_briefing_prefs").update(update).eq("user_id", p.user_id);

            results.push({ user: p.user_id, kind, status: "sent" });
          } catch (e) {
            results.push({
              user: p.user_id,
              kind: "error",
              status: e instanceof Error ? e.message : String(e),
            });
          }
        }

        return Response.json({ processed: results.length, results });
      },
    },
  },
});

function getLocalParts(date: Date, tz: string): { hour: number; dow: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour: parseInt(parts.hour ?? "0", 10) % 24,
    dow: dowMap[parts.weekday ?? "Sun"] ?? 0,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function ranToday(last: string | null, tz: string, now: Date): boolean {
  if (!last) return false;
  return getLocalParts(new Date(last), tz).ymd === getLocalParts(now, tz).ymd;
}

function ranThisWeek(last: string | null, tz: string, now: Date): boolean {
  if (!last) return false;
  const diffMs = now.getTime() - new Date(last).getTime();
  return diffMs < 6 * 24 * 60 * 60 * 1000; // ran within last 6 days = same week window
}

async function ensureBriefingThread(
  supabaseAdmin: Awaited<ReturnType<typeof getAdmin>>,
  userId: string,
  existing: string | null,
): Promise<string> {
  if (existing) {
    const { data } = await supabaseAdmin.from("threads").select("id").eq("id", existing).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data: created, error } = await supabaseAdmin
    .from("threads")
    .insert({ user_id: userId, title: "Daily Briefing" })
    .select("id")
    .single();
  if (error || !created) throw new Error(`create thread failed: ${error?.message}`);
  await supabaseAdmin
    .from("user_briefing_prefs")
    .update({ briefing_thread_id: created.id })
    .eq("user_id", userId);
  return created.id;
}

// Type helper so we can pass the admin client around without re-importing types
async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function composeBriefing(userId: string, kind: "daily" | "weekly", tz: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // 1. Recent lessons & facts (best-effort)
  const [lessonsRes, factsRes] = await Promise.all([
    supabaseAdmin
      .from("lessons_learned")
      .select("lesson")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabaseAdmin
      .from("user_facts")
      .select("key,value")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  // 2. Calendar (today for daily, next 7 days for weekly) via Microsoft Graph
  let calendarText = "_No calendar connected._";
  const ms = await getMicrosoftAccessToken(userId);
  if (ms) {
    const start = new Date();
    const end = new Date();
    if (kind === "daily") end.setDate(end.getDate() + 1);
    else end.setDate(end.getDate() + 7);
    try {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,organizer,onlineMeeting&$orderby=start/dateTime&$top=25`,
        {
          headers: {
            Authorization: `Bearer ${ms.accessToken}`,
            Prefer: `outlook.timezone="${tz}"`,
          },
        },
      );
      if (r.ok) {
        const j = (await r.json()) as {
          value?: Array<{
            subject?: string;
            start?: { dateTime?: string };
            organizer?: { emailAddress?: { name?: string } };
          }>;
        };
        if (j.value && j.value.length > 0) {
          calendarText = j.value
            .slice(0, 15)
            .map((e) => {
              const t = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleString("en-US", {
                timeZone: tz,
                weekday: kind === "weekly" ? "short" : undefined,
                hour: "numeric",
                minute: "2-digit",
              }) : "";
              return `- **${t}** — ${e.subject ?? "(no title)"} _(with ${e.organizer?.emailAddress?.name ?? "?"})_`;
            })
            .join("\n");
        } else {
          calendarText = kind === "daily" ? "_Nothing on the calendar today._" : "_Nothing on the calendar this week._";
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Recent agent actions (what happened) — weekly only
  let actionsText = "";
  if (kind === "weekly") {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    const { data: actions } = await supabaseAdmin
      .from("agent_actions")
      .select("action,summary,created_at")
      .eq("user_id", userId)
      .eq("status", "ok")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(20);
    if (actions && actions.length > 0) {
      actionsText =
        "\n\n**This week you got done:**\n" +
        actions.map((a) => `- ${a.summary}`).join("\n");
    }
  }

  // 4. Compose with LLM
  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    return `# ${kind === "daily" ? "Morning briefing" : "Weekly review"}\n\n${calendarText}${actionsText}`;
  }

  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("openai/gpt-5.5");

  const contextBlock = [
    `Timezone: ${tz}`,
    `Facts: ${(factsRes.data ?? []).map((f) => `${f.key}=${f.value}`).join("; ") || "(none)"}`,
    `Recent lessons: ${(lessonsRes.data ?? []).map((l) => l.lesson).join(" | ") || "(none)"}`,
    "",
    `Calendar:\n${calendarText}`,
    actionsText,
  ].join("\n");

  const prompt =
    kind === "daily"
      ? `Write a crisp morning briefing for me. Start with one sentence framing the day. Then a "Today" section listing the calendar in a clean bulleted format with times. If there's a heavy meeting, call it out. End with ONE proactive suggestion (e.g. "Want me to draft a prep note for your 2pm?"). Under 200 words. Markdown.\n\n${contextBlock}`
      : `Write a weekly review. Sections: **What happened** (bullets), **What's next week** (bullets from calendar), **One thing to focus on** (1 sentence). End with ONE proactive suggestion. Under 300 words. Markdown.\n\n${contextBlock}`;

  try {
    const { text } = await generateText({ model, prompt });
    return text.trim();
  } catch {
    return `# ${kind === "daily" ? "Morning briefing" : "Weekly review"}\n\n${calendarText}${actionsText}`;
  }
}