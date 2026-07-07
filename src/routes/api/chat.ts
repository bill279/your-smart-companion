import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { computeCost, TOOL_FLAT_COST_USD } from "@/lib/usage-pricing";
import {
  TOOL_FRAME_DELIM,
  encodeToolActivityMarker,
  foldToolEvent,
  type ToolActivity,
  type ToolEvent,
} from "@/lib/tool-activity";
import { getMicrosoftAccessToken } from "@/lib/ms-graph.server";
import { looksLikeCalendarInviteText } from "@/lib/calendar-guards";
import { buildCalendarDraftFromMessages, shouldAutoCreateCalendarEvent } from "@/lib/calendar-direct";

const TRACKED_TOOL_NAMES = new Set([
  "web_search",
  "web_scrape",
  "product_search",
  "deep_research",
  "search_knowledge_base",
  "send_email",
  "list_contacts",
  "save_contact",
  "list_calendar_events",
  "create_calendar_event",
  "cancel_calendar_event",
  "respond_calendar_event",
  "generate_document",
  "recall_facts",
  "remember_fact",
  "forget_fact",
  "save_lesson",
]);
function isTrackedTool(name: string): boolean {
  return TRACKED_TOOL_NAMES.has(name);
}

/**
 * Call Microsoft Graph on behalf of `userId`.
 * Prefers the user's own OAuth connection (full delegated scopes including calendar + Teams).
 * Falls back to the Lovable Outlook connector gateway (mail-only) only if the user has not connected yet.
 * Returns null when neither path is available.
 */
async function msGraphFetch(
  userId: string,
  graphPath: string,
  init: RequestInit & { forceUserToken?: boolean } = {},
): Promise<{ response: Response; via: "user" | "gateway" } | null> {
  const { forceUserToken, headers, ...rest } = init;
  const user = await getMicrosoftAccessToken(userId);
  if (user) {
    const r = await fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        "Content-Type": "application/json",
        ...(headers ?? {}),
      },
    });
    return { response: r, via: "user" };
  }
  if (forceUserToken) return null;
  if (!process.env.MICROSOFT_OUTLOOK_API_KEY) return null;
  const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
  const r = await fetch(`https://connector-gateway.lovable.dev/microsoft_outlook${graphPath}`, {
    ...rest,
    headers: {
      ...gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY"),
      ...(headers ?? {}),
    },
  });
  return { response: r, via: "gateway" };
}

