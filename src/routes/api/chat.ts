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
- send_email — send an email from the user's connected Outlook (preferred) or Gmail account. Use when the user asks to email someone (including themselves).
- list_contacts — load the user's saved address book (name, email, notes). Call this BEFORE asking the user for an email address whenever they refer to a recipient by name (e.g. "email Mike", "send this to Sarah at BP"). Match by name (case-insensitive, partial OK).
- save_contact — add or update a contact in the user's address book. Use when the user says things like "save this as a contact", "remember john@x.com as John", or after they confirm a brand-new recipient you should remember.
- list_calendar_events — list upcoming events from the user's connected calendar (Outlook preferred, Google fallback). Use for "what's on my calendar", "am I free Thursday", "next meeting".
- create_calendar_event — create a new event on the user's connected calendar (Outlook preferred, Google fallback). Confirm title, start, end, and attendees with the user before calling.

Use them instead of refusing or saying you cannot browse. Cite sources with markdown links.

# Calendar flow
- For event creation, ALWAYS show a draft preview (title, date/time with timezone, attendees, location, description) and wait for explicit approval ("create", "yes", "schedule it") before calling \`create_calendar_event\`.
- Interpret relative times ("tomorrow 3pm", "next Tuesday") using the user's local timezone. If unsure, ask.
- Default event length is 30 minutes unless the user says otherwise.

# Saved contacts flow
- When the user names a person (not an email), call \`list_contacts\` first. If exactly one match, confirm "Send to Mike Johnson at mike@example.com?" before drafting. If multiple matches, list them and ask which. If no match, ask for the address and offer to save it.
- Never invent an email. Never call \`send_email\` with an address you didn't get from the user, the # Current user block, or \`list_contacts\`.

# Email approval flow (mandatory)
Never call \`send_email\` on the first request. Always confirm the recipient first, then draft, then wait for explicit approval.

1. When the user asks to send an email, do NOT call the tool yet.
2. **Confirm the recipient first.** Restate the exact email address you intend to use and ask the user to confirm before drafting (e.g. "Just to confirm — send to john@example.com?"). The only exception: when the user says "email me" / "send it to me" and you already know their address from the # Current user section, you may proceed without re-asking. Never guess or invent an address — if you don't have one, ask for it.
3. After the recipient is confirmed, reply with a clearly formatted draft preview using this exact structure:

   **Draft email — please review**

   - **To:** recipient@example.com
   - **Cc:** (only if provided)
   - **Subject:** ...

   ---

   <the full email body in Markdown, exactly as it will be sent>

   ---

   Reply **"send"** to send it, or tell me what to change.

4. Only call \`send_email\` after the user explicitly approves (e.g. "send", "send it", "yes", "approved", "looks good send it"). Any edit request means produce a new draft preview and wait again.
5. Email bodies must always be clean, professional Markdown: a greeting line, short well-structured paragraphs, bullet lists or tables where helpful, and a sign-off. Never send a raw unformatted dump.
6. After sending, confirm with the recipient and subject.

# Identity
You are BPA Bot. Never refer to yourself as JARVIS or any other name.`;

