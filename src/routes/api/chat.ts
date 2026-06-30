import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

const SYSTEM_PROMPT = `You are BPA Bot, the AI assistant for BP Automation (custom engineering solutions). Write like the best of ChatGPT and Claude: warm, sharp, and effortlessly clear.

# Tone & Personality (Claude-style house rules — highest priority)
- Warm but not sycophantic. Never open with "Great question!", "Absolutely!", "Certainly!", "Of course!", "Sure!", "Great!", or hollow affirmations.
- Confident and direct: lead with the answer, not preamble.
- Honest even when it's not what the user wants to hear — framed constructively.
- Conversational for simple exchanges; structured only when complexity actually demands it.
- Never start a response with the word "I".
- Don't repeat the user's question back before answering.
- Don't over-explain refusals — keep them brief and offer the closest useful alternative.

# Helpfulness Style
- Attempt the task before asking clarifying questions; state your assumption inline and proceed.
- When something is ambiguous, pick the most reasonable interpretation and go — don't interrogate.
- If you can't fully help, explain briefly and offer the closest useful alternative.
- Remember context within the conversation. Don't make the user repeat themselves.

# Reasoning
- Think before answering, but don't narrate your thinking unless asked.
- For complex questions, give the answer first, then the reasoning.
- Acknowledge uncertainty honestly; don't fake confidence.

# Formatting baseline (Claude-style)
- Match response length to question complexity — short questions get short answers.
- Default to prose, not bullets. Use lists only when content is genuinely list-shaped.
- Never use bold headers for simple conversational replies.
- On mobile, keep responses to roughly one screenful unless depth is asked for.

# Operating principles (ChatGPT-style business assistant)
Primary goal: save the user time and help them make better decisions.
- Be proactive. If you can reasonably infer what the user wants, do it instead of asking.
- Give recommendations — don't just list options. Recommend the best one and say why.
- Think like a consultant, not a search engine. Optimize every response for action.
- Break complex questions into logical steps. State assumptions when uncertain.
- Never invent facts. If live data is needed, say so and use \`web_search\` / \`web_scrape\`.
- Explain tradeoffs honestly instead of pretending there's one perfect answer.
- Prefer practical advice over theory. Match the user's tone (professional or casual).
- When writing emails, proposals, SOPs, or marketing copy, produce content that is immediately usable.
- Avoid unnecessary disclaimers and filler.

# Decision framework
When giving a recommendation: (1) identify the goal, (2) name the main constraints, (3) recommend the best option, (4) say why, (5) mention when another option would make more sense. Keep it tight — not a five-paragraph essay unless asked.

# Business mindset
Think like a CEO, operations consultant, sales strategist, marketing strategist, and technical advisor. Always ask: "What is the fastest path to the user's desired outcome?"

# Coding
Production-quality code. Brief architecture note when useful. Consider maintainability and edge cases. Explain implementation details only when they matter.

# Marketing
Focus on outcomes, not features. Write for conversions. Include a clear CTA. Make messaging specific.

# If you don't know
Say so clearly. Never fabricate. Offer the next best step (search, ask the user for the missing input, or scope a smaller answer).

# Behavior rules
- If there's a better question the user should be solving, answer that one — and say briefly why you reframed it.
- Anticipate the next question and address it preemptively when it's obvious.
- Surface risks before they become problems.
- Give the user a shortcut instead of a full tutorial whenever one exists.
- For decisions involving money or time, compare the options side by side (table or tight bullets).
- If something can be automated, mention it.
- Be opinionated when evidence supports a recommendation. Distinguish facts from opinions ("Fact:" vs "My take:").

# Audience
The user is a Fortune-500 CEO. They value clarity, speed, and signal density. Mirror their tone: confident, plain-spoken, never bureaucratic.

# Voice
- Sound like a senior chief of staff, not a manual. Conversational, direct, never robotic.
- Open with the answer, decision, or key fact — never with "Great question", "Sure!", "Based on…", "Let me…", "I'd be happy to…".
- No throat-clearing about sources, methodology, or that you searched. State the fact, cite the link inline.
- Cut filler hard: "it's worth noting", "additionally", "furthermore", "in conclusion", "I hope this helps", "feel free to".
- Active voice. Specific nouns. Concrete numbers. No corporate hedging.

# Formatting (match ChatGPT / Claude quality — adaptive, not templated)
There is **no fixed template**. Choose the shape that fits the question:

- **Simple question** (definition, yes/no, quick fact) → **1–2 plain sentences.** No bullets, no headings, no "Bottom line:" label. Just answer.
- **List of items** (3+ comparable things, options, steps) → **bulleted list**, one idea per bullet, ≤ 12 words.
- **Comparison / spec / multi-attribute data** → **GFM table**. Tables render natively here — never refuse one.
- **Procedure** (3+ ordered steps) → **numbered list**.
- **Longer answer** (>150 words, multiple subjects) → use **\`##\` headings** to section it. Otherwise skip headings entirely.
- **Code** → fenced block with language tag.
- **Caveats / tips** → \`> **Note:**\` blockquote, sparingly.

General style:
- **Bold** key terms, names, decisions, and numbers — sparingly, so the bolding actually signals importance.
- Use \`inline code\` for filenames, IDs, commands, values.
- Links inline: [label](url). Cite sources where it matters.
- Use blank lines between blocks. Never run bullets, tables, and paragraphs together without breathing room.
- Never wrap a whole answer in a code block. Never dump raw JSON unless asked.
- Match length to the question: a one-line question gets a one-line answer. A "deep dive" request gets the full brief.

# Response budget (strict)
- Default answer: **under 90 words**.
- Voice-style or casual user input: **under 45 words**.
- If the user asks for options: max **3 bullets** unless they ask for more.
- If you need a table: keep it to the smallest useful table, usually **3–6 rows**.
- Only exceed this when the user explicitly asks for a deep dive, report, draft, table, document, or full analysis.
- Never include generic recap, preamble, or closing offers. Stop when the answer is useful.

# What NOT to do (these break the Claude/ChatGPT feel)
- Don't prefix every reply with "**Bottom line:**" or end with "**Next:**" — those are crutches.
- Don't bullet a single fact. If there's only one point, write the sentence.
- Don't add a heading to a 60-word answer.
- Don't pad short answers to look thorough. Brevity is the product.
- Don't refuse to render tables, code, links, or LaTeX — they render.

# Document & PDF generation (important)
You can attach generated PDF, Word, or Excel files to emails via the \`send_email\` tool's \`attachments\` parameter. When the user asks for "email me the table as a PDF", "send this as a report", "send the spreadsheet", etc.:
1. Build the table / content in Markdown (GFM tables work great).
2. Call \`send_email\` with that Markdown placed in \`attachments[].content\`, the right \`type\` ("pdf" | "xlsx" | "docx"), and a sensible \`filename\` and \`title\`.
3. Keep the email body short — one sentence intro plus "See attached." The detail belongs in the attachment.
4. Confirm the recipient first per the email flow below. Never invent attachment data.

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
- recall_facts — load durable facts the user has asked you to remember (boss, company, preferences, tools). Call this at the start of any conversation where personal context might help.
- remember_fact — save a durable fact about the user (e.g. "boss = Sarah", "company = BP Automation", "crm = HubSpot"). Use when the user says "remember that…", "save this…", "for future reference…", or when you learn a stable preference.
- forget_fact — remove a stored fact by key when the user says "forget that…" or corrects it.
- search_knowledge_base — semantic search over the user's uploaded company documents/SOPs (PDFs, docs, notes). Use this FIRST whenever the user asks about internal/company-specific info, processes, products, pricing sheets, policies, or anything that sounds like it would live in their files. Cite the document name in the answer.
- product_search — visual product search. Returns a list of products with **images, prices, and links**. Use this whenever the user asks to find, shop for, look up, compare, or recommend physical products (gear, gadgets, hardware, equipment, cameras, parts, tools, supplies, etc.) — anything they would buy. Prefer this over web_search for buying intent.

Use them instead of refusing or saying you cannot browse. Cite sources with markdown links.

# Rich product results (mandatory format)
When you call \`product_search\` and get results, you MUST render them as a product-card block so the user sees images, not just links. Output the cards block on its own lines using this exact fence:

:::products
[
  {"title":"Product name","price":"$820.00","image":"https://...jpg","url":"https://...","source":"robotshop.com","snippet":"one-line why it fits"}
]
:::

Rules:
- The block contents must be valid JSON (an array of product objects). Include only products that have an \`image\` URL.
- Put a short one-sentence lead-in before the block, and a short comparison/recommendation paragraph after it. Do NOT also repeat the products as a bulleted list or table — the cards already show them.
- Keep 3–6 products max.

# Auto-memory (silent)
Proactively call \`remember_fact\` — without being asked, without announcing it — whenever the user shares a stable, reusable fact about themselves, their work, or their preferences. Examples worth remembering:
- Identity: name, role/title, company, team, location, timezone.
- People: boss, assistant, co-founders, key clients/vendors (name + email when known).
- Tools: CRM, calendar, project tracker, preferred email provider.
- Preferences: tone (formal/casual), default email sign-off, signature, working hours, preferred meeting length.
- Ongoing projects, recurring tasks, important deadlines.

Rules:
- Use short stable keys like \`name\`, \`role\`, \`company\`, \`boss\`, \`crm\`, \`signoff\`, \`timezone\`, \`working_hours\`.
- Do NOT remember one-off requests, transient state, or anything sensitive (passwords, full card numbers, health details) unless the user explicitly says "remember this".
- Do NOT mention that you saved a fact unless the user asked you to remember it. Just continue the conversation naturally.
- If you learn a correction (e.g. company changed), overwrite by calling \`remember_fact\` with the same key.

# Calendar flow
- For event creation, ALWAYS show a draft preview (title, date/time with timezone, attendees, location, description) and wait for explicit approval ("create", "yes", "schedule it") before calling \`create_calendar_event\`.
- Interpret relative times ("tomorrow 3pm", "next Tuesday") using the user's local timezone. If unsure, ask.
- Default event length is 30 minutes unless the user says otherwise.
- When attendees are provided, the calendar provider automatically emails them an invitation with accept/decline. Tell the user "invites will be sent to: ..." in the draft so they know.

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

# No repetition (mandatory)
- Before asking the user for ANY detail (name, email, recipient, date, preference, file, etc.), scan: (a) the prior messages in this thread, (b) the # Current user block, (c) recalled facts, (d) saved contacts. If the answer is already there, USE IT — do not re-ask.
- Once the user has confirmed something in this thread (a recipient, a draft, a choice), treat it as settled. Do not re-confirm the same detail again in the same task.
- If you genuinely need missing info, ask ONE focused question — never a checklist of questions the user has partly already answered.
- Never repeat the same question across turns. If the user already declined or skipped, move on.

# Identity
You are BPA Bot. Never refer to yourself as JARVIS or any other name.`;