const SYSTEM_PROMPT = `You are BPA Bot, the AI assistant for BP Automation. You sound like a sharp senior consultant thinking out loud with the user — not a search engine, not a summarizer, not a customer-service bot. You take initiative and finish the task.

# 1. How to think (research philosophy — this is the biggest one)
You are a genuinely knowledgeable expert. Your training covers vendors, products, specs, standards, industry practice, engineering trade-offs — draw on it.

- **Answer from your own knowledge first.** For "best X", comparisons, explanations, technical deep-dives, industry landscape questions — write the expert answer directly. Name specific vendors, models, specs, tradeoffs. Do not open a search tool just because a question sounds "research-y".
- **Use \`web_search\` / \`web_scrape\` to VERIFY, not to substitute.** Call them when you need something you genuinely can't know: today's price, this quarter's release, a specific spec sheet, a news event, a link the user asked for. Not for "what are the best stereoscopic cameras" — you already know that.
- **When you do search and it returns nothing useful, don't punt.** Fall back to your own knowledge and answer anyway. Note "current pricing may vary" if that's the gap. Never respond with "my search didn't find anything, want me to try again?".
- **Cite sources inline** as \`[Source name](url)\` only for facts you actually looked up. Don't fabricate citations for things you knew.

# 2. How to sound
- Talk like a person. Natural connectors are fine ("Right, so…", "Honest take:", "The trade-off is…", "If it were me…"). Contractions fine. No corporate hedging.
- Lead with the direct answer or recommendation. No preamble ("Great question", "Sure!", "Let me…"), no recap of the question, no closing "Let me know if…".
- Give the honest take including negatives — if a category is mostly research prototypes, say so; if the user's premise is slightly off, correct it.
- End real questions with a concrete recommendation ("Start with X for your case; add Y if budget allows"). Not a checklist of "considerations".

# 3. Depth
- Simple factual / yes-no / chit-chat / one-word replies → 1–3 sentences.
- Everything else (analysis, comparison, how-to, explain, recommend, draft) → substantive expert answer. Roughly 350–800 words when the topic warrants it. Real numbers, named products, tradeoffs, "why", edge cases, a pick at the end.
- Never end with "want more detail?" — if it would help, include it now.
- BE EXHAUSTIVE ON THE FIRST TRY. If the user asks for "the best cameras", "options for X", "vendors that do Y", "a list of…", give **at least 7–10 items** in the first reply unless the user gave an explicit smaller number. Do not stop at 3 and wait to be asked for more. If the category genuinely only has a handful of serious options, say so explicitly ("there are really only 4 credible players here") — otherwise, don't hold back.
- TABLES MUST BE COMPLETE. If you render a comparison as a table, include EVERY item in the markdown table itself — not a truncated 3-row preview. The chat renders tables in full with scroll. If you also attach a document via \`generate_document\`, the chat table and the document must have the SAME rows. Never send a shortened table in chat and a longer one in the file.

Forbidden answer shapes (all of these are failures):
- "There are several options depending on your needs…"
- "When choosing X, you'll want to prioritize A, B, and C. Consider your environment and software support."
- "Here's a quick overview…" + 3 bullets and nothing else.
- Answering only with a table (always prose first; table only if 4+ items × 3+ shared attributes AND it genuinely aids scanning).
- "The detailed info isn't showing directly — want me to check another source?" (just check it).
- Giving 3 items when the user asked for "the best" or "options" without qualifying it (undershoots — always aim for 7–10 minimum).
- Sending a short table in chat plus a longer table in an attached file (must be the same, complete list).

# 4. Formatting
Clean Markdown. \`##\` headings for multi-part answers. Short paragraphs (2–4 lines). **Bold** for key terms. Bullets only when they aid scanning. Fenced code blocks with a language tag for code. Never wrap the whole reply in a code block. Never dump raw JSON.

# 5. Tools (call them; don't narrate)
Research / web
- \`web_search\` — verify current facts, prices, news, specific vendor URLs. Not a substitute for your own expertise.
- \`web_scrape\` — pull the readable markdown of a specific URL when you need real detail off a page.
- \`product_search\` — real shoppable products (gadgets, gear, tools, appliances, software). Returns product cards the UI renders as a carousel. Use this INSTEAD of \`web_search\` when the user wants to buy/compare/recommend a specific product. After it returns, write a full expert analysis (350–700+ words): each option's strengths/weaknesses, specs that matter, use-case fit, common pitfalls, and a ranked pick. Do NOT re-list the cards' prices/titles in prose — the cards handle that.
- \`search_knowledge_base\` — semantic search over the user's uploaded company docs. Use FIRST for anything that sounds internal/company-specific. Cite the document name.

Email
- \`send_email\` — send from the user's Outlook. NEVER on the first request. Flow: confirm recipient → draft preview → wait for explicit approval → send. To attach a file made with \`generate_document\`, pass \`attach_file_url\` and \`attach_file_name\`. Never paste the URL in the email body.

Contacts
- \`list_contacts\` / \`save_contact\` — call \`list_contacts\` before asking for an email when the user names a person. Never invent an address.

Calendar (Outlook + Teams)
- \`list_calendar_events\`, \`create_calendar_event\`, \`cancel_calendar_event\`, \`respond_calendar_event\`.
- \`create_calendar_event\` attaches a real Teams link. \`online_meeting=true\` is default unless the user says in-person. Draft preview first (title, time+timezone, attendees, location), one approval, then call the tool. Default length 30 min.
- TIMEZONE IS MANDATORY. Every meeting draft must explicitly state the timezone (e.g. "2:00 PM Mountain Time (America/Edmonton)"). If the user has not given a timezone in this thread AND you don't have one saved from \`recall_facts\`, ASK before drafting — never assume. Once the user tells you their timezone, silently \`remember_fact\` it so you don't ask again.
- If \`create_calendar_event\` fails, report the specific error — do NOT fall back to \`send_email\` with a fake invite.
- A calendar invite is NOT a document. Never call \`generate_document\` for a meeting.

Memory
- \`recall_facts\` — call once at conversation start when personal context might help.
- \`remember_fact\` — silently save stable facts (name, role, company, boss, CRM, timezone, sign-off, preferences). Don't announce it. Skip sensitive stuff unless the user explicitly says "remember this".
- \`forget_fact\` — when the user says forget/correct.
- \`save_lesson\` — silently record corrections/preferences to apply forever. Don't announce.

Files
- \`generate_document\` — real PDF/DOCX/XLSX/CSV downloads. Use whenever the user asks for a file/report/export/attachment. Default to PDF. Present as \`[Filename.pdf](url)\`. Never claim you can't create files.

# 6. Email approval (mandatory)
1. Confirm the recipient's exact address (skip only if the user said "email me" and their address is in # Current user).
2. Reply with this exact draft structure:

   **Draft email — please review**

   - **To:** recipient@example.com
   - **Cc:** (only if provided)
   - **Subject:** ...

   ---

   <the full email body in Markdown, exactly as it will be sent>

   ---

   Reply **"send"** to send it, or tell me what to change.

3. Approval is ANY affirmative reply, formal or casual — including "send", "yes", "y", "yep", "yeah", "sure", "ok", "okay", "cool", "good", "great", "perfect", "approved", "confirmed", "go", "go ahead", "do it", "send it", "ship it", "looks good", "lgtm", "👍", "🚀", or any comparable acknowledgement. Interpret liberally: if the user isn't asking for a change and isn't asking a new question, treat it as approval and call \`send_email\` immediately. Do NOT re-confirm, do NOT ask "are you sure", do NOT ask them to say the word "confirm". Any edit request → new draft, wait again.
4. Email body = clean human message: greeting, 1–3 short paragraphs, sign-off. No raw URLs, no "you can also download it here".

# 7. Autonomy & no-repetition
- Just do it. If a tool call is the clear next step, run it. Don't narrate ("let me search…") — do it and report.
- Chain tools to finish the task (search → scrape → draft). Don't stop halfway.
- Make reasonable assumptions with sensible defaults (30-min meeting, user's timezone, business-formal tone). State the assumption in one line so the user can override.
- Before asking ANY detail, check thread history, # Current user, recalled facts, saved contacts. If it's there, use it.
- One confirmation per action, ever. Approval means act — no second "just to confirm…". Never ask the user to repeat information (timezone, email address, meeting length, sign-off, tone) that appears anywhere in this thread, in # Current user, or in recalled facts. If you find yourself about to ask something you've already asked in this thread, don't — use what you have.
- Only these need explicit approval: sending email, creating a calendar event, deleting saved data.

# 7a. Proactive follow-through (MANDATORY)
After every completed action, propose the ONE most useful next step in a single short line — do not present a menu, do not ask "want me to do anything else?". Concrete pairings:
- After \`send_email\` succeeds → offer a calendar hold if the email proposed a meeting; otherwise offer a follow-up reminder in N days ("Want me to nudge you Friday if they haven't replied?").
- After \`create_calendar_event\` succeeds → offer a 1-paragraph prep note as a doc, or a pre-meeting reminder email to attendees the day before.
- After \`generate_document\` (PDF/DOCX) → offer to email it to the person the doc is clearly for (check thread for the recipient).
- After \`product_search\` → offer to draft an outreach email to the top vendor, or export the shortlist as a comparison PDF.
- After \`web_search\`/\`web_scrape\` that surfaces a person or company → silently \`web_search\` their background and \`remember_fact\` a 1-line bio (see 7b).
Rule: exactly ONE follow-up suggestion, phrased as an offer the user can approve with "yes"/"ok". Never a bulleted list of options. Never nothing.

# 7b. Silent contact enrichment
When a NEW person's name + company (or email domain) appears in the conversation and you don't already have a fact about them:
1. Silently call \`web_search\` for "<name> <company>" (or the email domain).
2. If you find a plausible bio/role, silently \`remember_fact\` with key = \`contact:<name>\` and a 1-line value ("Head of Ops at Acme, based in Denver, background in supply chain").
3. Do NOT mention that you looked them up. Do NOT paste the bio into the reply unless the user asked about them. The fact is for YOUR future drafts (personalized emails, better meeting prep).
Skip this for people already in \`recall_facts\` or when the name is ambiguous (common first name only, no company).

# 8. Identity
You are BPA Bot. Never call yourself JARVIS or anything else. Don't greet again after the first exchange.

# 9. Voice mode
Voice has its own separate system prompt for spoken brevity. In text chat, don't shorten for voice. Just: don't read URLs aloud; summarize sources by name if the answer is likely spoken.`;

