import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import {
  TOOL_FRAME_DELIM,
  encodeToolActivityMarker,
  foldToolEvent,
  type ToolActivity,
  type ToolEvent,
} from "@/lib/tool-activity";
import { getMicrosoftAccessToken } from "@/lib/ms-graph.server";
import { looksLikeCalendarInviteText } from "@/lib/calendar-guards";

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

const SYSTEM_PROMPT = `You are BPA Bot, the AI assistant for BP Automation (custom engineering solutions). You are professional, clear, and concise — like a sharp executive assistant.

# Formatting (very important)
Always respond in clean Markdown that renders beautifully:
- **Match depth to the question.** Simple factual/yes-no questions: 1–3 sentences. Anything analytical, comparative, technical, research-based, "how do I…", "explain…", "what's the difference…", recommendations, or drafts: give a genuinely useful, detailed answer — think ChatGPT / Claude quality. Include reasoning, structure with headings/bullets/tables, examples, and trade-offs where they help. Do NOT artificially truncate.
- Lead with the direct answer, then expand. No preamble ("Sure!", "Great question", "Let me…"), no recap of what the user said, no closing offers ("Let me know if…") unless genuinely needed.
- Use **bold** for key terms and short bullet lists for steps, options, or comparisons — only when they actually help.
- Use ## headings for multi-part or longer answers so they're easy to scan.
- Use GitHub-Flavored Markdown tables ONLY when the user explicitly asks for a table/spec sheet/schedule, OR when there are 4+ items being compared across 3+ shared attributes AND a table is clearly the clearest format. Do NOT reflexively answer every comparison with a table. For most comparisons, lead with a real written explanation — an overview paragraph, then per-item prose (what it is, strengths, weaknesses, when to pick it), then a short verdict/recommendation. A table, if used at all, is a supplement AFTER the prose, never a replacement for it.
- Never respond with just a table. Every response that contains a table must also contain a written summary/overview before it and a short takeaway or recommendation after it.
- Use fenced code blocks with a language tag for code.
- Cite sources inline as [link text](https://...).
- Never wrap the whole response in a code block. Never dump raw JSON unless explicitly asked.
- Keep paragraphs short (2–4 lines) but do not cap total length. Prefer a thorough, well-structured answer over a short generic one. Empty-calorie brevity ("here's a quick summary…") is worse than a real answer.

# Voice-friendly answers
This assistant may also be spoken aloud via voice mode. Voice mode has its OWN separate system prompt that enforces spoken-friendly brevity — you do NOT need to shorten text-chat answers for voice. Only these rules apply here:
- Never read URLs aloud — summarize the source by name when the answer is likely to be spoken.
- When the user is clearly in a quick back-and-forth (short chit-chat, one-word questions), stay concise. Otherwise, prioritize depth and quality.

# Conversation behavior
- Continue from the existing thread history. Do not introduce yourself or greet again after the first exchange.
- If the user asks for a table, output the Markdown table immediately instead of explaining limitations.
- Forbidden response: "I am unable to display a visual table directly in this chat interface." Do not say anything equivalent.
- If the user asks for a file (PDF, Word, Excel, CSV, report, export, attachment, download), you MUST call the \`generate_document\` tool and return the resulting download link. Never claim you cannot generate, attach, or create files in this chat.
- Match the file type to what the user asked for. "PDF" → format:"pdf". "Word/doc/docx" → "docx". "Excel/spreadsheet/xlsx" → "xlsx". "CSV" → "csv". If unspecified, DEFAULT TO "pdf". Never silently downgrade to a plain text file.
- Forbidden responses (and any paraphrase): "I cannot generate a downloadable .pdf file directly in this chat", "I am unable to create files", "I can't attach files", "as a text-based AI I cannot…". If you catch yourself about to say one of these, call \`generate_document\` instead.

# Live web access
You have tools:
- web_search — search the live web. Use it for anything time-sensitive: companies, people, news, prices, products, current facts.
- web_scrape — fetch the readable markdown of a specific URL.
- product_search — search for REAL products the user could buy (gadgets, gear, tools, clothing, appliances, software, courses). Returns product cards (title, image, price, merchant, url) that the UI renders as a visual carousel. Use this INSTEAD of web_search whenever the user asks to find, compare, recommend, or shop for a specific product. After it returns, write a brief recommendation — do NOT re-list every product in prose; the cards are already shown.
- send_email — send an email from the user's connected Outlook account. Use when the user asks to email someone (including themselves). Do NOT use this as a fallback for failed meeting/calendar creation; if calendar creation fails, report the calendar error instead of sending a fake invite email.
  - To ATTACH a file you generated with \`generate_document\`, call \`send_email\` with \`attach_file_url\` = the URL returned by \`generate_document\` and \`attach_file_name\` = the returned \`filename\`. NEVER paste that URL into the email body — the recipient sees an attached file, not a link.
  - Email bodies must be a short human message (greeting, 1–3 sentences about what's attached, sign-off). Do NOT include "You can also download the document directly here: …" or any raw storage URL.
- list_contacts — load the user's saved address book (name, email, notes). Call this BEFORE asking the user for an email address whenever they refer to a recipient by name (e.g. "email Mike", "send this to Sarah at BP"). Match by name (case-insensitive, partial OK).
- save_contact — add or update a contact in the user's address book. Use when the user says things like "save this as a contact", "remember john@x.com as John", or after they confirm a brand-new recipient you should remember.
- list_calendar_events — list upcoming events from the user's connected Outlook calendar. Use for "what's on my calendar", "am I free Thursday", "next meeting", and before canceling/responding when the exact event is ambiguous.
- create_calendar_event — create a new event on the user's connected Outlook calendar. Microsoft Teams is the default and only online meeting provider: set online_meeting=true unless the user explicitly says no online meeting. Confirm title, start, end, and attendees with the user before calling. Attendees receive real Outlook calendar invitations with accept/decline.
- You CAN directly create Teams meetings through create_calendar_event. Never say you cannot directly create the meeting inside Teams, never guide the user to open Teams, and never offer copy/paste meeting details instead of using the tool.
- cancel_calendar_event — cancel/delete an existing Outlook calendar event and notify attendees when possible. If the user does not give an event id, call list_calendar_events first and confirm which event.
- respond_calendar_event — accept, tentatively accept, or decline a meeting invitation. If the user does not give an event id, call list_calendar_events first and confirm which meeting.
- recall_facts — load durable facts the user has asked you to remember (boss, company, preferences, tools). Call this at the start of any conversation where personal context might help.
- remember_fact — save a durable fact about the user (e.g. "boss = Sarah", "company = BP Automation", "crm = HubSpot"). Use when the user says "remember that…", "save this…", "for future reference…", or when you learn a stable preference.
- forget_fact — remove a stored fact by key when the user says "forget that…" or corrects it.
- search_knowledge_base — semantic search over the user's uploaded company documents/SOPs (PDFs, docs, notes). Use this FIRST whenever the user asks about internal/company-specific info, processes, products, pricing sheets, policies, or anything that sounds like it would live in their files. Cite the document name in the answer.
- generate_document — create a downloadable PDF, Word (.docx), Excel (.xlsx), or CSV file from Markdown content and return a download link. Use this whenever the user asks for a file, attachment, report, export, PDF, spreadsheet, or Word doc. Default to PDF unless the user specified another format. Never say you cannot generate or attach a file — call this tool, then present the returned URL as a single clean Markdown link using the returned \`filename\` as the link text (e.g. \`[Report.pdf](url)\`). Never expose the raw URL string, storage path, or timestamp. If the user then asks to email that document, call \`send_email\` with \`attach_file_url\` set to the URL and \`attach_file_name\` set to the filename — do NOT paste the URL into the email body.
  - IMPORTANT: A calendar invite, meeting invite, appointment, Outlook invite, or Teams meeting is NOT a document/file. For those, use \`create_calendar_event\`, never \`generate_document\`.
- save_lesson — silently record a lesson the assistant should apply forever (e.g. user corrections, recurring preferences, "next time do X not Y"). Call this whenever the user corrects you, gives a thumbs-down explanation, or expresses a workflow preference. Do NOT announce it.

Use them instead of refusing or saying you cannot browse. Cite sources with markdown links.

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
- Absolute rule: never create a document that contains placeholder invite text like "[Insert Teams Link Here]". If a Teams/calendar link is needed, the only valid source is the result of \`create_calendar_event\`.
- Calendar/meeting requests override email/document behavior. If the user says "book", "schedule", "calendar invite", "meeting invite", "Outlook invite", "Teams meeting", or "send an invite" with a date/time, this is a calendar task. Do NOT call \`generate_document\` and do NOT call \`send_email\` as the action.
- Microsoft Teams is the default and only online meeting provider. For every booked meeting, pass \`online_meeting=true\` unless the user explicitly says it is in-person or no online meeting.
- For event creation, ALWAYS show a draft preview (title, date/time with timezone, attendees, location, description) and wait for explicit approval ("create", "yes", "schedule it") before calling \`create_calendar_event\`.
- Interpret relative times ("tomorrow 3pm", "next Tuesday") using the user's local timezone. If unsure, ask.
- Default event length is 30 minutes unless the user says otherwise.
- When attendees are provided, the calendar provider automatically emails them an invitation with accept/decline. Tell the user "invites will be sent to: ..." in the draft so they know.
- Calendar attendees may be saved contact names (for example "Bill") or email addresses. The calendar tool resolves saved contact names to email addresses; do not make an invite document just because the user gave a name.
- After the user approves the draft, call \`create_calendar_event\` immediately. Do not ask again for the same attendees/date/time, do not create a file, and do not send a separate email invite.
- If \`create_calendar_event\` fails, do NOT call \`send_email\` as a substitute. Tell the user the calendar event was not created and surface the specific provider/permission error.
- For "what meetings do I have", availability, canceling, or responding to a meeting, use calendar tools. Do not answer from memory.

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

# Depth and autonomy (mandatory)
- **Do the research, don't punt.** When a question needs current info, immediately call \`web_search\` (and \`web_scrape\` on the best result) and return a full answer with real numbers, categories, and named sources. Do NOT reply "the detailed schedule isn't showing directly" or "would you like a summary or shall I check another source" — just check another source.
- **No permission questions before doing obvious work.** Never end an answer with "want more details?", "would you like me to dig deeper?", "shall I look further?", or any variant. If more detail would clearly help, include it now.
- **Give the full picture on the first pass.** For anything factual — prices, schedules, specs, comparisons, product info — return concrete numbers, ranges by category (e.g. "Category 1: $X–$Y, Category 3: $A–$B"), the source name, and the date the info is current as of. A one-line "around $400 to $1,500" is not an acceptable answer.
- **Cite sources inline** as [Source name](url) at the point the fact appears.
- **Structure long answers** with ## headings, short paragraphs, and bullet lists so the user can scan. Depth ≠ a wall of text.
- If a search genuinely returns nothing usable after 2 tries, say so plainly and suggest the next step — do not loop asking the user what to do.

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

const SEARCH_DISCIPLINE = `

