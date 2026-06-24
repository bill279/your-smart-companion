import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

const SYSTEM_PROMPT = `You are JARVIS, a witty, concise, and highly capable personal AI assistant in the style of Tony Stark's JARVIS. Be direct, helpful, and a touch dry. Use markdown for structure (lists, code) when useful. Keep replies focused.

You have live web access via tools:
- web_search: search the web for current information. Use this whenever the user asks about news, facts, prices, people, products, or anything that may have changed since training.
- web_scrape: fetch the readable markdown contents of a specific URL.

Always use these tools instead of refusing or saying you cannot browse. Cite sources inline as markdown links when you use them.`;

export const Route = createFileRoute("/api/chat")({
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
          return new Response("AI not configured", { status: 500 });
        }

        const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });

        const { data: claims, error: claimsErr } = await supabase.auth.getClaims(token);
        if (claimsErr || !claims?.claims?.sub) {
          return new Response("Unauthorized", { status: 401 });
        }
        const userId = claims.claims.sub;

        const body = (await request.json()) as { threadId?: string; content?: string };
        if (!body.threadId || !body.content?.trim()) {
          return new Response("Bad request", { status: 400 });
        }

        // Save user message
        const { error: insErr } = await supabase.from("messages").insert({
          thread_id: body.threadId,
          user_id: userId,
          role: "user",
          content: body.content,
        });
        if (insErr) return new Response(insErr.message, { status: 400 });

        // Load full history
        const { data: rows, error: histErr } = await supabase
          .from("messages")
          .select("role,content")
          .eq("thread_id", body.threadId)
          .order("created_at", { ascending: true });
        if (histErr) return new Response(histErr.message, { status: 400 });

        const gateway = createLovableAiGatewayProvider(LOVABLE_API_KEY);
        const result = streamText({
          model: gateway("google/gemini-3-flash-preview"),
          system: SYSTEM_PROMPT,
          messages: (rows ?? []).map((r) => ({
            role: r.role as "user" | "assistant" | "system",
            content: r.content,
          })),
          onFinish: async ({ text }) => {
            await supabase.from("messages").insert({
              thread_id: body.threadId!,
              user_id: userId,
              role: "assistant",
              content: text,
            });
            await supabase
              .from("threads")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", body.threadId!);
            // Auto-name new threads on first reply
            const { data: t } = await supabase
              .from("threads")
              .select("title")
              .eq("id", body.threadId!)
              .single();
            if (t?.title === "New conversation") {
              const firstUser = (rows ?? []).find((r) => r.role === "user")?.content ?? body.content!;
              const title = firstUser.slice(0, 48).replace(/\s+/g, " ").trim();
              await supabase.from("threads").update({ title }).eq("id", body.threadId!);
            }
          },
        });

        return result.toTextStreamResponse();
      },
    },
  },
});