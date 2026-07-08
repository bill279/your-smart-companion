import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { computeCost } from "@/lib/usage-pricing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logUsage(sb: any, userId: string, kind: string, model: string | null, inTok: number, outTok: number, cost: number, meta: Record<string, unknown> = {}) {
  try {
    await sb.from("usage_events").insert({
      user_id: userId,
      kind,
      model,
      input_tokens: Math.max(0, Math.round(inTok)),
      output_tokens: Math.max(0, Math.round(outTok)),
      cost_usd: Number(cost.toFixed(6)),
      metadata: meta as never,
    });
  } catch { /* ignore */ }
}

export const voiceWebScrape = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ url: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) return { error: "Web scrape not configured" };
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: data.url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!r.ok) return { error: `Scrape failed (${r.status})` };
    const j = (await r.json()) as { data?: { markdown?: string; metadata?: { title?: string } } };
    const md = j.data?.markdown ?? "";
    await logUsage(context.supabase, context.userId, "tool_call", null, 0, 0, 0.002, { tool: "web_scrape", url: data.url });
    return {
      title: j.data?.metadata?.title,
      markdown: md.length > 6000 ? md.slice(0, 6000) + "\n\n…[truncated]" : md,
    };
  });

export const voiceProductSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(6).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) return { error: "Product search not configured" };
    const n = Math.min(data.limit ?? 5, 6);
    const r = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: data.query,
        limit: n,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    });
    if (!r.ok) return { error: `Product search failed (${r.status})` };
    const j = (await r.json()) as {
      data?: Array<{
        title?: string;
        url?: string;
        description?: string;
        markdown?: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    const arr = Array.isArray(j.data) ? j.data : [];
    const hostname = (u?: string) => { if (!u) return undefined; try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return undefined; } };
    const extractPrice = (text?: string) => {
      if (!text) return undefined;
      const m = text.match(/(?:USD|CAD|AUD|GBP|EUR)?\s?[$£€¥]\s?\d{1,3}(?:[,\s]?\d{3})*(?:\.\d{1,2})?/);
      return m?.[0]?.trim();
    };
    const products = arr.slice(0, n).map((x) => {
      const meta = (x.metadata ?? {}) as Record<string, unknown>;
      const image = (meta.ogImage as string | undefined) ?? (meta["og:image"] as string | undefined) ?? (meta.image as string | undefined);
      return {
        title: x.title ?? (meta.title as string | undefined),
        url: x.url,
        image,
        price: extractPrice(x.markdown) ?? extractPrice(x.description),
        merchant: (meta.ogSiteName as string | undefined) ?? hostname(x.url),
        snippet: x.description ?? (meta.description as string | undefined),
      };
    });
    await logUsage(context.supabase, context.userId, "tool_call", null, 0, 0, 0.005, { tool: "product_search", query: data.query });
    return { products };
  });

export const voiceKnowledgeSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
    if (!LOVABLE_API_KEY) return { error: "AI gateway not configured" };
    const r = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": LOVABLE_API_KEY,
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: data.query }),
    });
    if (!r.ok) return { error: `Embedding failed (${r.status})` };
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    const qvec = j.data[0]?.embedding;
    if (!qvec) return { error: "No embedding" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = context.supabase as any;
    const { data: matches, error } = await sb.rpc("match_kb_chunks", {
      query_embedding: qvec as unknown as string,
      match_user_id: context.userId,
      match_count: data.limit ?? 6,
    });
    if (error) return { error: error.message };
    const inTok = Math.ceil(data.query.length / 4);
    await logUsage(sb, context.userId, "embedding", "openai/text-embedding-3-small", inTok, 0, computeCost("openai/text-embedding-3-small", inTok, 0), { via: "voice" });
    return {
      results: (matches ?? []).map((m: { document_name: string; similarity: number; content: string }) => ({
        document: m.document_name,
        similarity: Number(m.similarity?.toFixed?.(3) ?? 0),
        content: m.content,
      })),
    };
  });

export const voiceRecallFacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = context.supabase as any;
    const { data, error } = await sb
      .from("user_facts")
      .select("key,value,source,updated_at")
      .order("updated_at", { ascending: false });
    if (error) return { error: error.message };
    return { facts: data ?? [] };
  });

export const voiceRememberFact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ key: z.string().min(1).max(120), value: z.string().min(1).max(2000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const normKey = data.key.trim().toLowerCase().replace(/\s+/g, "_");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = context.supabase as any;
    const { error } = await sb
      .from("user_facts")
      .upsert(
        { user_id: context.userId, key: normKey, value: data.value.trim(), source: "voice" },
        { onConflict: "user_id,key" },
      );
    if (error) return { error: error.message };
    return { ok: true, key: normKey };
  });

export const voiceSaveLesson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ lesson: z.string().min(4).max(500), context: z.string().max(300).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = context.supabase as any;
    const { error } = await sb.from("lessons_learned").insert({
      user_id: context.userId,
      lesson: data.lesson.trim(),
      context: data.context?.trim() ?? null,
      source: "voice",
    });
    if (error) return { error: error.message };
    return { ok: true };
  });