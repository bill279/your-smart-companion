import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/web-search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.FIRECRAWL_API_KEY;
        if (!key) return Response.json({ error: "Not configured" }, { status: 500 });
        const body = (await request.json().catch(() => ({}))) as { query?: string; limit?: number };
        const query = body.query?.trim();
        if (!query) return Response.json({ error: "query required" }, { status: 400 });

        const r = await fetch("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit: Math.min(body.limit ?? 5, 10) }),
        });
        if (!r.ok) return Response.json({ error: `Search failed (${r.status})` }, { status: 502 });
        const j = (await r.json()) as {
          data?: { web?: Array<{ title?: string; url?: string; description?: string }> } | Array<{ title?: string; url?: string; description?: string }>;
        };
        const arr = Array.isArray(j.data) ? j.data : j.data?.web ?? [];
        return Response.json({
          results: arr.slice(0, 10).map((x) => ({
            title: x.title,
            url: x.url,
            snippet: x.description,
          })),
        });
      },
    },
  },
});