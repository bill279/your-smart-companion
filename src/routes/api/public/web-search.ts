import { createFileRoute } from "@tanstack/react-router";
import { searchWeb } from "@/lib/web-tools.server";

export const Route = createFileRoute("/api/public/web-search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { query?: string; limit?: number };
        const query = body.query?.trim();
        if (!query) return Response.json({ error: "query required" }, { status: 400 });

        const result = await searchWeb(query, body.limit ?? 5);
        if ("error" in result) return Response.json(result, { status: 502 });
        return Response.json(result);
      },
    },
  },
});
