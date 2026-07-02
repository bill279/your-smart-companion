import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { gatewayHeaders } from "@/lib/jarvis-tools.server";
import { marked } from "marked";

// Server-side dispatcher for OpenAI Realtime function calls. The Realtime
// session runs in the browser but tool execution stays on the server so
// secrets (Firecrawl, Gmail/Outlook connectors) never touch the client.

const Body = z.object({
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderEmailHtml(markdown: string) {
  const inner = marked.parse(markdown, { gfm: true, breaks: true, async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.55;margin:0;padding:24px;background:#fff;}
    .container{max-width:640px;margin:0 auto;}
    h1,h2,h3{color:#0b2545;margin:1.2em 0 .4em;}
    a{color:#0b6e3f;} table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;}
    th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;vertical-align:top;}
    th{background:#0b2545;color:#fff;} tr:nth-child(even) td{background:#f8fafc;}
  </style></head><body><div class="container">${inner}</div></body></html>`;
}

function buildRfc2822(to: string, subject: string, body: string, cc?: string) {
  const html = renderEmailHtml(body);
  const boundary = `bpa_${Math.random().toString(36).slice(2)}`;
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    "",
    `--${boundary}--`,
    "",
  );
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function runWebSearch(args: Record<string, unknown>) {
  const p = z
    .object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(6).optional() })
    .safeParse(args);
  if (!p.success) return { error: "invalid arguments for web_search" };
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { error: "web search not configured" };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: p.data.query, limit: Math.min(p.data.limit ?? 4, 5) }),
      signal: ac.signal,
    });
    if (!r.ok) return { error: `search failed (${r.status})` };
    const j = (await r.json()) as {
      data?:
        | { web?: Array<{ title?: string; url?: string; description?: string }> }
        | Array<{ title?: string; url?: string; description?: string }>;
    };
    const arr = Array.isArray(j.data) ? j.data : j.data?.web ?? [];
    return {
      results: arr.slice(0, p.data.limit ?? 5).map((x) => ({
        title: x.title,
        url: x.url,
        snippet: x.description,
      })),
    };
  } catch {
    return { error: "search timed out" };
  } finally {
    clearTimeout(t);
  }
}

async function runWebScrape(args: Record<string, unknown>) {
  const p = z.object({ url: z.string().url() }).safeParse(args);
  if (!p.success) return { error: "invalid arguments for web_scrape" };
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { error: "web scrape not configured" };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: p.data.url, formats: ["markdown"], onlyMainContent: true }),
      signal: ac.signal,
    });
    if (!r.ok) return { error: `scrape failed (${r.status})` };
    const j = (await r.json()) as { data?: { markdown?: string; metadata?: { title?: string } } };
    const md = j.data?.markdown ?? "";
    return {
      title: j.data?.metadata?.title,
      markdown: md.length > 3500 ? md.slice(0, 3500) + "\n…[truncated]" : md,
    };
  } catch {
    return { error: "scrape timed out" };
  } finally {
    clearTimeout(t);
  }
}

async function runSendEmail(args: Record<string, unknown>) {
  const p = z
    .object({
      to: z.string().email(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20000),
      cc: z.string().email().optional(),
    })
    .safeParse(args);
  if (!p.success) return { error: "invalid arguments for send_email" };

  if (process.env.MICROSOFT_OUTLOOK_API_KEY) {
    const payload = {
      message: {
        subject: p.data.subject,
        body: { contentType: "HTML", content: renderEmailHtml(p.data.body) },
        toRecipients: [{ emailAddress: { address: p.data.to } }],
        ...(p.data.cc ? { ccRecipients: [{ emailAddress: { address: p.data.cc } }] } : {}),
      },
    };
    const res = await fetch(
      "https://connector-gateway.lovable.dev/microsoft_outlook/me/sendMail",
      {
        method: "POST",
        headers: gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY"),
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) return { error: `outlook send failed (${res.status})` };
    return { ok: true, provider: "outlook", to: p.data.to, subject: p.data.subject };
  }
  if (process.env.GOOGLE_MAIL_API_KEY) {
    const raw = buildRfc2822(p.data.to, p.data.subject, p.data.body, p.data.cc);
    const res = await fetch(
      "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: gatewayHeaders("GOOGLE_MAIL_API_KEY"),
        body: JSON.stringify({ raw }),
      },
    );
    if (!res.ok) return { error: `gmail send failed (${res.status})` };
    return { ok: true, provider: "gmail", to: p.data.to, subject: p.data.subject };
  }
  return { error: "No email provider connected." };
}

async function runGenerateDocument(
  supabase: ReturnType<typeof createClient<Database>>,
  userId: string,
  args: Record<string, unknown>,
) {
  const p = z
    .object({
      format: z.enum(["pdf", "docx", "md", "xlsx", "csv", "txt"]),
      filename: z.string().min(1).max(120),
      title: z.string().min(1).max(200),
      summary: z.string().max(2000).optional(),
      sources: z
        .array(z.object({ title: z.string().max(300), url: z.string().url() }))
        .max(20)
        .optional(),
      markdown: z.string().min(1).max(200000),
    })
    .safeParse(args);
  if (!p.success) return { error: "invalid arguments for generate_document" };
  try {
    const { generateDocument } = await import("@/lib/document-generator.server");
    const dateLine = `_Generated ${new Date().toISOString().slice(0, 10)}_`;
    const summaryBlock = p.data.summary?.trim() ? `\n\n## Summary\n\n${p.data.summary.trim()}\n` : "";
    const sourcesBlock =
      p.data.sources && p.data.sources.length > 0
        ? `\n\n## Sources\n\n${p.data.sources
            .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
            .join("\n")}\n`
        : "";
    const composed = `${dateLine}${summaryBlock}\n\n${p.data.markdown}${sourcesBlock}`;
    const { bytes, mimeType, extension } = await generateDocument({
      format: p.data.format,
      title: p.data.title,
      markdown: composed,
    });
    const safeName = p.data.filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    const path = `${userId}/generated/${Date.now()}-${safeName}.${extension}`;
    const up = await supabase.storage
      .from("chat-uploads")
      .upload(path, bytes, { contentType: mimeType, upsert: false });
    if (up.error) return { error: up.error.message };
    const signed = await supabase.storage
      .from("chat-uploads")
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signed.error) return { error: signed.error.message };
    return {
      ok: true,
      artifact: {
        title: p.data.title,
        format: extension,
        filename: `${safeName}.${extension}`,
        url: signed.data.signedUrl,
        mimeType,
        createdAt: new Date().toISOString(),
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "document generation failed" };
  }
}

export const Route = createFileRoute("/api/realtime/tool")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
        if (!token) return new Response("Unauthorized", { status: 401 });

        const supabase = createClient<Database>(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          },
        );
        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr || !userData.user) return new Response("Unauthorized", { status: 401 });

        const parsed = Body.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) return jr({ error: parsed.error.message }, 400);

        try {
          switch (parsed.data.name) {
            case "web_search":
              return jr(await runWebSearch(parsed.data.arguments));
            case "web_scrape":
              return jr(await runWebScrape(parsed.data.arguments));
            case "send_email":
              return jr(await runSendEmail(parsed.data.arguments));
            case "generate_document":
              return jr(await runGenerateDocument(supabase, userData.user.id, parsed.data.arguments));
            default:
              return jr({ error: `unknown tool: ${parsed.data.name}` }, 400);
          }
        } catch (err) {
          console.error("[realtime tool]", parsed.data.name, err);
          return jr({ error: "tool execution failed" }, 500);
        }
      },
    },
  },
});
