import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { json } from "@/lib/jarvis-tools.server";

const Body = z.object({
  title: z.string().min(1).max(200),
  start: z.string().min(1),
  end: z.string().min(1),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string().min(1).max(320)).optional(),
  timezone: z.string().optional(),
  online_meeting: z.boolean().optional(),
});

export const Route = createFileRoute("/api/public/jarvis/tools/create_calendar_event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
        const token = auth.slice(7);

        const supabase = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          },
        );
        const { data: claims, error: cerr } = await supabase.auth.getClaims(token);
        const userId = claims?.claims?.sub;
        if (cerr || !userId) return json({ error: "unauthorized" }, 401);

        const parsed = Body.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) return json({ error: parsed.error.message }, 400);
        const data = parsed.data;

        const { resolveContactAttendees } = await import("@/lib/contact-resolution.server");
        const resolved = await resolveContactAttendees(supabase, data.attendees);
        if (resolved.unresolved.length > 0) {
          return json(
            {
              error: `I couldn't find a saved contact for: ${resolved.unresolved.join(", ")}. Please provide the email address or save the contact first.`,
              unresolved_attendees: resolved.unresolved,
            },
            400,
          );
        }

        const { createMicrosoftCalendarEvent } = await import("@/lib/ms-calendar.server");
        const result = await createMicrosoftCalendarEvent(userId, {
          ...data,
          attendees: resolved.attendees,
          online_meeting: data.online_meeting ?? true,
        });
        const providerLabel = "Outlook";
        const providerKey = "outlook";
        if ("error" in result) {
          await supabase.from("agent_actions").insert({
            user_id: userId,
            action: "create_calendar_event",
            summary: `Failed to create ${providerLabel} event "${data.title}"`,
            payload: {
              title: data.title,
              start: data.start,
              end: data.end,
              attendees: resolved.attendees,
              provider: providerKey,
              status: result.status,
              detail: result.detail?.slice(0, 500),
            },
            status: "error",
          });
          return json(result, String(result.error ?? "").includes("not connected") ? 409 : 502);
        }
        await supabase.from("agent_actions").insert({
          user_id: userId,
          action: "create_calendar_event",
          summary: `Created event "${data.title}" on ${providerLabel}${result.teams_join_url ? " with Teams meeting" : ""}`,
          payload: {
            title: data.title,
            start: data.start,
            end: data.end,
            attendees: resolved.attendees,
            provider: providerKey,
            meeting_link: !!result.teams_join_url,
          },
          status: "ok",
        });
        return json(result);
      },
    },
  },
});