import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { checkSecret, readJson, json, gatewayHeaders } from "@/lib/jarvis-tools.server";

export const Route = createFileRoute("/api/public/jarvis/tools/read_calendar")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = checkSecret(request);
        if (unauth) return unauth;
        const { days, max_results } = await readJson(
          request,
          z.object({
            days: z.number().int().min(1).max(60).optional(),
            max_results: z.number().int().min(1).max(50).optional(),
          }),
        );
        const now = new Date();
        const end = new Date(now.getTime() + (days ?? 7) * 86400000);
        const params = new URLSearchParams({
          timeMin: now.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(max_results ?? 10),
        });
        const res = await fetch(
          `https://connector-gateway.lovable.dev/google_calendar/calendar/v3/calendars/primary/events?${params}`,
          { headers: gatewayHeaders("GOOGLE_CALENDAR_API_KEY") },
        );
        if (!res.ok) {
          const text = await res.text();
          return json({ error: `calendar read failed (${res.status}): ${text}` }, 502);
        }
        const data = (await res.json()) as {
          items?: Array<{
            id: string;
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            location?: string;
          }>;
        };
        const events = (data.items ?? []).map((e) => ({
          id: e.id,
          title: e.summary ?? "(no title)",
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          location: e.location,
        }));
        return json({ events });
      },
    },
  },
});