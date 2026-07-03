import { createFileRoute } from "@tanstack/react-router";
import {
  exchangeMicrosoftCode,
  saveMicrosoftIntegration,
  verifyMicrosoftOAuthState,
} from "@/lib/microsoft-integration.server";

export const Route = createFileRoute("/api/integrations/microsoft/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          return Response.redirect(new URL(`/settings?microsoft=error&message=${encodeURIComponent(error)}`, request.url));
        }
        if (!code || !state) {
          return Response.redirect(new URL("/settings?microsoft=missing_code", request.url));
        }
        try {
          const { userId } = verifyMicrosoftOAuthState(state);
          const token = await exchangeMicrosoftCode(request, code);
          await saveMicrosoftIntegration(userId, token);
          return Response.redirect(new URL("/settings?microsoft=connected", request.url));
        } catch (err) {
          const message = encodeURIComponent((err as Error).message.slice(0, 200));
          return Response.redirect(new URL(`/settings?microsoft=error&message=${message}`, request.url));
        }
      },
    },
  },
});
