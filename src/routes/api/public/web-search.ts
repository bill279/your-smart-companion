import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/web-search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Require a signed-in user (bearer token). This route is public-prefixed
        // so it bypasses platform auth, so we verify the token here to prevent
        // anyone on the internet from burning our Firecrawl quota.
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const url = process.env.SUPABASE_URL;
        const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!url || !publishable) {
          return Response.json({ error: "Auth not configured" }, { status: 500 });
        }
        const supabase = createClient(url, publishable, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userRes?.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

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