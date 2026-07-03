import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { microsoftIntegrationStatus } from "@/lib/microsoft-integration.server";

export const Route = createFileRoute("/api/integrations/microsoft/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = request.headers.get("authorization");
        if (!auth?.toLowerCase().startsWith("bearer ")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const supabase = createClient<Database>(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            global: { headers: { Authorization: auth } },
            auth: { persistSession: false, autoRefreshToken: false },
          },
        );
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          return Response.json(await microsoftIntegrationStatus(supabase, data.user.id));
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      },
    },
  },
});