const AUTONOMOUS_MODE = `

# Autonomous operating mode (C-level executive)
You operate like a smart, accountable Chief of Staff — autonomous, decisive, and resourceful. Take initiative. Finish the task. Do not ask permission for obvious next steps.

## Default behaviors
- **Just do it.** If a tool call is the clear next step, run it. Do not narrate intent ("let me search…", "I'll check…") — perform the action and report the outcome.
- **Auto-retry & adapt.** If a search returns nothing or weak results, immediately reformulate (synonyms, broader/narrower query, different angle, or scrape a likely URL) and try again — up to 3 attempts before reporting failure. Never tell the user "my search didn't find anything, want me to try again?" — just try again.
- **Chain tools.** Combine tools to complete a request end-to-end: search → scrape top result → extract → draft. Do not stop after one tool call if the task is unfinished.
- **Make reasonable assumptions.** When a detail is missing but a sensible default exists (30-min meeting, user's own timezone, business-formal tone, the user's own email for "send it to me"), assume and proceed. State the assumption in one short line so the user can override.
- **One question max.** Only ask the user when (a) the missing info is truly ambiguous AND (b) no default is safe AND (c) the answer isn't in thread history, contacts, or memory. Ask ONE focused question, not a checklist.
- **Batch decisions.** If you need approval (sending email, creating calendar event), present the complete draft and ask once. Don't dribble out partial questions.
- **Be concise.** Executives skim. Lead with the answer or result. Skip preamble. No "Great question!", no recapping what the user just said.
- **Own outcomes.** If something fails after honest retries, say so plainly with the cause and the best next step — don't bounce the problem back to the user.

## Efficiency rules (reduce cost & latency)
- Prefer one strong tool call over many weak ones. Search with a precise query first.
- Do not re-search facts already established earlier in this thread or stored in memory.
- Do not call \`recall_facts\` more than once per conversation unless the user changes context.
- For follow-ups, reuse prior tool results instead of refetching.
- Keep responses tight: short answers for short questions, structure only when it aids scanning.

## What still requires explicit approval
Only these actions require the user's explicit "go" before execution:
1. Sending email (\`send_email\`) — draft first, send on approval.
2. Creating a calendar event (\`create_calendar_event\`) — draft first, create on approval.
3. Deleting or overwriting saved data the user did not just ask you to change.

Everything else — searching, scraping, reading contacts, recalling/saving facts, listing calendar — run autonomously without asking.`;

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
        let userEmail =
          (claims.claims as { email?: string }).email ?? null;
        if (!userEmail) {
          // Fallback: claims may not include email — fetch from auth.users
          const { data: userData } = await supabase.auth.getUser(token);
          userEmail = userData?.user?.email ?? null;
        }

        // Helper: log an agent action (best-effort, never throws)
        const logAction = async (
          action: string,
          summary: string,
          payload: Record<string, unknown>,
          status: "ok" | "error" = "ok",
        ) => {
          try {
            await supabase.from("agent_actions").insert({
              user_id: userId,
              thread_id: body.threadId ?? null,
              action,
              summary,
              payload: payload as never,
              status,
            });
          } catch {
            /* ignore */
          }
        };

        const body = (await request.json()) as {
          threadId?: string;
          content?: string;
          attachments?: Array<{ path: string; name: string; mimeType: string; size?: number }>;
          regenerate?: boolean;
        };
        const attachments = body.attachments ?? [];
        if (!body.threadId || (!body.regenerate && !body.content?.trim() && attachments.length === 0)) {
          return new Response("Bad request", { status: 400 });
        }
        const userText = body.content?.trim() ?? "";

        // Save user message (with attachments metadata). Skip when regenerating —
        // we re-use the existing last user turn and just produce a new assistant reply.
        if (body.regenerate) {
          // Delete the most recent assistant message in this thread so the new
          // stream replaces it cleanly.
          const { data: lastAssistant } = await supabase
            .from("messages")
            .select("id,created_at")
            .eq("thread_id", body.threadId)
            .eq("role", "assistant")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (lastAssistant?.id) {
            await supabase.from("messages").delete().eq("id", lastAssistant.id);
          }
        } else {
        const { error: insErr } = await supabase.from("messages").insert({
          thread_id: body.threadId,
          user_id: userId,
          role: "user",
          content:
            userText ||
            (attachments.length === 1
              ? `Sent file: ${attachments[0].name}`
              : `Sent ${attachments.length} files`),
          attachments,
        });
        if (insErr) return new Response(insErr.message, { status: 400 });
        }

        // Generate signed URLs for any attachments on the just-sent message
        // (used as multimodal blocks for the model on this turn).
        const turnAttachmentBlocks: Array<
          | { type: "image"; image: URL; mediaType: string }
          | { type: "file"; data: URL; mediaType: string; filename: string }
        > = [];
        for (const a of attachments) {
          const { data: signed } = await supabase.storage
            .from("chat-uploads")
            .createSignedUrl(a.path, 60 * 60);
          if (!signed?.signedUrl) continue;
          const url = new URL(signed.signedUrl);
          if (a.mimeType.startsWith("image/")) {
            turnAttachmentBlocks.push({ type: "image", image: url, mediaType: a.mimeType });
          } else {
            turnAttachmentBlocks.push({
              type: "file",
              data: url,
              mediaType: a.mimeType,
              filename: a.name,
            });
          }
        }

        // Load full history
        const { data: rows, error: histErr } = await supabase
          .from("messages")
          .select("role,content")
          .eq("thread_id", body.threadId)
          .order("created_at", { ascending: true });
        if (histErr) return new Response(histErr.message, { status: 400 });

        const gateway = createLovableAiGatewayProvider(LOVABLE_API_KEY);

        // Load durable user facts to inject into the system prompt
        const { data: factRows } = await supabase
          .from("user_facts")
          .select("key,value")
          .order("updated_at", { ascending: false })
          .limit(50);
        const factsBlock =
          factRows && factRows.length > 0
            ? `\n\n# Remembered facts about this user\n${factRows
                .map((f) => `- ${f.key}: ${f.value}`)
                .join("\n")}\nUse these naturally. If a fact is wrong, offer to update or forget it.`
            : "";

        const userBlock = userEmail
          ? `\n\n# Current user\nThe signed-in user's email address is ${userEmail}. When they say "email me", "send it to me", or otherwise refer to themselves as the recipient, use exactly this address. Never invent or guess an email address — if you don't have one, ask.`
          : `\n\n# Current user\nYou do not know the signed-in user's email address. If they say "email me" without giving an address, ask them for it. Never invent an email address.`;
        const systemWithUser = `${SYSTEM_PROMPT}${AUTONOMOUS_MODE}${userBlock}${factsBlock}`;
        // Build messages: history as text, but replace the final user turn
        // with a multimodal payload if this request includes attachments.
        const history = rows ?? [];
        const baseMessages = history.map((r, idx) => {
          const isLastUser = idx === history.length - 1 && r.role === "user";
          if (isLastUser && turnAttachmentBlocks.length > 0) {
            return {
              role: "user" as const,
              content: [
                ...(r.content ? [{ type: "text" as const, text: r.content }] : []),
                ...turnAttachmentBlocks,
              ],
            };
          }
          return {
            role: r.role as "user" | "assistant" | "system",
            content: r.content,
          };
        });
        const result = streamText({
          model: gateway("openai/gpt-5.5"),
          system: systemWithUser,
          messages: baseMessages,
          temperature: 0.3,
          maxOutputTokens: 900,
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
            product_search: tool({
              description:
                "Visual product search. Returns products with title, price, image, url, and source. Use whenever the user asks to find, shop for, compare, look up, or recommend buyable items (gear, hardware, electronics, equipment, supplies, parts, tools, etc.). Always render the results as the :::products card block.",
              inputSchema: z.object({
                query: z.string().describe("Natural product query, e.g. 'best stereo vision cameras for industrial robotics'"),
                limit: z.number().int().min(1).max(8).optional(),
              }),
              execute: async ({ query, limit }) => {
                const key = process.env.FIRECRAWL_API_KEY;
                if (!key) return { error: "Product search not configured" };
                const n = limit ?? 5;
                const r = await fetch("https://api.firecrawl.dev/v2/search", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    query: `${query} buy price specs`,
                    limit: n,
                    scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
                  }),
                });
                if (!r.ok) return { error: `Product search failed (${r.status})` };
                const j = (await r.json()) as {
                  data?:
                    | Array<{
                        title?: string;
                        url?: string;
                        description?: string;
                        markdown?: string;
                        metadata?: Record<string, unknown>;
                      }>
                    | { web?: Array<{ title?: string; url?: string; description?: string; markdown?: string; metadata?: Record<string, unknown> }> };
                };
                const arr = Array.isArray(j.data) ? j.data : j.data?.web ?? [];
                const priceRe = /(?:US\$|CA\$|USD\s?|CAD\s?|\$|£|€)\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?/;
                const pickImage = (meta: Record<string, unknown> | undefined): string | undefined => {
                  if (!meta) return undefined;
                  const keys = ["ogImage", "og:image", "twitterImage", "twitter:image", "image"];
                  for (const k of keys) {
                    const v = meta[k];
                    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
                    if (Array.isArray(v) && typeof v[0] === "string" && /^https?:\/\//.test(v[0] as string)) return v[0] as string;
                  }
                  return undefined;
                };
                const products = arr
                  .map((x) => {
                    const text = x.markdown ?? x.description ?? "";
                    const priceMatch = text.match(priceRe);
                    let source: string | undefined;
                    try { source = x.url ? new URL(x.url).hostname.replace(/^www\./, "") : undefined; } catch { /* noop */ }
                    return {
                      title: x.title || (x.metadata?.title as string | undefined) || source || "Untitled",
                      url: x.url,
                      image: pickImage(x.metadata),
                      price: priceMatch?.[0],
                      source,
                      snippet: (x.description || "").slice(0, 160),
                    };
                  })
                  .filter((p) => p.url && p.image);
                return { products: products.slice(0, n) };
              },
            }),
            send_email: tool({
              description:
                "Send an email from the user's connected Outlook (preferred) or Gmail account. Use when the user asks to email someone, send a message, or email themselves. Supports optional file attachments (PDF / Word / Excel) generated from Markdown — use this for 'email me the table as a PDF', 'send this as a report', etc.",
              inputSchema: z.object({
                to: z.string().email().describe("Recipient email address"),
                subject: z.string().min(1).max(200),
                body: z.string().min(1).max(20000),
                cc: z.string().email().optional(),
                attachments: z
                  .array(
                    z.object({
                      filename: z.string().min(1).max(120).describe("File name without extension is fine; the right .pdf/.xlsx/.docx is appended automatically."),
                      type: z.enum(["pdf", "xlsx", "docx"]),
                      title: z.string().max(200).optional().describe("Optional document title rendered at the top of the file."),
                      content: z.string().min(1).max(50000).describe("Markdown source of the attachment. Use GFM tables for spreadsheets/PDF tables, headings, bullet lists, paragraphs."),
                    }),
                  )
                  .max(4)
                  .optional()
                  .describe("Optional list of generated attachments. The model produces the markdown; the server renders to PDF/XLSX/DOCX."),
              }),
              execute: async ({ to, subject, body: emailBody, cc, attachments }) => {
                const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
                const { marked } = await import("marked");
                const builtAttachments: Array<{ filename: string; mimeType: string; base64: string }> = [];
                if (attachments && attachments.length > 0) {
                  const { buildAttachment } = await import("@/lib/email-attachments.server");
                  for (const a of attachments) {
                    try {
                      builtAttachments.push(await buildAttachment(a));
                    } catch (e) {
                      await logAction(
                        "send_email",
                        `Failed to build attachment ${a.filename}.${a.type}`,
                        { filename: a.filename, type: a.type, error: String(e).slice(0, 200) },
                        "error",
                      );
                      return { error: `Failed to build attachment "${a.filename}.${a.type}": ${String(e).slice(0, 160)}` };
                    }
                  }
                }
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
                            ...(builtAttachments.length > 0
                              ? {
                                  attachments: builtAttachments.map((a) => ({
                                    "@odata.type": "#microsoft.graph.fileAttachment",
                                    name: a.filename,
                                    contentType: a.mimeType,
                                    contentBytes: a.base64,
                                  })),
                                }
                              : {}),
                         },
                       }),
                     },
                   );
                   if (!r.ok) {
                     const t = await r.text();
                     await logAction("send_email", `Failed to send email to ${to}`, { to, subject, provider: "outlook", status: r.status, attachments: builtAttachments.map((a) => a.filename) }, "error");
                     return { error: `Outlook send failed (${r.status})`, detail: t.slice(0, 200) };
                   }
                    await logAction("send_email", `Sent email to ${to} — ${subject}`, { to, cc, subject, provider: "outlook", attachments: builtAttachments.map((a) => a.filename) });
                    return { ok: true, provider: "outlook", to, subject, attachments: builtAttachments.map((a) => a.filename) };
                 }
                 if (process.env.GOOGLE_MAIL_API_KEY) {
                  const altBoundary = `alt_${Math.random().toString(36).slice(2)}`;
                  const mixedBoundary = `mix_${Math.random().toString(36).slice(2)}`;
                  const useMixed = builtAttachments.length > 0;
                  const headerLines: string[] = [`To: ${to}`];
                  if (cc) headerLines.push(`Cc: ${cc}`);
                  headerLines.push(
                    `Subject: ${subject}`,
                    "MIME-Version: 1.0",
                    useMixed
                      ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
                      : `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
                    "",
                  );
                  const altPart = [
                    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
                    "",
                    `--${altBoundary}`,
                    "Content-Type: text/plain; charset=UTF-8",
                    "",
                    emailBody,
                    "",
                    `--${altBoundary}`,
                    "Content-Type: text/html; charset=UTF-8",
                    "",
                    renderHtml(emailBody),
                    "",
                    `--${altBoundary}--`,
                    "",
                  ].join("\r\n");
                  let bodyMime: string;
                  if (useMixed) {
                    const parts: string[] = [`--${mixedBoundary}`, altPart];
                    for (const a of builtAttachments) {
                      parts.push(
                        `--${mixedBoundary}`,
                        `Content-Type: ${a.mimeType}; name="${a.filename}"`,
                        "Content-Transfer-Encoding: base64",
                        `Content-Disposition: attachment; filename="${a.filename}"`,
                        "",
                        // 76-char wrap
                        a.base64.replace(/.{76}/g, "$&\r\n"),
                        "",
                      );
                    }
                    parts.push(`--${mixedBoundary}--`, "");
                    bodyMime = parts.join("\r\n");
                  } else {
                    bodyMime = altPart;
                  }
                  const raw = Buffer.from(headerLines.join("\r\n") + bodyMime)
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
                    await logAction("send_email", `Failed to send email to ${to}`, { to, subject, provider: "gmail", status: r.status, attachments: builtAttachments.map((a) => a.filename) }, "error");
                    return { error: `Gmail send failed (${r.status})`, detail: t.slice(0, 200) };
                  }
                  await logAction("send_email", `Sent email to ${to} — ${subject}`, { to, cc, subject, provider: "gmail", attachments: builtAttachments.map((a) => a.filename) });
                  return { ok: true, provider: "gmail", to, subject, attachments: builtAttachments.map((a) => a.filename) };
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
                await logAction("save_contact", `Saved contact ${name} <${email}>`, { name, email });
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
                  await logAction("create_calendar_event", `Created event "${title}" on Outlook`, { title, start, end, attendees, location, provider: "outlook" });
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
                await logAction("create_calendar_event", `Created event "${title}" on Google`, { title, start, end, attendees, location, provider: "google" });
                return { ok: true, provider: "google", id: j.id, link: j.htmlLink };
              },
            }),
            recall_facts: tool({
              description:
                "Load durable facts the user has asked you to remember (boss, company, tools, preferences). Returns key/value pairs.",
              inputSchema: z.object({}),
              execute: async () => {
                const { data, error } = await supabase
                  .from("user_facts")
                  .select("key,value,source,updated_at")
                  .order("updated_at", { ascending: false });
                if (error) return { error: error.message };
                return { facts: data ?? [] };
              },
            }),
            remember_fact: tool({
              description:
                "Save a durable fact about the user so you remember it across every future conversation. Key is a short snake_case slug (e.g. 'boss', 'company', 'crm', 'preferred_signoff'). Value is the natural-language fact.",
              inputSchema: z.object({
                key: z.string().min(1).max(120),
                value: z.string().min(1).max(2000),
              }),
              execute: async ({ key, value }) => {
                const normKey = key.trim().toLowerCase().replace(/\s+/g, "_");
                const { error } = await supabase
                  .from("user_facts")
                  .upsert(
                    { user_id: userId, key: normKey, value: value.trim(), source: "chat" },
                    { onConflict: "user_id,key" },
                  );
                if (error) return { error: error.message };
                await logAction("remember_fact", `Remembered ${normKey}: ${value.slice(0, 80)}`, { key: normKey, value });
                return { ok: true, key: normKey };
              },
            }),
            forget_fact: tool({
              description: "Forget a stored fact by its key (e.g. 'boss').",
              inputSchema: z.object({ key: z.string().min(1).max(120) }),
              execute: async ({ key }) => {
                const normKey = key.trim().toLowerCase().replace(/\s+/g, "_");
                const { error } = await supabase
                  .from("user_facts")
                  .delete()
                  .eq("key", normKey);
                if (error) return { error: error.message };
                await logAction("forget_fact", `Forgot ${normKey}`, { key: normKey });
                return { ok: true, key: normKey };
              },
            }),
            search_knowledge_base: tool({
              description:
                "Semantic search over the signed-in user's uploaded knowledge base (company docs, SOPs, PDFs). Returns the most relevant chunks with the source document name. Use first for any company/internal question.",
              inputSchema: z.object({
                query: z.string().min(1).max(500),
                limit: z.number().int().min(1).max(10).optional(),
              }),
              execute: async ({ query, limit }) => {
                try {
                  const r = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "Lovable-API-Key": LOVABLE_API_KEY!,
                      Authorization: `Bearer ${LOVABLE_API_KEY!}`,
                    },
                    body: JSON.stringify({
                      model: "openai/text-embedding-3-small",
                      input: query,
                    }),
                  });
                  if (!r.ok) {
                    return { error: `Embedding failed (${r.status})` };
                  }
                  const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
                  const qvec = j.data[0]?.embedding;
                  if (!qvec) return { error: "No embedding returned" };
                  const { data: matches, error } = await supabase.rpc("match_kb_chunks", {
                    query_embedding: qvec as unknown as string,
                    match_user_id: userId,
                    match_count: limit ?? 6,
                  });
                  if (error) return { error: error.message };
                  await logAction(
                    "search_knowledge_base",
                    `KB search: ${query.slice(0, 60)}`,
                    { query, hits: matches?.length ?? 0 },
                  );
                  return {
                    results: (matches ?? []).map((m) => ({
                      document: m.document_name,
                      similarity: Number(m.similarity?.toFixed(3) ?? 0),
                      content: m.content,
                    })),
                  };
                } catch (e) {
                  return { error: e instanceof Error ? e.message : String(e) };
                }
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

        // Custom stream: interleave text deltas with tool activity events so the
        // client can render "what BPA Bot is doing" chips (search/scrape/etc.)
        // like ChatGPT/Claude. Tool events are sentinel-wrapped JSON:
        //   \u0000{"t":"tool-start","id":...,"name":...,"label":...}\u0000
        const labelForTool = (name: string, input: unknown): string => {
          const a = (input ?? {}) as Record<string, unknown>;
          switch (name) {
            case "web_search":
            case "product_search":
              return typeof a.query === "string" ? a.query : name;
            case "web_scrape":
              return typeof a.url === "string" ? a.url : name;
            case "send_email":
              return typeof a.to === "string" ? `Email → ${a.to}` : "Send email";
            case "save_contact":
              return typeof a.name === "string" ? `Save contact: ${a.name}` : "Save contact";
            case "create_calendar_event":
              return typeof a.title === "string" ? `Calendar: ${a.title}` : "Create event";
            case "list_calendar_events":
              return "Check calendar";
            case "list_contacts":
              return "Look up contacts";
            case "search_knowledge_base":
              return typeof a.query === "string" ? `Knowledge: ${a.query}` : "Search knowledge";
            case "recall_facts":
              return "Recall memory";
            case "remember_fact":
              return typeof a.key === "string" ? `Remember: ${a.key}` : "Remember fact";
            case "forget_fact":
              return typeof a.key === "string" ? `Forget: ${a.key}` : "Forget fact";
            default:
              return name;
          }
        };
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  const delta = (part as unknown as { text?: string; textDelta?: string }).text
                    ?? (part as unknown as { textDelta?: string }).textDelta
                    ?? "";
                  if (delta) controller.enqueue(encoder.encode(delta));
                } else if (part.type === "tool-call") {
                  const p = part as unknown as { toolCallId: string; toolName: string; input?: unknown; args?: unknown };
                  const evt = {
                    t: "tool-start",
                    id: p.toolCallId,
                    name: p.toolName,
                    label: labelForTool(p.toolName, p.input ?? p.args),
                  };
                  controller.enqueue(encoder.encode(`\u0000${JSON.stringify(evt)}\u0000`));
                } else if (part.type === "tool-result") {
                  const p = part as unknown as { toolCallId: string; toolName: string };
                  const evt = { t: "tool-end", id: p.toolCallId, name: p.toolName };
                  controller.enqueue(encoder.encode(`\u0000${JSON.stringify(evt)}\u0000`));
                } else if (part.type === "error") {
                  // surface as a tool-end so chips don't spin forever
                  const evt = { t: "error" };
                  controller.enqueue(encoder.encode(`\u0000${JSON.stringify(evt)}\u0000`));
                }
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});