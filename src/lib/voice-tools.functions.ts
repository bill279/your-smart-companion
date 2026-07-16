import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { computeCost } from "@/lib/usage-pricing";
import { getMicrosoftAccessToken } from "@/lib/ms-graph.server";

async function msGraphFetchForVoice(
  userId: string,
  graphPath: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: string; connected: boolean }> {
  const user = await getMicrosoftAccessToken(userId);
  if (user) {
    const r = await fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    return { ok: r.ok, status: r.status, body: await r.text(), connected: true };
  }
  if (!process.env.MICROSOFT_OUTLOOK_API_KEY) {
    return { ok: false, status: 0, body: "", connected: false };
  }
  const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
  const r = await fetch(`https://connector-gateway.lovable.dev/microsoft_outlook${graphPath}`, {
    ...init,
    headers: {
      ...gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY"),
      ...(init.headers ?? {}),
    },
  });
  return { ok: r.ok, status: r.status, body: await r.text(), connected: true };
}

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

export const voiceSearchEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        query: z.string().max(300).optional(),
        from: z.string().max(200).optional(),
        unread_only: z.boolean().optional(),
        days: z.number().int().min(1).max(90).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const top = data.limit ?? 10;
    const sinceDays = data.days ?? 30;
    const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const filters: string[] = [`receivedDateTime ge ${sinceIso}`];
    if (data.unread_only) filters.push("isRead eq false");
    if (data.from) {
      const safe = data.from.replace(/'/g, "''");
      filters.push(
        `(contains(from/emailAddress/address,'${safe}') or contains(from/emailAddress/name,'${safe}'))`,
      );
    }
    const params = new URLSearchParams();
    params.set("$top", String(top));
    params.set("$select", "id,subject,from,bodyPreview,receivedDateTime,isRead,webLink,hasAttachments");
    params.set("$orderby", "receivedDateTime desc");
    const isSearch = data.query && data.query.trim();
    if (isSearch) {
      params.set("$search", `"${data.query!.trim().replace(/"/g, '\\"')}"`);
    } else {
      params.set("$filter", filters.join(" and "));
    }
    const r = await msGraphFetchForVoice(context.userId, `/me/messages?${params.toString()}`, {
      method: "GET",
      headers: isSearch ? { ConsistencyLevel: "eventual" } : {},
    });
    if (!r.connected) return { error: "Microsoft is not connected. Open Activity & memory and click Connect Microsoft." };
    if (!r.ok) return { error: `Outlook search failed (${r.status})`, detail: r.body.slice(0, 300) };
    const j = JSON.parse(r.body) as {
      value?: Array<{
        id: string;
        subject?: string;
        from?: { emailAddress?: { name?: string; address?: string } };
        bodyPreview?: string;
        receivedDateTime: string;
        isRead?: boolean;
        webLink?: string;
        hasAttachments?: boolean;
      }>;
    };
    return {
      messages: (j.value ?? []).map((m) => ({
        id: m.id,
        subject: m.subject ?? "(no subject)",
        from_name: m.from?.emailAddress?.name ?? "",
        from_email: m.from?.emailAddress?.address ?? "",
        preview: (m.bodyPreview ?? "").slice(0, 300),
        received_at: m.receivedDateTime,
        is_read: m.isRead ?? true,
        has_attachments: m.hasAttachments ?? false,
        web_link: m.webLink ?? null,
      })),
    };
  });

export const voiceReadEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ message_id: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const path = `/me/messages/${encodeURIComponent(data.message_id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,webLink,hasAttachments`;
    const r = await msGraphFetchForVoice(context.userId, path, { method: "GET" });
    if (!r.connected) return { error: "Microsoft is not connected." };
    if (!r.ok) return { error: `Couldn't load that email (${r.status})`, detail: r.body.slice(0, 300) };
    const m = JSON.parse(r.body) as {
      id: string;
      subject?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
      ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
      receivedDateTime: string;
      body?: { contentType?: string; content?: string };
      bodyPreview?: string;
      webLink?: string;
      hasAttachments?: boolean;
    };
    let text = m.body?.content ?? m.bodyPreview ?? "";
    if ((m.body?.contentType ?? "").toLowerCase() === "html") {
      text = text
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    return {
      id: m.id,
      subject: m.subject ?? "(no subject)",
      from_name: m.from?.emailAddress?.name ?? "",
      from_email: m.from?.emailAddress?.address ?? "",
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
      cc: (m.ccRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
      received_at: m.receivedDateTime,
      has_attachments: m.hasAttachments ?? false,
      web_link: m.webLink ?? null,
      body: text.slice(0, 6000),
    };
  });

