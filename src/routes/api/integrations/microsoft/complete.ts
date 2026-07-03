import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import {
  exchangeMicrosoftCode,
  saveMicrosoftIntegration,
  verifyMicrosoftOAuthState,
} from "@/lib/microsoft-integration.server";

const Body = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const Route = createFileRoute("/api/integrations/microsoft/complete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError || !userData.user) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const parsed = Body.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });

        try {
          const { userId } = verifyMicrosoftOAuthState(parsed.data.state);
          if (userId !== userData.user.id) {
            return Response.json({ error: "Microsoft connection state does not match signed-in user" }, { status: 403 });
          }
          const token = await exchangeMicrosoftCode(request, parsed.data.code);
          await saveMicrosoftIntegration(supabase, userId, token);
          return Response.json({ ok: true });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 500 });
        }
      },
    },
  },
});