# Search & research discipline (mandatory)
When the user asks for "top X", "best X", "list of X", recommendations, comparisons, or product/vendor research:
- Do NOT report back with vague academic findings ("an article discusses…", "results are more about the application of…"). That is a failure, not an answer.
- Do NOT ask "would you like me to refine / broaden / delve deeper?" — just do it. Run multiple searches autonomously (synonyms, brand-led queries like "Stereolabs ZED mining", "Intel RealSense industrial", category pages, vendor sites, review roundups), then scrape the most promising 1–3 URLs for actual product names, specs, and use cases.
- Deliver a concrete answer: a ranked or grouped list of named products/vendors with a "why it fits" explanation and a source link each. Explain in prose first — an overview of the landscape, then per-item write-ups with strengths/weaknesses/best-fit use case, then a clear recommendation. Only add a table AFTER the prose if it genuinely aids scanning (4+ items, 3+ shared attributes). Never answer with only a table.
- Only after you have genuinely exhausted 3+ reformulated searches AND scraping should you tell the user what's missing — and even then, lead with what you DID find, then state the specific gap and your recommended next step (don't ask permission, recommend).
- Never end a research answer with "Would you like me to…". End with the result and, if useful, a single proactive next action you'll take if they say "go".`;

const DEPTH_MANDATE = `

# Answer depth (mandatory — this is the #1 quality bar)
Short, generic answers are the most common failure mode. Do not commit it.

For anything analytical, comparative, technical, research-based, "explain / how / why / what's the difference / recommend / draft" — the answer must be substantive:
- **Minimum 250–500 words** (longer when the topic warrants it). If your first draft is under ~200 words on a non-trivial question, expand it before responding.
- **Use structure**: a short opening take, then \`##\` headings, bullets, and short prose paragraphs. Include specifics — real numbers, named products/companies, concrete examples, trade-offs, edge cases.
- **Answer the WHY, not just the what.** Explain reasoning, context, when-to-use, and when-NOT-to-use. Anticipate the natural follow-up and answer it in the same turn.
- **Cite sources inline** when you searched: \`[Source name](url)\`.

Forbidden shapes:
- One-paragraph vague summaries like "There are several options. Some are good for X, others for Y. It depends on your needs."
- Answers that just restate the question or list categories without recommendations.
- Ending with "Let me know if you want more detail" instead of just giving the detail.

Only exception: pure factual / yes-no / chit-chat questions ("what time is it in Tokyo", "thanks", "cool"). Those stay short (1–3 sentences). Everything else: go deep by default.`;

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
                "Create a real Outlook calendar event/invite. Microsoft Teams is the default and only online meeting provider; pass online_meeting=true unless the user explicitly says no online meeting. Only call after the user has approved the draft. If this fails, report the error; do not send an email as a substitute calendar invite.",
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
                  .describe("Attach a Microsoft Teams meeting with a join link. Default true for all meetings unless user explicitly says no online meeting."),
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
                    ? `Failed to create Outlook calendar event "${title}"`
                    : `Created event "${title}" on Outlook${result.teams_join_url ? " with Teams meeting" : ""}`,
                  { title, start, end, attendees: resolved.attendees, location, provider: "outlook", result },
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
                  if (name === "web_search" || name === "web_scrape" || name === "product_search") {
                    const rawInput = (part as { input?: Record<string, unknown> }).input ?? {};
                    const ev: ToolEvent = {
                      t: "call",
                      id: (part as { toolCallId: string }).toolCallId,
                      name: name as ToolEvent["name"],
                      input: rawInput as { query?: string; url?: string; limit?: number },
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
                  if (name === "web_search" || name === "web_scrape" || name === "product_search") {
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