const BAD_TABLE_REFUSAL = /(?:I(?:'m| am)\s+)?unable to display a visual table directly in this chat interface\.?/gi;

function cleanAssistantText(text: string) {
  return text
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    .replace(/^\s*Hello there!\s*I'm Alex[\s\S]*?today\??\s*/i, "")
    .replace(/^\s*How can I help you with web research or sending emails today\??\s*/i, "")
    .replace(/Hello there!\s*I'm Alex, your personal assistant\.\s*/gi, "")
    .replace(BAD_TABLE_REFUSAL, "Here is the table:")
    .trim();
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
        const userEmail =
          (claims.claims as { email?: string }).email ?? null;

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
        const systemWithUser = userEmail
          ? `${SYSTEM_PROMPT}\n\n# Current user\nThe signed-in user's email address is ${userEmail}. When they say "email me", "send it to me", or otherwise refer to themselves as the recipient, use exactly this address. Never invent or guess an email address — if you don't have one, ask.`
          : `${SYSTEM_PROMPT}\n\n# Current user\nYou do not know the signed-in user's email address. If they say "email me" without giving an address, ask them for it. Never invent an email address.`;
        const result = streamText({
          model: gateway("google/gemini-3-flash-preview"),
          system: systemWithUser,
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
            send_email: tool({
              description:
                "Send an email from the user's connected Outlook (preferred) or Gmail account. Use when the user asks to email someone, send a message, or email themselves.",
              inputSchema: z.object({
                to: z.string().email().describe("Recipient email address"),
                subject: z.string().min(1).max(200),
                body: z.string().min(1).max(20000),
                cc: z.string().email().optional(),
              }),
              execute: async ({ to, subject, body: emailBody, cc }) => {
                const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
                const { marked } = await import("marked");
                const renderHtml = (md: string) => {
                  const inner = marked.parse(md, { gfm: true, breaks: true, async: false }) as string;
                  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.55;margin:0;padding:24px;background:#fff;}
.container{max-width:640px;margin:0 auto;}
h1,h2,h3{color:#0b2545;margin:1.2em 0 .4em;}
p{margin:.6em 0;} a{color:#0b6e3f;}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}
pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:8px;overflow:auto;} pre code{background:transparent;padding:0;color:inherit;}
blockquote{border-left:3px solid #0b6e3f;margin:.8em 0;padding:.2em 0 .2em 12px;color:#334155;}
ul,ol{padding-left:22px;}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;}
th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;vertical-align:top;}
th{background:#0b2545;color:#fff;font-weight:600;} tr:nth-child(even) td{background:#f8fafc;}
hr{border:none;border-top:1px solid #e2e8f0;margin:18px 0;}
</style></head><body><div class="container">${inner}</div></body></html>`;
                };
                 if (process.env.MICROSOFT_OUTLOOK_API_KEY) {
                   const r = await fetch(
                     "https://connector-gateway.lovable.dev/microsoft_outlook/me/sendMail",
                     {
                       method: "POST",
                       headers: gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY"),
                       body: JSON.stringify({
                         message: {
                           subject,
                           body: { contentType: "HTML", content: renderHtml(emailBody) },
                           toRecipients: [{ emailAddress: { address: to } }],
                           ...(cc
                             ? { ccRecipients: [{ emailAddress: { address: cc } }] }
                             : {}),
                         },
                       }),
                     },
                   );
                   if (!r.ok) {
                     const t = await r.text();
                     return { error: `Outlook send failed (${r.status})`, detail: t.slice(0, 200) };
                   }
                   return { ok: true, provider: "outlook", to, subject };
                 }
                 if (process.env.GOOGLE_MAIL_API_KEY) {
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
                    emailBody,
                    "",
                    `--${boundary}`,
                    "Content-Type: text/html; charset=UTF-8",
                    "",
                    renderHtml(emailBody),
                    "",
                    `--${boundary}--`,
                    "",
                  );
                  const raw = Buffer.from(lines.join("\r\n"))
                    .toString("base64")
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_")
                    .replace(/=+$/, "");
                  const r = await fetch(
                    "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
                    {
                      method: "POST",
                      headers: gatewayHeaders("GOOGLE_MAIL_API_KEY"),
                      body: JSON.stringify({ raw }),
                    },
                  );
                  if (!r.ok) {
                    const t = await r.text();
                    return { error: `Gmail send failed (${r.status})`, detail: t.slice(0, 200) };
                  }
                  return { ok: true, provider: "gmail", to, subject };
                }
                return { error: "No email provider connected." };
              },
            }),
            list_contacts: tool({
              description:
                "List the signed-in user's saved contacts (name, email, notes). Call this whenever the user refers to a recipient by name instead of email.",
              inputSchema: z.object({}),
              execute: async () => {
                const { data, error } = await supabase
                  .from("contacts")
                  .select("id,name,email,notes")
                  .order("name", { ascending: true });
                if (error) return { error: error.message };
                return { contacts: data ?? [] };
              },
            }),
            save_contact: tool({
              description:
                "Save or update a contact in the user's address book. Use when the user asks to remember someone, or after they confirm a brand-new recipient.",
              inputSchema: z.object({
                name: z.string().min(1).max(120),
                email: z.string().email(),
                notes: z.string().max(2000).optional(),
              }),
              execute: async ({ name, email, notes }) => {
                const { data, error } = await supabase
                  .from("contacts")
                  .upsert(
                    {
                      user_id: userId,
                      name: name.trim(),
                      email: email.trim().toLowerCase(),
                      notes: notes ?? null,
                    },
                    { onConflict: "user_id,email" },
                  )
                  .select()
                  .single();
                if (error) return { error: error.message };
                return { ok: true, contact: data };
              },
            }),
            list_calendar_events: tool({
              description:
                "List upcoming events from the user's connected calendar (Outlook preferred, Google fallback) within a date range.",
              inputSchema: z.object({
                days: z.number().int().min(1).max(60).optional().describe("How many days ahead to look. Default 7."),
                max_results: z.number().int().min(1).max(50).optional(),
              }),
              execute: async ({ days, max_results }) => {
                const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
                const now = new Date();
                const end = new Date(now.getTime() + (days ?? 7) * 86400000);
                const top = String(max_results ?? 10);
                if (process.env.MICROSOFT_OUTLOOK_API_KEY) {
                  const params = new URLSearchParams({
                    startDateTime: now.toISOString(),
                    endDateTime: end.toISOString(),
                    $orderby: "start/dateTime",
                    $top: top,
                  });
                  const r = await fetch(
                    `https://connector-gateway.lovable.dev/microsoft_outlook/me/calendarView?${params}`,
                    { headers: gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY") },
                  );
                  if (!r.ok) {
                    const t = await r.text();
                    return { error: `Outlook calendar read failed (${r.status})`, detail: t.slice(0, 200) };
                  }
                  const j = (await r.json()) as {
                    value?: Array<{
                      id: string;
                      subject?: string;
                      start?: { dateTime?: string; timeZone?: string };
                      end?: { dateTime?: string; timeZone?: string };
                      location?: { displayName?: string };
                      webLink?: string;
                      attendees?: Array<{ emailAddress?: { address?: string } }>;
                    }>;
                  };
                  return {
                    provider: "outlook",
                    events: (j.value ?? []).map((e) => ({
                      id: e.id,
                      title: e.subject ?? "(no title)",
                      start: e.start?.dateTime,
                      end: e.end?.dateTime,
                      timezone: e.start?.timeZone,
                      location: e.location?.displayName,
                      link: e.webLink,
                      attendees: (e.attendees ?? [])
                        .map((a) => a.emailAddress?.address)
                        .filter(Boolean),
                    })),
                  };
                }
                if (!process.env.GOOGLE_CALENDAR_API_KEY) {
                  return { error: "No calendar provider connected." };
                }
                const gparams = new URLSearchParams({
                  timeMin: now.toISOString(),
                  timeMax: end.toISOString(),
                  singleEvents: "true",
                  orderBy: "startTime",
                  maxResults: top,
                });
                const r = await fetch(
                  `https://connector-gateway.lovable.dev/google_calendar/calendar/v3/calendars/primary/events?${gparams}`,
                  { headers: gatewayHeaders("GOOGLE_CALENDAR_API_KEY") },
                );
                if (!r.ok) {
                  const t = await r.text();
                  return { error: `Calendar read failed (${r.status})`, detail: t.slice(0, 200) };
                }
                const j = (await r.json()) as {
                  items?: Array<{
                    id: string;
                    summary?: string;
                    start?: { dateTime?: string; date?: string; timeZone?: string };
                    end?: { dateTime?: string; date?: string; timeZone?: string };
                    location?: string;
                    htmlLink?: string;
                    attendees?: Array<{ email?: string }>;
                  }>;
                };
                return {
                  provider: "google",
                  events: (j.items ?? []).map((e) => ({
                    id: e.id,
                    title: e.summary ?? "(no title)",
                    start: e.start?.dateTime ?? e.start?.date,
                    end: e.end?.dateTime ?? e.end?.date,
                    location: e.location,
                    link: e.htmlLink,
                    attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
                  })),
                };
              },
            }),
            create_calendar_event: tool({
              description:
                "Create a new event on the user's connected calendar (Outlook preferred, Google fallback). Only call after the user has approved the draft.",
              inputSchema: z.object({
                title: z.string().min(1).max(200),
                start: z.string().describe("ISO 8601 start datetime, e.g. 2026-07-01T15:00:00-04:00"),
                end: z.string().describe("ISO 8601 end datetime"),
                description: z.string().max(5000).optional(),
                location: z.string().max(500).optional(),
                attendees: z.array(z.string().email()).optional(),
                timezone: z.string().optional().describe("IANA timezone, e.g. America/New_York"),
              }),
              execute: async ({ title, start, end, description, location, attendees, timezone }) => {
                const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
                if (process.env.MICROSOFT_OUTLOOK_API_KEY) {
                  const r = await fetch(
                    "https://connector-gateway.lovable.dev/microsoft_outlook/me/events",
                    {
                      method: "POST",
                      headers: gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY"),
                      body: JSON.stringify({
                        subject: title,
                        body: description
                          ? { contentType: "HTML", content: description }
                          : undefined,
                        start: { dateTime: start, timeZone: timezone ?? "UTC" },
                        end: { dateTime: end, timeZone: timezone ?? "UTC" },
                        ...(location ? { location: { displayName: location } } : {}),
                        ...(attendees && attendees.length
                          ? {
                              attendees: attendees.map((email) => ({
                                emailAddress: { address: email },
                                type: "required",
                              })),
                            }
                          : {}),
                      }),
                    },
                  );
                  if (!r.ok) {
                    const t = await r.text();
                    return { error: `Outlook calendar create failed (${r.status})`, detail: t.slice(0, 200) };
                  }
                  const j = (await r.json()) as { id?: string; webLink?: string };
                  return { ok: true, provider: "outlook", id: j.id, link: j.webLink };
                }
                if (!process.env.GOOGLE_CALENDAR_API_KEY) {
                  return { error: "No calendar provider connected." };
                }
                const r = await fetch(
                  "https://connector-gateway.lovable.dev/google_calendar/calendar/v3/calendars/primary/events",
                  {
                    method: "POST",
                    headers: gatewayHeaders("GOOGLE_CALENDAR_API_KEY"),
                    body: JSON.stringify({
                      summary: title,
                      description,
                      location,
                      start: { dateTime: start, ...(timezone ? { timeZone: timezone } : {}) },
                      end: { dateTime: end, ...(timezone ? { timeZone: timezone } : {}) },
                      ...(attendees && attendees.length
                        ? { attendees: attendees.map((email) => ({ email })) }
                        : {}),
                    }),
                  },
                );
                if (!r.ok) {
                  const t = await r.text();
                  return { error: `Calendar create failed (${r.status})`, detail: t.slice(0, 200) };
                }
                const j = (await r.json()) as { id?: string; htmlLink?: string };
                return { ok: true, provider: "google", id: j.id, link: j.htmlLink };
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