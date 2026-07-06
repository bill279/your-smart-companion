import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { json } from "@/lib/jarvis-tools.server";

const Body = z.object({
  event_id: z.string().min(1),
  response: z.enum(["accept", "tentative", "decline"]),
  comment: z.string().max(1000).optional(),
  send_response: z.boolean().optional(),
});

async function userIdFromRequest(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data.claims?.sub) return null;
  return data.claims.sub;
}

export const Route = createFileRoute("/api/public/jarvis/tools/respond_calendar_event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await userIdFromRequest(request);
        if (!userId) return json({ error: "unauthorized" }, 401);
        const parsed = Body.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) return json({ error: parsed.error.message }, 400);
        const { respondToMicrosoftCalendarEvent } = await import("@/lib/ms-calendar.server");
        const result = await respondToMicrosoftCalendarEvent(userId, parsed.data);
        return json(result, "error" in result ? 502 : 200);
      },
    },
  },
});