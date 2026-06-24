import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

const SYSTEM_PROMPT = `You are BPA Bot, the AI assistant for BP Automation (custom engineering solutions). You are professional, clear, and concise — like a sharp executive assistant.

# Formatting (very important)
Always respond in clean Markdown that renders beautifully:
- Lead with a short direct answer (1–2 sentences).
- Use **bold** for key terms and short bullet lists for steps, options, or comparisons.
- Use ## headings only for longer multi-part answers; skip them for short replies.
- Use GitHub-Flavored Markdown tables (| col | col |) whenever the user asks for a table, a visual table, a comparison, a schedule, specs, rows/columns, or any tabular data. Tables render natively in this chat — never say you cannot display a table or a visual table directly.
- Use fenced code blocks with a language tag for code.
- Cite sources inline as [link text](https://...).
- Never wrap the whole response in a code block. Never dump raw JSON unless explicitly asked.
- Keep paragraphs short (2–4 lines).

# Conversation behavior
- Continue from the existing thread history. Do not introduce yourself or greet again after the first exchange.
- If the user asks for a table, output the Markdown table immediately instead of explaining limitations.
- Forbidden response: "I am unable to display a visual table directly in this chat interface." Do not say anything equivalent.

# Live web access
You have tools:
- web_search — search the live web. Use it for anything time-sensitive: companies, people, news, prices, products, current facts.
- web_scrape — fetch the readable markdown of a specific URL.

Use them instead of refusing or saying you cannot browse. Cite sources with markdown links.

# Identity
You are BPA Bot. Never refer to yourself as JARVIS or any other name.`;

const BAD_TABLE_REFUSAL = /(?:I(?:'m| am)\s+)?unable to display a visual table directly in this chat interface\.?/gi;

function cleanAssistantText(text: string) {
  return text.replace(BAD_TABLE_REFUSAL, "Here is the table:").trim();
}

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
          stopWhen: stepCountIs(50),
          tools: {
            web_search: tool({
              description:
                "Search the live web. Returns a list of results with title, url, and snippet. Use for current events, facts, prices, anything time-sensitive.",
              inputSchema: z.object({
                query: z.string().describe("The search query"),
                limit: z.number().int().min(1).max(10).optional(),
              }),
              execute: async ({ query, limit }) => {
                const key = process.env.FIRECRAWL_API_KEY;
                if (!key) return { error: "Web search not configured" };
                const r = await fetch("https://api.firecrawl.dev/v2/search", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ query, limit: limit ?? 5 }),
                });
                if (!r.ok) return { error: `Search failed (${r.status})` };
                const j = (await r.json()) as {
                  data?: { web?: Array<{ title?: string; url?: string; description?: string }> } | Array<{ title?: string; url?: string; description?: string }>;
                };
                const arr = Array.isArray(j.data) ? j.data : j.data?.web ?? [];
                return {
                  results: arr.slice(0, limit ?? 5).map((x) => ({
                    title: x.title,
                    url: x.url,
                    snippet: x.description,
                  })),
                };
              },
            }),
            web_scrape: tool({
              description: "Fetch the readable markdown contents of a specific URL.",
              inputSchema: z.object({ url: z.string().url() }),
              execute: async ({ url }) => {
                const key = process.env.FIRECRAWL_API_KEY;
                if (!key) return { error: "Web scrape not configured" };
                const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    url,
                    formats: ["markdown"],
                    onlyMainContent: true,
                  }),
                });
                if (!r.ok) return { error: `Scrape failed (${r.status})` };
                const j = (await r.json()) as {
                  data?: { markdown?: string; metadata?: { title?: string } };
                };
                const md = j.data?.markdown ?? "";
                return {
                  title: j.data?.metadata?.title,
                  markdown: md.length > 8000 ? md.slice(0, 8000) + "\n\n…[truncated]" : md,
                };
              },
            }),
          },
          onFinish: async ({ text }) => {
            await supabase.from("messages").insert({
              thread_id: body.threadId!,
              user_id: userId,
              role: "assistant",
              content: cleanAssistantText(text),
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