export const voiceListEmailAttachments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ message_id: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    const path = `/me/messages/${encodeURIComponent(data.message_id)}/attachments?$select=id,name,contentType,size`;
    const r = await msGraphFetchForVoice(context.userId, path, { method: "GET" });
    if (!r.connected) return { error: "Microsoft is not connected." };
    if (!r.ok) return { error: `Couldn't list attachments (${r.status})`, detail: r.body.slice(0, 300) };
    const j = JSON.parse(r.body) as {
      value?: Array<{ id: string; name?: string; contentType?: string; size?: number }>;
    };
    return {
      attachments: (j.value ?? []).map((a) => ({
        id: a.id,
        name: a.name ?? "(unnamed)",
        content_type: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      })),
    };
  });

export const voiceReadEmailAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        message_id: z.string().min(1),
        attachment_id: z.string().min(1).optional(),
        prompt: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // List attachments, then pick the requested one (or the first if unspecified).
    const listPath = `/me/messages/${encodeURIComponent(data.message_id)}/attachments?$select=id,name,contentType,size`;
    const listR = await msGraphFetchForVoice(context.userId, listPath, { method: "GET" });
    if (!listR.connected) return { error: "Microsoft is not connected." };
    if (!listR.ok) return { error: `Couldn't list attachments (${listR.status})`, detail: listR.body.slice(0, 300) };
    const list = JSON.parse(listR.body) as {
      value?: Array<{ id: string; name?: string; contentType?: string; size?: number }>;
    };
    const atts = list.value ?? [];
    if (atts.length === 0) return { error: "This email has no attachments." };
    const target = data.attachment_id ? atts.find((a) => a.id === data.attachment_id) : atts[0];
    if (!target) {
      return {
        error: "Attachment not found. Ask which one.",
        attachments: atts.map((a) => ({ id: a.id, name: a.name, content_type: a.contentType, size: a.size })),
      };
    }

    // Fetch full attachment bytes.
    const getPath = `/me/messages/${encodeURIComponent(data.message_id)}/attachments/${encodeURIComponent(target.id)}`;
    const r = await msGraphFetchForVoice(context.userId, getPath, { method: "GET" });
    if (!r.ok) return { error: `Couldn't fetch attachment (${r.status})`, detail: r.body.slice(0, 300) };
    const att = JSON.parse(r.body) as {
      name?: string;
      contentType?: string;
      contentBytes?: string;
      size?: number;
      "@odata.type"?: string;
    };
    const mime = (att.contentType || "application/octet-stream").toLowerCase();
    const b64 = att.contentBytes || "";
    if (!b64) return { error: "Attachment has no downloadable content (may be an inline reference)." };

    // Text-like: decode directly.
    if (
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "application/csv"
    ) {
      const txt = Buffer.from(b64, "base64").toString("utf8");
      return {
        name: att.name,
        content_type: mime,
        size: att.size,
        text: txt.slice(0, 8000),
      };
    }

    // Otherwise, ask the AI gateway to read/summarize the file (PDF, image, Office doc).
    const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
    if (!LOVABLE_API_KEY) return { error: "AI gateway not configured", name: att.name, content_type: mime };
    const promptText =
      data.prompt?.trim() ||
      `Read this attachment ("${att.name ?? "file"}") and summarize it clearly for the user so it can be read aloud. Include key facts, dates, names, numbers, tables, and any action items. If it looks like a form or invoice, list the important fields.`;
    const isImage = mime.startsWith("image/");
    const isDoc =
      mime === "application/pdf" ||
      mime.includes("word") ||
      mime.includes("excel") ||
      mime.includes("spreadsheet") ||
      mime.includes("presentation") ||
      mime.includes("officedocument");

    type ContentBlock =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "file"; file: { filename: string; file_data: string } };
    const content: ContentBlock[] = [{ type: "text", text: promptText }];
    if (isImage) {
      content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
    } else if (isDoc) {
      content.push({
        type: "file",
        file: { filename: att.name || "attachment", file_data: `data:${mime};base64,${b64}` },
      });
    } else {
      return {
        error: `Attachment type not supported for reading (${mime}). Try downloading it in Outlook.`,
        name: att.name,
        content_type: mime,
        size: att.size,
      };
    }

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": LOVABLE_API_KEY,
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return { error: `AI read failed (${resp.status})`, detail: t.slice(0, 300), name: att.name, content_type: mime };
    }
    const j = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const summary = j.choices?.[0]?.message?.content ?? "";
    const inTok = j.usage?.prompt_tokens ?? 0;
    const outTok = j.usage?.completion_tokens ?? 0;
    await logUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context.supabase as any,
      context.userId,
      "chat_completion",
      "google/gemini-2.5-flash",
      inTok,
      outTok,
      computeCost("google/gemini-2.5-flash", inTok, outTok),
      { tool: "read_email_attachment", mime },
    );
    return {
      name: att.name,
      content_type: mime,
      size: att.size,
      summary,
    };
  });