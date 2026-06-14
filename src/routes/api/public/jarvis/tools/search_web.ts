import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { checkSecret, readJson, json } from "@/lib/jarvis-tools.server";

export const Route = createFileRoute("/api/public/jarvis/tools/search_web")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = checkSecret(request);
        if (unauth) return unauth;
        const { query } = await readJson(
          request,
          z.object({ query: z.string().min(1).max(500) }),
        );
        const res = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`,
        );
        if (!res.ok) return json({ error: "search failed" }, 502);
        const data = (await res.json()) as {
          AbstractText?: string;
          AbstractURL?: string;
          Heading?: string;
          RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        };
        const results = (data.RelatedTopics ?? [])
          .filter((t) => t.Text && t.FirstURL)
          .slice(0, 5)
          .map((t) => ({ title: t.Text, url: t.FirstURL }));
        return json({
          query,
          summary: data.AbstractText || data.Heading || "",
          source: data.AbstractURL || "",
          results,
        });
      },
    },
  },
});