import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  clearMicrosoftOAuthCookie,
  exchangeMicrosoftCode,
  readMicrosoftOAuthCookie,
  saveMicrosoftIntegration,
  verifyMicrosoftOAuthState,
} from "@/lib/microsoft-integration.server";

function redirectWithClearedCookie(request: Request, path: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(path, request.url).toString(),
      "Set-Cookie": clearMicrosoftOAuthCookie(request),
    },
  });
}

export const Route = createFileRoute("/api/integrations/microsoft/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");
        if (error) {
          const message = [error, errorDescription].filter(Boolean).join(": ").slice(0, 500);
          console.error("[microsoft callback] microsoft returned error", {
            error,
            errorDescription,
          });
          return redirectWithClearedCookie(
            request,
            `/settings?microsoft=error&message=${encodeURIComponent(message)}`,
          );
        }
        if (!code || !state) {
          return redirectWithClearedCookie(request, "/settings?microsoft=missing_code");
        }
        try {
          const { userId } = verifyMicrosoftOAuthState(state);
          const handoff = readMicrosoftOAuthCookie(request);
          if (handoff.userId !== userId) {
            throw new Error("Microsoft connection session does not match the signed-in user.");
          }
          const supabase = createClient<Database>(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_PUBLISHABLE_KEY!,
            {
              global: { headers: { Authorization: `Bearer ${handoff.accessToken}` } },
              auth: { persistSession: false, autoRefreshToken: false },
            },
          );
          const { data: userData, error: userError } = await supabase.auth.getUser();
          if (userError || userData.user?.id !== userId) {
            throw new Error("Sign-in expired while connecting Microsoft. Please try again.");
          }
          const token = await exchangeMicrosoftCode(request, code);
          await saveMicrosoftIntegration(supabase, userId, token);
          return redirectWithClearedCookie(request, "/settings?microsoft=connected");
        } catch (err) {
          const message = (err as Error).message.slice(0, 240);
          console.error("[microsoft callback] connection failed", { message });
          return redirectWithClearedCookie(
            request,
            `/settings?microsoft=error&message=${encodeURIComponent(message)}`,
          );
        }
      },
    },
  },
});
