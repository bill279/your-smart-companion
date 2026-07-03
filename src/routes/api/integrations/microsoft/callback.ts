import { createFileRoute } from "@tanstack/react-router";

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
        const params = new URLSearchParams({
          microsoft: "complete",
          microsoft_code: code,
          microsoft_state: state,
        });
        return Response.redirect(new URL(`/settings?${params}`, request.url));
      },
    },
  },
});