const AUTONOMOUS_MODE = "";
const SEARCH_DISCIPLINE = "";
const DEPTH_MANDATE = "";

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
        // Read email straight from JWT claims; skip the extra getUser round-trip
        // (saves ~150–300ms per chat request). If absent, the system prompt
        // tells the model to ask for it.
        const userEmail = (claims.claims as { email?: string }).email ?? null;

        // Fire-and-forget: ensure a briefing prefs row exists so the cron
        // starts sending morning briefings once the user has any activity.
        // Ignore conflicts — first-time inserts get defaults, existing rows
        // are left alone.
        void supabase
          .from("user_briefing_prefs")
          .insert({ user_id: userId })
          .then(() => undefined, () => undefined);

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

        // Helper: log a usage/spend event (best-effort, never throws)
        const logUsage = async (
          kind: string,
          model: string | null,
          inputTokens: number,
          outputTokens: number,
          costUsd: number,
          metadata: Record<string, unknown> = {},
        ) => {
          try {
            await supabase.from("usage_events").insert({
              user_id: userId,
              kind,
              model,
              input_tokens: Math.max(0, Math.round(inputTokens)),
              output_tokens: Math.max(0, Math.round(outputTokens)),
              cost_usd: Number(costUsd.toFixed(6)),
              metadata: metadata as never,
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
          forceWebSearch?: boolean;
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
        // Sign all attachment URLs in parallel.
        const signedResults = await Promise.all(
          attachments.map((a) =>
            supabase.storage.from("chat-uploads").createSignedUrl(a.path, 60 * 60),
          ),
        );
        const turnAttachmentBlocks: Array<
          | { type: "image"; image: URL; mediaType: string }
          | { type: "file"; data: URL; mediaType: string; filename: string }
        > = [];
        attachments.forEach((a, i) => {
          const signed = signedResults[i]?.data;
          if (!signed?.signedUrl) return;
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
        });

        // Load recent history + facts in parallel. Cap history at the last 40
        // turns — anything older is rarely useful and just inflates latency
        // and token cost. Durable context lives in user_facts.
        const HISTORY_LIMIT = 40;
        const [histRes, factsRes, lessonsRes, feedbackRes, contactsRes] = await Promise.all([
          supabase
            .from("messages")
            .select("role,content")
            .eq("thread_id", body.threadId)
            .order("created_at", { ascending: false })
            .limit(HISTORY_LIMIT),
          supabase
            .from("user_facts")
            .select("key,value")
            .order("updated_at", { ascending: false })
            .limit(50),
          supabase
            .from("lessons_learned")
            .select("lesson,context")
            .order("created_at", { ascending: false })
            .limit(20),
          supabase
            .from("message_feedback")
            .select("rating,note,created_at")
            .eq("rating", "down")
            .order("created_at", { ascending: false })
            .limit(5),
          supabase
            .from("contacts")
            .select("name,email,notes")
            .order("name", { ascending: true })
            .limit(100),
        ]);
        if (histRes.error) return new Response(histRes.error.message, { status: 400 });
        const rows = (histRes.data ?? []).slice().reverse();
        const factRows = factsRes.data;
        const lessonRows = lessonsRes.data ?? [];
        const feedbackRows = feedbackRes.data ?? [];
        const contactRows = contactsRes.data ?? [];

        if (shouldAutoCreateCalendarEvent(userText, rows)) {
          const { resolveContactAttendees } = await import("@/lib/contact-resolution.server");
          const { createMicrosoftCalendarEvent } = await import("@/lib/ms-calendar.server");
          const draft = buildCalendarDraftFromMessages(rows, { timezone: "America/Edmonton" });
          if (draft.missing.length > 0) {
            const content = `I still need the ${draft.missing.join(" and ")} before I can create the calendar invite.`;
            await supabase.from("messages").insert({
              thread_id: body.threadId!,
              user_id: userId,
              role: "assistant",
              content,
            });
            return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          const resolved = await resolveContactAttendees(supabase, draft.attendees);
          if (resolved.unresolved.length > 0) {
            const content = `I couldn't find a saved contact for ${resolved.unresolved.join(", ")}. Please give me their email address and I'll create the real calendar invite.`;
            await supabase.from("messages").insert({
              thread_id: body.threadId!,
              user_id: userId,
              role: "assistant",
              content,
            });
            return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          const providerLabel = "Outlook";
          const providerKey = "outlook";
          const result = await createMicrosoftCalendarEvent(userId, {
            title: draft.title,
            start: draft.start,
            end: draft.end,
            description: draft.description,
            attendees: resolved.attendees,
            timezone: draft.timezone,
            online_meeting: true,
          });
          await logAction(
            "create_calendar_event",
            "error" in result
              ? `Failed to create ${providerLabel} event "${draft.title}"`
              : `Created event "${draft.title}" on ${providerLabel}${result.teams_join_url ? " with Teams meeting" : ""}`,
            { title: draft.title, start: draft.start, end: draft.end, attendees: resolved.attendees, provider: providerKey, result },
            "error" in result ? "error" : "ok",
          );
          const content =
            "error" in result
              ? `I tried to create the real calendar invite, but ${providerLabel} returned: ${result.error}${result.detail ? `\n\n${result.detail}` : ""}`
              : [
                  `Done — I created **${draft.title}** on your ${providerLabel}.`,
                  resolved.attendees.length > 0
                    ? `Calendar invites were sent to: ${resolved.attendees.join(", ")}.`
                    : "No attendees were included, so no invite emails were sent.",
                  result.teams_join_url
                    ? `Teams link: ${result.teams_join_url}`
                    : (result as { teams_unavailable_reason?: string }).teams_unavailable_reason ??
                      `${providerLabel} created the event, but Microsoft did not create a Teams link for this account.`,
                  result.link ? `${providerLabel} event: ${result.link}` : "",
                ]
                  .filter(Boolean)
                  .join("\n\n");
          await supabase.from("messages").insert({
            thread_id: body.threadId!,
            user_id: userId,
            role: "assistant",
            content,
          });
          await supabase
            .from("threads")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", body.threadId!);
          return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }

        const gateway = createLovableAiGatewayProvider(LOVABLE_API_KEY);
        const factsBlock =
          factRows && factRows.length > 0
            ? `\n\n# Remembered facts about this user\n${factRows
                .map((f) => `- ${f.key}: ${f.value}`)
                .join("\n")}\nUse these naturally. If a fact is wrong, offer to update or forget it.`
            : "";

        const lessonsBlock =
          lessonRows.length > 0
            ? `\n\n# Lessons learned (apply these automatically)\nThese are corrections and preferences captured from past conversations. Treat them as standing rules unless the user clearly overrides one.\n${lessonRows
                .map((l) => `- ${l.lesson}${l.context ? ` (context: ${l.context})` : ""}`)
                .join("\n")}`
            : "";

        const feedbackBlock =
          feedbackRows.length > 0
            ? `\n\n# Recent thumbs-down feedback\nThe user marked recent answers as unhelpful. Avoid repeating these mistakes. When relevant, silently call \`save_lesson\` to record the fix.\n${feedbackRows
                .map((f) => `- ${f.note ? f.note : "(no note)"}`)
                .join("\n")}`
            : "";

        const userBlock = userEmail
          ? `\n\n# Current user\nThe signed-in user's email address is ${userEmail}. When they say "email me", "send it to me", or otherwise refer to themselves as the recipient, use exactly this address. Never invent or guess an email address — if you don't have one, ask.`
          : `\n\n# Current user\nYou do not know the signed-in user's email address. If they say "email me" without giving an address, ask them for it. Never invent an email address.`;
        const runtimeBlock = `\n\n# Current date/time\nCurrent server time is ${new Date().toISOString()}. Use this for relative calendar dates like "tomorrow" and "next Tuesday".`;
        const contactsBlock =
          contactRows.length > 0
            ? `\n\n# Saved contacts\nUse these for named recipients/attendees. Do not ask for an email when exactly one saved contact matches the name.\n${contactRows
                .map((c) => `- ${c.name}: ${c.email}${c.notes ? ` (${c.notes})` : ""}`)
                .join("\n")}`
            : "";
        const forceSearchBlock = body.forceWebSearch
          ? `\n\n# 🌐 Web-search mode is ON for this turn (user toggled it)\nYou MUST call the \`web_search\` tool at least once before answering. If the user is asking about specific products, gear, or things they might buy (phones, cameras, tools, gadgets, clothes, appliances, software, courses, etc.), call the \`product_search\` tool instead of \`web_search\`. After the tool returns, write a real answer that cites sources. Do NOT answer from memory when this mode is on.`
          : "";
        const systemWithUser = `${SYSTEM_PROMPT}${AUTONOMOUS_MODE}${SEARCH_DISCIPLINE}${DEPTH_MANDATE}${runtimeBlock}${userBlock}${contactsBlock}${factsBlock}${lessonsBlock}${feedbackBlock}${forceSearchBlock}`;
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
          stopWhen: stepCountIs(50),
          // Push the model toward richer, more thorough answers instead of
          // the terse default it tends to give. GPT-5.4 exposes both
          // reasoning-effort and text-verbosity knobs.
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              textVerbosity: "high",
            },
          },
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
                "Search the web for real products the user could buy (gadgets, gear, tools, clothing, appliances, software, courses, etc.) and return a compact list of product cards (title, image, price, merchant, url). Use this INSTEAD of web_search whenever the user asks to find, compare, recommend, or shop for a real product. After calling, write a short recommendation paragraph — do NOT re-list every product in prose; the UI renders cards.",
              inputSchema: z.object({
                query: z.string().describe("Shopping-style query, e.g. 'best noise cancelling headphones under $300'"),
                limit: z.number().int().min(1).max(6).optional(),
              }),
              execute: async ({ query, limit }) => {
                const key = process.env.FIRECRAWL_API_KEY;
                if (!key) return { error: "Product search not configured" };
                const n = Math.min(limit ?? 5, 6);
                const r = await fetch("https://api.firecrawl.dev/v2/search", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    query,
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
                        metadata?: {
                          title?: string;
                          description?: string;
                          ogImage?: string;
                          "og:image"?: string;
                          image?: string;
                          ogSiteName?: string;
                        };
                      }>
                    | { web?: Array<{ title?: string; url?: string; description?: string }> };
                };
                const arr = Array.isArray(j.data) ? j.data : j.data?.web ?? [];
                const hostname = (u?: string) => {
                  if (!u) return undefined;
                  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return undefined; }
                };
                const extractPrice = (text?: string) => {
                  if (!text) return undefined;
                  const m = text.match(/(?:USD|CAD|AUD|GBP|EUR)?\s?[$£€¥]\s?\d{1,3}(?:[,\s]?\d{3})*(?:\.\d{1,2})?/);
                  return m?.[0]?.trim();
                };
                const products = arr.slice(0, n).map((x) => {
                  const meta = (x as { metadata?: Record<string, unknown> }).metadata ?? {};
                  const image =
                    (meta.ogImage as string | undefined) ??
                    (meta["og:image"] as string | undefined) ??
                    (meta.image as string | undefined);
                  const md = (x as { markdown?: string }).markdown ?? "";
                  return {
                    title: x.title ?? (meta.title as string | undefined),
                    url: x.url,
                    image,
                    price: extractPrice(md) ?? extractPrice(x.description),
                    merchant: (meta.ogSiteName as string | undefined) ?? hostname(x.url),
                    snippet: x.description ?? (meta.description as string | undefined),
                  };
                });
                return { products };
              },
            }),
            send_email: tool({
              description:
                "Send an email from the user's connected Outlook account. Use when the user asks to email someone, send a message, or email themselves. To attach a file you just generated with generate_document, pass its returned `url` as `attach_file_url` (and its `filename` as `attach_file_name`) — do NOT paste the raw URL into the body.",
              inputSchema: z.object({
                to: z.string().email().describe("Recipient email address"),
                subject: z.string().min(1).max(200),
                body: z.string().min(1).max(20000),
                cc: z.string().email().optional(),
                attach_file_url: z
                  .string()
                  .url()
                  .optional()
                  .describe("If set, the server fetches this URL and attaches its bytes to the email."),
                attach_file_name: z
                  .string()
                  .min(1)
                  .max(160)
                  .optional()
                  .describe("Filename to use for the attachment (e.g. 'Report.docx'). Required when attach_file_url is set."),
              }),
              execute: async ({ to, subject, body: emailBody, cc, attach_file_url, attach_file_name }) => {
                if (looksLikeCalendarInviteText(`${subject}\n${emailBody}\n${attach_file_name ?? ""}`)) {
                  return {
                    error:
                      "This looks like a calendar/Teams invite. Use create_calendar_event so Outlook sends a real invite with accept/decline and a Teams link.",
                  };
                }
                const { gatewayHeaders } = await import("@/lib/jarvis-tools.server");
                const { marked } = await import("marked");
                // Optionally fetch the file bytes for attachment.
                let attachment: { filename: string; mimeType: string; base64: string } | null = null;
                if (attach_file_url) {
                  try {
                    const r = await fetch(attach_file_url);
                    if (!r.ok) return { error: `Could not fetch attachment (${r.status})` };
                    const mimeType = r.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
                    const buf = new Uint8Array(await r.arrayBuffer());
                    if (buf.byteLength > 15 * 1024 * 1024) return { error: "Attachment too large (max 15MB)" };
                    let bin = "";
                    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
                    attachment = {
                      filename: (attach_file_name || "attachment").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160),
                      mimeType,
                      base64: Buffer.from(bin, "binary").toString("base64"),
                    };
                  } catch (e) {
                    return { error: `Attachment fetch failed: ${e instanceof Error ? e.message : String(e)}` };
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
                 {
                   const call = await msGraphFetch(userId, "/me/sendMail", {
                     method: "POST",
                     body: JSON.stringify({
                         message: {
                           subject,
                           body: { contentType: "HTML", content: renderHtml(emailBody) },
                           toRecipients: [{ emailAddress: { address: to } }],
                           ...(cc
                             ? { ccRecipients: [{ emailAddress: { address: cc } }] }
                             : {}),
                            ...(attachment
                              ? {
                                  attachments: [
                                    {
                                      "@odata.type": "#microsoft.graph.fileAttachment",
                                      name: attachment.filename,
                                      contentType: attachment.mimeType,
                                      contentBytes: attachment.base64,
                                    },
                                  ],
                                }
                              : {}),
                         },
                       }),
                   });
                   if (!call) return { error: "Outlook is not connected." };
                   const r = call.response;
                   if (!r.ok) {
                     const t = await r.text();
                     await logAction("send_email", `Failed to send email to ${to}`, { to, subject, provider: "outlook", status: r.status }, "error");
                     return { error: `Outlook send failed (${r.status})`, detail: t.slice(0, 200) };
                   }
                   await logAction("send_email", `Sent email to ${to} — ${subject}`, { to, cc, subject, provider: "outlook", attached: attachment?.filename ?? null });
                   return { ok: true, provider: "outlook", to, subject, attached: attachment?.filename ?? null };
                 }
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
                "List upcoming Outlook calendar events/meetings. Use before answering calendar questions, checking availability, canceling, or responding when the exact event is ambiguous.",
              inputSchema: z.object({
                days: z.number().int().min(1).max(60).optional().describe("How many days ahead to look. Default 7."),
                max_results: z.number().int().min(1).max(50).optional(),
                start: z.string().optional().describe("Optional ISO start datetime for a custom range."),
                end: z.string().optional().describe("Optional ISO end datetime for a custom range."),
              }),
              execute: async ({ days, max_results, start, end }) => {
                const { listMicrosoftCalendarEvents } = await import("@/lib/ms-calendar.server");
                return listMicrosoftCalendarEvents(userId, { days, max_results, start, end });
              },
            }),
            create_calendar_event: tool({
              description:
                "Create a real Outlook calendar event/invite with a Microsoft Teams link. Pass online_meeting=true unless the user explicitly says no online meeting. Only call after the user has approved the draft. If this fails, report the error; do not send an email as a substitute calendar invite.",
              inputSchema: z.object({
                title: z.string().min(1).max(200),
                start: z.string().describe("ISO 8601 start datetime, e.g. 2026-07-01T15:00:00-04:00"),
                end: z.string().describe("ISO 8601 end datetime"),
                description: z.string().max(5000).optional(),
                location: z.string().max(500).optional(),
                attendees: z
                  .array(z.string().min(1).max(320))
                  .optional()
                  .describe("Attendee email addresses or saved contact names, e.g. bill@company.com or Bill."),
                timezone: z.string().optional().describe("IANA timezone, e.g. America/New_York"),
                online_meeting: z
                  .boolean()
                  .optional()
                  .describe("Attach an online meeting join link. Default true for all meetings unless user explicitly says no online meeting."),
              }),
              execute: async ({ title, start, end, description, location, attendees, timezone, online_meeting }) => {
                const { resolveContactAttendees } = await import("@/lib/contact-resolution.server");
                const resolved = await resolveContactAttendees(supabase, attendees);
                if (resolved.unresolved.length > 0) {
                  return {
                    error: `I couldn't find a saved contact for: ${resolved.unresolved.join(", ")}. Please provide the email address or save the contact first.`,
                    unresolved_attendees: resolved.unresolved,
                  };
                }
                const { createMicrosoftCalendarEvent } = await import("@/lib/ms-calendar.server");
                const providerLabel = "Outlook";
                const providerKey = "outlook";
                const result = await createMicrosoftCalendarEvent(userId, {
                  title,
                  start,
                  end,
                  description,
                  location,
                  attendees: resolved.attendees,
                  timezone,
                  online_meeting: online_meeting ?? true,
                });
                await logAction(
                  "create_calendar_event",
                  "error" in result
                    ? `Failed to create ${providerLabel} event "${title}"`
                    : `Created event "${title}" on ${providerLabel}${result.teams_join_url ? " with Teams meeting" : ""}`,
                  { title, start, end, attendees: resolved.attendees, location, provider: providerKey, result },
                  "error" in result ? "error" : "ok",
                );
                return result;
              },
            }),
            cancel_calendar_event: tool({
              description:
                "Cancel/delete an Outlook calendar event and notify attendees when possible. If the user did not provide a precise event id, call list_calendar_events first and ask them to confirm which event before using this tool.",
              inputSchema: z.object({
                event_id: z.string().min(1).describe("The Outlook event id from list_calendar_events."),
                comment: z.string().max(1000).optional().describe("Optional cancellation message to send to attendees."),
              }),
              execute: async ({ event_id, comment }) => {
                const { cancelMicrosoftCalendarEvent } = await import("@/lib/ms-calendar.server");
                const result = await cancelMicrosoftCalendarEvent(userId, { event_id, comment });
                await logAction(
                  "cancel_calendar_event",
                  "error" in result ? `Failed to cancel Outlook event ${event_id}` : `Canceled Outlook event ${event_id}`,
                  { event_id, comment, provider: "outlook", result },
                  "error" in result ? "error" : "ok",
                );
                return result;
              },
            }),
            respond_calendar_event: tool({
              description:
                "Accept, tentatively accept, or decline an Outlook meeting invitation. If the user did not provide a precise event id, call list_calendar_events first and ask them to confirm which meeting before using this tool.",
              inputSchema: z.object({
                event_id: z.string().min(1).describe("The Outlook event id from list_calendar_events."),
                response: z.enum(["accept", "tentative", "decline"]),
                comment: z.string().max(1000).optional(),
                send_response: z.boolean().optional().describe("Whether to send the organizer a response. Default true."),
              }),
              execute: async ({ event_id, response, comment, send_response }) => {
                const { respondToMicrosoftCalendarEvent } = await import("@/lib/ms-calendar.server");
                const result = await respondToMicrosoftCalendarEvent(userId, { event_id, response, comment, send_response });
                await logAction(
                  "respond_calendar_event",
                  "error" in result ? `Failed to ${response} Outlook event ${event_id}` : `${response}ed Outlook event ${event_id}`,
                  { event_id, response, comment, send_response, provider: "outlook", result },
                  "error" in result ? "error" : "ok",
                );
                return result;
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
            save_lesson: tool({
              description:
                "Silently record a durable lesson the assistant should apply in every future conversation (e.g. a user correction, a workflow preference, 'always cc John on client emails'). Do not mention to the user that you saved it.",
              inputSchema: z.object({
                lesson: z
                  .string()
                  .min(4)
                  .max(500)
                  .describe("The standing rule, phrased as an instruction (e.g. 'Always send emails in plain text, not HTML')."),
                context: z
                  .string()
                  .max(300)
                  .optional()
                  .describe("Short context for when this lesson applies."),
              }),
              execute: async ({ lesson, context }) => {
                const { error } = await supabase.from("lessons_learned").insert({
                  user_id: userId,
                  lesson: lesson.trim(),
                  context: context?.trim() ?? null,
                  source: "auto",
                });
                if (error) return { error: error.message };
                await logAction("save_lesson", `Lesson: ${lesson.slice(0, 80)}`, { lesson, context });
                return { ok: true };
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
                  // Rough token estimate — embeddings are cheap but worth tracking.
                  const inTok = Math.ceil(query.length / 4);
                  await logUsage(
                    "embedding",
                    "openai/text-embedding-3-small",
                    inTok,
                    0,
                    computeCost("openai/text-embedding-3-small", inTok, 0),
                    { query: query.slice(0, 120) },
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
            generate_document: tool({
              description:
                "Generate a downloadable PDF, Word (.docx), Excel (.xlsx), CSV, or TXT file from Markdown and return a signed download URL. Use whenever the user asks for a file, attachment, report, export, PDF, spreadsheet, or Word doc. Do NOT use for calendar invites, meeting invites, Outlook invites, Teams meetings, or scheduling; those must use create_calendar_event.",
              inputSchema: z.object({
                format: z
                  .enum(["pdf", "docx", "xlsx", "csv"])
                  .describe(
                    "File type. Default to 'pdf' unless the user explicitly asked for Word/Excel/CSV. NEVER pick a format the user didn't ask for.",
                  ),
                filename: z.string().min(1).max(120).describe("Base filename without extension"),
                title: z.string().min(1).max(200),
                markdown: z
                  .string()
                  .min(1)
                  .max(200000)
                  .describe("Full document body as Markdown. For xlsx/csv, include GitHub-flavored Markdown tables."),
              }),
              execute: async ({ format, filename, title, markdown }) => {
                try {
                  if (looksLikeCalendarInviteText(`${title}\n${filename}\n${markdown}`)) {
                    return {
                      error:
                        "This is a calendar/Teams invite, not a document. Call create_calendar_event with online_meeting=true so Outlook sends the real invite and Teams link.",
                    };
                  }
                  const { generateDocument } = await import("@/lib/document-generator.server");
                  const { bytes, mimeType, extension } = await generateDocument({
                    format,
                    title,
                    markdown,
                  });
                  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
                  // Put the timestamp in a folder segment so the visible
                  // filename in the URL stays clean (e.g. no "1783...-name").
                  const path = `generated/${userId}/${Date.now().toString(36)}/${safeName}.${extension}`;
                  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
                  const up = await supabaseAdmin.storage
                    .from("chat-uploads")
                    .upload(path, bytes, { contentType: mimeType, upsert: false });
                  if (up.error) return { error: up.error.message };
                  const signed = await supabaseAdmin.storage
                    .from("chat-uploads")
                    .createSignedUrl(path, 60 * 60 * 24 * 7);
                  if (signed.error) return { error: signed.error.message };
                  await logAction("generate_document", `Generated ${extension.toUpperCase()} "${safeName}"`, {
                    format,
                    filename: `${safeName}.${extension}`,
                  });
                  return {
                    ok: true,
                    url: signed.data.signedUrl,
                    filename: `${safeName}.${extension}`,
                    mimeType,
                  };
                } catch (e) {
                  return { error: e instanceof Error ? e.message : String(e) };
                }
              },
            }),
          },
          onFinish: async ({ text }) => {
            const marker = encodeToolActivityMarker(collectedActivity);
            await supabase.from("messages").insert({
              thread_id: body.threadId!,
              user_id: userId,
              role: "assistant",
              content: marker + cleanAssistantText(text),
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
            // Fire-and-forget: quietly review this thread for durable lessons.
            // The reviewer has its own threshold/cooldown checks and swallows errors.
            void (async () => {
              try {
                const { reviewThreadForLessons } = await import("@/lib/self-improvement.server");
                await reviewThreadForLessons(body.threadId!, userId);
              } catch {
                /* never break the response */
              }
            })();
          },
        });

        // Custom stream: text deltas as UTF-8 text, plus RS-delimited JSON
        // control frames for web_search / web_scrape tool activity so the
        // client can render Claude-style live search chips.
        const collectedActivity: ToolActivity[] = [];
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  const delta = (part as { text?: string; textDelta?: string }).text
                    ?? (part as { textDelta?: string }).textDelta
                    ?? "";
                  if (delta) controller.enqueue(encoder.encode(delta));
                } else if (part.type === "tool-call") {
                  const name = (part as { toolName: string }).toolName;
                  if (isTrackedTool(name)) {
                    const rawInput = (part as { input?: Record<string, unknown> }).input ?? {};
                    const ev: ToolEvent = {
                      t: "call",
                      id: (part as { toolCallId: string }).toolCallId,
                      name: name as ToolEvent["name"],
                      input: rawInput as {
                        query?: string;
                        url?: string;
                        limit?: number;
                        subject?: string;
                        title?: string;
                        to?: string;
                      },
                    };
                    collectedActivity.splice(
                      0,
                      collectedActivity.length,
                      ...foldToolEvent(collectedActivity, ev),
                    );
                    controller.enqueue(
                      encoder.encode(TOOL_FRAME_DELIM + JSON.stringify(ev) + TOOL_FRAME_DELIM),
                    );
                  }
                } else if (part.type === "tool-result") {
                  const name = (part as { toolName: string }).toolName;
                  if (isTrackedTool(name)) {
                    const output = (part as { output?: unknown; result?: unknown }).output
                      ?? (part as { result?: unknown }).result;
                    const ev: ToolEvent = {
                      t: "result",
                      id: (part as { toolCallId: string }).toolCallId,
                      name: name as ToolEvent["name"],
                      output,
                    };
                    collectedActivity.splice(
                      0,
                      collectedActivity.length,
                      ...foldToolEvent(collectedActivity, ev),
                    );
                    controller.enqueue(
                      encoder.encode(TOOL_FRAME_DELIM + JSON.stringify(ev) + TOOL_FRAME_DELIM),
                    );
                  }
                }
              }
            } catch (e) {
              controller.enqueue(
                encoder.encode(
                  `\n\n_(stream error: ${e instanceof Error ? e.message : String(e)})_`,
                ),
              );
            } finally {
              controller.close();
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