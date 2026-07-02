import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { checkSecret, readJson, json } from "@/lib/jarvis-tools.server";
import { searchWeb } from "@/lib/web-tools.server";

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
        const result = await searchWeb(query, limit ?? 5);
        if ("error" in result) return json(result, 502);
        return json(result);
      },
    },
  },
});
