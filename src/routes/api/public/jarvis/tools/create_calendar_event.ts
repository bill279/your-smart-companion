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
  attendees: z.array(z.string().email()).optional(),
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

        const { getMicrosoftAccessToken } = await import("@/lib/ms-graph.server");
        const ms = await getMicrosoftAccessToken(userId);
        if (!ms) {
          return json(
            {
              error:
                "Microsoft is not connected. Open Activity & memory and click Connect Microsoft.",
            },
            409,
          );
        }

        const wantsTeams = data.online_meeting ?? (data.attendees?.length ?? 0) > 0;
        const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ms.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject: data.title,
            ...(data.description
              ? { body: { contentType: "HTML", content: data.description } }
              : {}),
            start: { dateTime: data.start, timeZone: data.timezone ?? "UTC" },
            end: { dateTime: data.end, timeZone: data.timezone ?? "UTC" },
            ...(data.location ? { location: { displayName: data.location } } : {}),
            ...(data.attendees?.length
              ? {
                  attendees: data.attendees.map((email) => ({
                    emailAddress: { address: email },
                    type: "required",
                  })),
                }
              : {}),
            ...(wantsTeams
              ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }
              : {}),
          }),
        });

        if (!res.ok) {
          const detail = await res.text();
          await supabase.from("agent_actions").insert({
            user_id: userId,
            action: "create_calendar_event",
            summary: `Failed to create Outlook calendar event "${data.title}"`,
            payload: {
              title: data.title,
              start: data.start,
              end: data.end,
              attendees: data.attendees ?? [],
              provider: "outlook",
              status: res.status,
              detail: detail.slice(0, 500),
            },
            status: "error",
          });
          return json(
            { error: `Outlook calendar create failed (${res.status})`, detail: detail.slice(0, 500) },
            502,
          );
        }

        const event = (await res.json()) as {
          id?: string;
          webLink?: string;
          onlineMeeting?: { joinUrl?: string };
        };
        const joinUrl = event.onlineMeeting?.joinUrl;
        await supabase.from("agent_actions").insert({
          user_id: userId,
          action: "create_calendar_event",
          summary: `Created event "${data.title}" on Outlook${joinUrl ? " with Teams meeting" : ""}`,
          payload: {
            title: data.title,
            start: data.start,
            end: data.end,
            attendees: data.attendees ?? [],
            provider: "outlook",
            teams: !!joinUrl,
          },
          status: "ok",
        });

        return json({
          ok: true,
          provider: "outlook",
          id: event.id,
          link: event.webLink,
          ...(joinUrl ? { teams_join_url: joinUrl } : {}),
        });
      },
    },
  },
});