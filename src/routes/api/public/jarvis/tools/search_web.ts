import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { checkSecret, readJson, json } from "@/lib/jarvis-tools.server";

export const Route = createFileRoute("/api/public/jarvis/tools/search_web")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = checkSecret(request);
        if (unauth) return unauth;
        const { query, limit } = await readJson(
          request,
          z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).optional() }),
        );
        const key = process.env.FIRECRAWL_API_KEY;
        if (!key) return json({ error: "web search not configured" }, 500);

        const res = await fetch("https://api.firecrawl.dev/v2/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit: limit ?? 5 }),
        });
        if (!res.ok) return json({ error: `search failed (${res.status})` }, 502);
        const data = (await res.json()) as {
          data?:
            | { web?: Array<{ title?: string; url?: string; description?: string }> }
            | Array<{ title?: string; url?: string; description?: string }>;
        };
        const arr = Array.isArray(data.data) ? data.data : data.data?.web ?? [];
        const results = arr.slice(0, limit ?? 5).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        }));
        return json({
          query,
          results,
        });
      },
    },
  },
});