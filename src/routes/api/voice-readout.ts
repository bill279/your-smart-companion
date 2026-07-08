import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const Route = createFileRoute("/api/voice-readout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        if (!auth?.startsWith("Bearer ")) {
          return new Response("Unauthorized", { status: 401 });
        }

        const token = auth.slice(7);
        const SUPABASE_URL = process.env.SUPABASE_URL!;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
        const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
        if (!LOVABLE_API_KEY) {
          return new Response("Voice readout is not configured", { status: 500 });
        }

        const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });
        const { data: claims, error } = await supabase.auth.getClaims(token);
        if (error || !claims?.claims?.sub) {
          return new Response("Unauthorized", { status: 401 });
        }

        const body = (await request.json().catch(() => null)) as { text?: string } | null;
        const text = body?.text?.trim();
        if (!text) return new Response("Text is required", { status: 400 });

        try {
          const response = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "openai/gpt-4o-mini-tts",
              input: text,
              voice: "alloy",
              instructions: "Read clearly and naturally, like a helpful consultant explaining the answer out loud. Keep a steady conversational pace.",
              stream_format: "sse",
              response_format: "pcm",
            }),
            signal: request.signal,
          });

          if (!response.ok) {
            const err = await response.text().catch(() => "");
            return new Response(err || `TTS failed: ${response.status}`, { status: response.status });
          }

          return new Response(response.body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (err) {
          if (request.signal.aborted) return new Response(null, { status: 499 });
          return new Response(err instanceof Error ? err.message : "TTS failed", { status: 500 });
        }
      },
    },
  },
});