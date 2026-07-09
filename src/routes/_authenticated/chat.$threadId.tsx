import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRealtimeVoice, type RealtimeToolDef } from "@/lib/useRealtimeVoice";
import { createRealtimeSession, logVoiceUsage } from "@/lib/realtime-voice.functions";
import {
  voiceWebScrape,
  voiceProductSearch,
  voiceKnowledgeSearch,
  voiceRecallFacts,
  voiceRememberFact,
  voiceSaveLesson,
} from "@/lib/voice-tools.functions";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, Plus, Trash2, LogOut, Send, Menu, X, ArrowDown, Users, Paperclip, FileText, Image as ImageIcon, Search, Square, RotateCcw, Download, Printer, Mail, MoreVertical, Sparkles, BookOpen, FileSpreadsheet, FileType2, Copy, Check, ThumbsUp, ThumbsDown, Globe, ShoppingBag, ExternalLink, DollarSign } from "lucide-react";
import {
  exportToPdf,
  exportToDocx,
  exportToXlsx,
  exportToCsv,
} from "@/lib/chat-export";
import { generateAndStoreDocument } from "@/lib/document.functions";
import {
  saveArtifact,
  getArtifact,
  getLatestArtifact,
  downloadArtifact,
  base64ToBlob,
  artifactMarker,
  ARTIFACT_MARKER_RE,
} from "@/lib/artifacts";
import {
  TOOL_FRAME_DELIM,
  extractToolActivity,
  foldToolEvent,
  faviconFor,
  hostOf,
  type ToolActivity,
  type ToolEvent,
} from "@/lib/tool-activity";
import { toast } from "sonner";
import bpaLogo from "@/assets/bpa-logo.png.asset.json";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { Eye } from "lucide-react";
import {
  addMessage,
  createThread,
  deleteThread,
  getThreadMessages,
  listThreads,
  renameThread,
  searchChats,
} from "@/lib/jarvis.functions";
import { createChatUploadUrl } from "@/lib/uploads.functions";
import { supabase } from "@/integrations/supabase/client";
import { looksLikeCalendarInviteText } from "@/lib/calendar-guards";

// Voice mode uses the SAME expert brain as text chat — same knowledge depth,
// research discipline, tone, autonomy, and follow-through. The ONLY differences
// are (a) spoken brevity for the audio channel and (b) long/structured content
// goes through the show_in_chat tool instead of being read aloud.
const VOICE_SESSION_PROMPT = `You are BPA Bot, the AI assistant for BP Automation. You sound like a sharp senior consultant thinking out loud with the user — not a search engine, not a summarizer, not a customer-service bot. You take initiative and finish the task. Continue the active conversation; do not introduce yourself, do not greet again, and do not say your name unless asked.

# 1. How to think (research philosophy)
You are a genuinely knowledgeable expert. Your training covers vendors, products, specs, standards, industry practice, engineering trade-offs — draw on it.
- Answer from your own knowledge first. For "best X", comparisons, explanations, technical deep-dives, industry landscape questions — give the expert answer directly. Name specific vendors, models, specs, tradeoffs. Do not open a search tool just because a question sounds "research-y".
- Use web_search / web_scrape to VERIFY, not to substitute. Call them when you genuinely can't know: today's price, this quarter's release, a specific spec sheet, a news event, a link the user asked for.
- If a search returns nothing useful, don't punt. Fall back to your own knowledge and answer anyway. Never say "my search didn't find anything, want me to try again?".
- Never invent facts, addresses, phone numbers, or pricing.
- If the user says "Cloud Code from Anthropic", treat it as "Claude Code from Anthropic" unless they explicitly correct you. Do not keep asking that clarification.

# 2. How to sound (voice-specific)
- Talk like a person. Natural connectors are fine ("Right, so…", "Honest take:", "The trade-off is…", "If it were me…"). Contractions fine. No corporate hedging.
- Lead with the direct answer or recommendation. NO preamble of any kind — this means NEVER open with meta-labels like "Direct pick up front:", "Straight answer first:", "Short, direct pick:", "TL;DR:", "Quick take:", "Honest take:", "Here's the deal:", "Bottom line:", or "Nice —". Do not announce that you are about to answer; just answer. The first spoken word must be the actual answer (e.g. "For most underground drilling and mining, …"), not a lead-in phrase. No recap of the question, no closing "Let me know if…".
- Give the honest take including negatives; correct the user's premise if it's off.
- Spoken replies are SHORT and conversational — usually 1–4 sentences so the user can interject. For anything longer, structured, or list-shaped, put the full content in show_in_chat and speak a one-sentence summary.
- Never read URLs, long tables, code, or long lists out loud. Summarize sources by name.
- End real questions with a concrete recommendation, not a checklist of "considerations".

# 3. Depth (still applies — depth goes into show_in_chat, not the spoken track)
- Simple factual / yes-no / chit-chat → answer aloud in 1–3 sentences, no tool.
- Analysis, comparison, how-to, explain, recommend, draft, or any "options/best/list" question → the FULL substantive answer (roughly 350–800 words with real numbers, named products, tradeoffs, "why", edge cases, a pick at the end) goes into show_in_chat. Then READ THE KEY FINDINGS ALOUD in natural conversational voice — the top pick and why, the runners-up by name, the key numbers/tradeoffs — roughly 30–60 seconds of speech. Don't just say "check the chat"; the whole point of voice is that the user hears the answer.
- BE EXHAUSTIVE ON THE FIRST TRY. If the user asks for "the best X", "options for Y", "vendors that do Z", "a list of…", the show_in_chat markdown must include AT LEAST 7–10 items unless the user gave a smaller number or the category genuinely only has a few serious options (say so explicitly).
- TABLES MUST BE COMPLETE. Every item goes into the markdown table itself — no truncated 3-row previews. If you also attach a document via generate_document, the chat table and the document must have the SAME rows.

Forbidden answer shapes (spoken OR in show_in_chat):
- "There are several options depending on your needs…"
- "When choosing X, you'll want to prioritize A, B, and C. Consider your environment and software support."
- "Here's a quick overview…" + 3 bullets and nothing else.
- Giving 3 items when the user asked for "the best" or "options" — aim for 7–10 minimum.
- Sending a short table in chat plus a longer table in an attached file (must be the same, complete list).
- "The detailed info isn't showing directly — want me to check another source?" (just check it).
- "I'm unable to display a visual table" — you CAN, via show_in_chat.

# 4. Formatting inside show_in_chat
Clean Markdown. ## headings for multi-part answers. Short paragraphs (2–4 lines). **Bold** for key terms. Bullets only when they aid scanning. Full GitHub-Flavored Markdown tables using pipes for any comparison/schedule/spec/tabular content. Fenced code blocks with a language tag for code. Never wrap the whole reply in a code block. Never dump raw JSON.

# 5. Tools (call them; don't narrate)
- deep_answer — YOUR PRIMARY TOOL for any research, comparison, ranking, list, "best X", "top N", "options for Y", how-to, explain, recommend, or long-draft question. Delegates to the full chat brain (stronger reasoning model + live web_search + web_scrape + product_search + knowledge base) which posts the full researched answer (with citations, sources, complete table when relevant) directly into the chat. YOU DO NOT compose these answers yourself. Call deep_answer with no arguments — it uses the user's most recent message. CRITICAL ORDERING: (1) call deep_answer FIRST, in silence — do NOT speak beforehand, do NOT say "let me search", "one sec", "I'll put it in the chat", or anything else before calling. (2) WAIT for the tool to return — the result includes the full answer text. (3) ONLY THEN speak the substance aloud in natural conversational voice using that answer text: name the top pick and why (1–2 sentences), then the runners-up with a brief reason each, then key numbers/tradeoffs or the recommendation — roughly 30–60 seconds total. End with a brief pointer like "full details and sources are in the chat." NEVER just say "check the chat" without reading the substance — voice users need to hear the answer. Never read URLs, long tables, or citation lists aloud — summarize them.
- IMPORTANT: for research/list/comparison questions, the app may already be running deep_answer in the background before you respond. If so, wait silently for the tool result / system instruction. Do not give a premature spoken placeholder.
- show_in_chat — ONLY for short structured content you're composing yourself: a draft email you wrote from the user's dictation, a code snippet, or a simple table with data you already have in the conversation. NOT for research or "best X" answers — use deep_answer for those. After it returns, one short spoken summary sentence.
- web_search / web_scrape / product_search / search_knowledge_base — you almost never need these directly, because deep_answer runs them inside the chat brain. Use them only for a quick spoken fact-check (a single price, a phone number, an address) where a full deep_answer would be overkill.
- send_email — send from the user's Outlook. NEVER on the first request. BEFORE calling, READ THE RECIPIENT ADDRESS BACK OUT LOUD, spelling both the local-part and the domain letter-by-letter (e.g. "sending to bill — b-i-l-l — at bilmedia dot com — b-i-l-m-e-d-i-a dot com. Correct?"). This is MANDATORY for any address dictated by voice, any unusual spelling, or any domain that isn't a common consumer provider (gmail.com, outlook.com, yahoo.com, icloud.com, hotmail.com). Then draft, then wait for explicit approval, then send. Body = clean human message with greeting, 1–3 short paragraphs, sign-off. No raw URLs. To attach a document you just generated, call with attach_last_document=true. Approval is ANY affirmative reply — "send", "yes", "yep", "sure", "ok", "cool", "go ahead", "do it", "send it", "looks good", "lgtm" — interpret liberally and call the tool immediately. Do NOT re-confirm.
- list_contacts / save_contact — call list_contacts before asking for an email when the user names a person like "Bill" or "Sarah". Never invent an address. Saved contact names are valid attendees for calendar events; the server resolves them.
- Calendar (Outlook + Teams): list_calendar_events, create_calendar_event, cancel_calendar_event, respond_calendar_event.
  - CALENDAR MEETINGS COME FIRST: any request to book, schedule, create, or send a calendar invite / meeting invite / Outlook invite / Teams meeting is NEVER a file/document task and NEVER a send_email task. Show a concise draft in chat (via show_in_chat if it's more than a sentence), wait for explicit approval, then CALL create_calendar_event.
  - YOU CAN CREATE TEAMS MEETINGS. create_calendar_event creates the Outlook invite and Teams join link. Never say you cannot, never tell the user to open Teams, never offer copy/paste details instead. Microsoft Teams is default; online_meeting=true unless the user explicitly says in-person. Default length 30 min.
  - TIMEZONE IS MANDATORY. Every meeting draft must explicitly state the timezone (e.g. "2:00 PM Mountain Time"). If unknown, ASK before drafting. Once told, silently remember_fact it so you don't ask again.
  - CALENDAR MANAGEMENT: for "what meetings do I have", availability, cancelling, accepting, tentatively accepting, or declining, use the calendar tools. If cancel/respond is ambiguous, list events first and confirm which one.
  - If create_calendar_event fails, report the specific error — do NOT fall back to send_email with a fake invite.
- generate_document — real PDF / DOCX / XLSX / CSV files. Use whenever the user asks to create, generate, export, download, save, or convert to a file (including "convert this to PDF/Word/Excel", "make it a Word doc", "save as PDF"). Default to PDF. CRITICAL: when the user asks to convert the previous chat content to a document, CALL generate_document — do NOT re-post the same markdown into the chat and claim a file was created. The tool shows the file as a preview card. Say "I've put the document in the chat — you can preview it, download it, or ask me to email it." Never say "downloading now", never say you cannot generate a file, never tell the user to copy into Word or Google Docs, never claim a PDF/document is in the chat unless generate_document actually returned successfully. Choose a short sensible filename.
- HONESTY RULE (critical): NEVER claim you've put something in the chat, sent an email, created a document, or booked a meeting unless the corresponding tool has actually returned successfully in this turn. No pre-announcements. No "I've put it in the chat" before the tool completes. If a tool errors, say so plainly and try again or ask for guidance — do not paper over the failure with a confident summary.
- recall_facts (call once at conversation start when personal context might help) / remember_fact (silently save stable facts like name, role, company, boss, CRM, timezone, sign-off, preferences — don't announce) / forget_fact (when the user says forget/correct) / save_lesson (silently record corrections/preferences to apply forever).

# 6. Autonomy & no-repetition
- Just do it. If a tool call is the clear next step, run it. Don't narrate ("let me search…") — run it and report.
- Chain tools to finish the task (search → scrape → draft). Don't stop halfway.
- Make reasonable assumptions with sensible defaults (30-min meeting, business-formal tone). State the assumption in one line so the user can override.
- Before asking ANY detail, check the prior conversation, current context, recalled facts, and saved contacts. If it's there, use it.
- One confirmation per action, ever. Approval means act — no second "just to confirm…". Never re-ask for information the user already provided in this thread (names, emails, recipients, dates, timezone, preferences, sign-off, tone). If you're about to ask something you've already asked, don't — use what you have.
- ONE QUESTION AT A TIME if you truly need missing info. Never a checklist.
- Only these need explicit approval: sending email, creating a calendar event, deleting saved data.

# 7. Proactive follow-through (MANDATORY)
After every completed action, propose the ONE most useful next step in a single short spoken line — not a menu, not "want me to do anything else?". Examples:
- After send_email succeeds → offer a calendar hold if the email proposed a meeting; otherwise a follow-up nudge in N days.
- After create_calendar_event succeeds → offer a 1-paragraph prep note as a doc, or a pre-meeting reminder email to attendees.
- After generate_document → offer to email it to the person the doc is clearly for.
- After product_search → offer to draft outreach to the top vendor, or export the shortlist as a comparison PDF.
Exactly ONE follow-up. Phrased as an offer the user can approve with "yes"/"ok".

# 8. Silent contact enrichment
When a NEW person's name + company (or email domain) appears and you don't have a fact about them: silently web_search "<name> <company>", and if you find a plausible bio/role, silently remember_fact with key contact:<name> and a 1-line value. Do NOT mention it. Do NOT paste the bio into the reply unless the user asked. Skip for people already in recall_facts or when only a common first name is given.

# 9. Voice channel behavior
- Stay in the session. Do not end the conversation, say goodbye, or wind down even if the user is silent. Wait quietly for their next message.
- INTERRUPTION: if the user starts speaking while you're talking, stop mid-sentence and listen. Never talk over the user. Resume only after they finish.
- Identity: you are BPA Bot. Never call yourself JARVIS or anything else.`;

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    try { track.stop(); } catch (err) { console.warn(err); }
  });
}

function voiceStartMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it in your browser/site settings, then tap the mic.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Connect or select a microphone, then tap the mic.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your microphone is already in use by another app. Close it, then tap the mic.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "This microphone could not start with the current browser settings. Try a different mic.";
  }
  if (/permission|notallowed|denied|blocked/i.test(`${name} ${message}`)) {
    return "Microphone permission is still being rejected by the browser. Check the site mic setting, then tap the mic.";
  }
  const detail = message?.trim().slice(0, 140);
  return detail
    ? `Voice failed to connect: ${detail}. Tap the mic once to try again.`
    : "Voice failed to connect. Tap the mic once to try again.";
}

// Realtime voice tool catalog. Passed to OpenAI Realtime via session.update.
const REALTIME_TOOL_DEFS: RealtimeToolDef[] = [
  {
    type: "function",
    name: "deep_answer",
    description:
      "PREFERRED for any research, comparison, list, ranking, 'best X', 'top N', 'options for Y', how-to, explain, recommend, draft, or any question that needs live web search or a substantive expert answer. Delegates to the full chat brain (stronger model + live web_search + web_scrape + product_search + knowledge base), which posts the researched answer (with citations, sources, and a full markdown table when relevant) directly into the chat. Do NOT compose the answer yourself with show_in_chat when deep_answer applies. After it returns, read the substantive answer aloud: top pick, runners-up by name, key numbers/tradeoffs, then briefly say full details and sources are in chat. Never just say check the chat. No arguments needed — it uses the user's most recent message in this thread.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "show_in_chat",
    description:
      "Render rich markdown directly in the chat WITHOUT speaking it. Use this ONLY for short structured content you're composing yourself — a draft email you've written from the user's dictation, a code snippet, or a simple table with data you already have. For any research/list/comparison/'best X'/how-to/recommend question, call deep_answer instead — do NOT compose those answers yourself. After show_in_chat returns, say ONE short spoken summary sentence — never read the content aloud.",
    parameters: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "Full markdown content." },
      },
      required: ["markdown"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web for current information. Returns a compact list of results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results, default 5" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "send_email",
    description:
      "Send a normal email on the user's behalf. NEVER use this for calendar invites, meeting invites, Teams meetings, or scheduling; use create_calendar_event for those. ALWAYS spell the recipient address back letter-by-letter (local-part AND domain) and wait for explicit approval before calling — never assume a dictated address is correct. Set attach_last_document=true to attach the most recent document you generated via generate_document.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "string" },
        attach_last_document: {
          type: "boolean",
          description: "If true, attach the most recently generated document (from generate_document) to this email.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    type: "function",
    name: "list_contacts",
    description:
      "List the user's saved contacts. Call this before asking for an email address when the user names a person such as Bill, Sarah, Mike, etc.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "create_calendar_event",
    description:
      "Create a real Outlook calendar event. Use this for booking/scheduling meetings, calendar invites, meeting invites, appointments, and Teams meetings. ALWAYS show a meeting draft first AND read every attendee email address back letter-by-letter (local-part AND domain) before calling; then wait for explicit approval. Microsoft Teams is default and Teams only; set online_meeting=true unless the user explicitly says no online meeting. Outlook emails the invite to attendees with accept/decline.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start datetime, e.g. 2026-07-07T15:00:00-04:00" },
        end: { type: "string", description: "ISO 8601 end datetime" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses or saved contact names, e.g. bill@company.com or Bill." },
        timezone: { type: "string", description: "IANA timezone, e.g. America/Toronto" },
        online_meeting: { type: "boolean", description: "True for Teams meetings; default true for all meetings unless user explicitly says no online meeting." },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    type: "function",
    name: "list_calendar_events",
    description: "List upcoming Outlook calendar events/meetings. Use for calendar questions, availability, and before canceling/responding when the event is ambiguous.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to look. Default 7." },
        max_results: { type: "number", description: "Maximum events to return. Default 10." },
        start: { type: "string", description: "Optional ISO range start." },
        end: { type: "string", description: "Optional ISO range end." },
      },
    },
  },
  {
    type: "function",
    name: "cancel_calendar_event",
    description: "Cancel/delete an Outlook calendar event and notify attendees when possible. If the event is ambiguous, list events first and confirm which one.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Outlook event id from list_calendar_events." },
        comment: { type: "string", description: "Optional cancellation message." },
      },
      required: ["event_id"],
    },
  },
  {
    type: "function",
    name: "respond_calendar_event",
    description: "Accept, tentatively accept, or decline an Outlook meeting invitation. If the event is ambiguous, list events first and confirm which one.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Outlook event id from list_calendar_events." },
        response: { type: "string", enum: ["accept", "tentative", "decline"] },
        comment: { type: "string" },
        send_response: { type: "boolean", description: "Whether to send the organizer a response. Default true." },
      },
      required: ["event_id", "response"],
    },
  },
  {
    type: "function",
    name: "generate_document",
    description:
      "Generate a document file (PDF, DOCX, XLSX, or CSV) from provided content and show it as a preview card in the chat (with Download and Email buttons). Does NOT auto-download. Use whenever the user asks to create, export, save, or convert content to a file. NEVER use this for calendar invites, meeting invites, Outlook invites, Teams meetings, or scheduling; use create_calendar_event instead. NEVER refuse; NEVER tell the user to copy into another app. After calling, briefly confirm out loud, e.g. 'I've put the Word doc in the chat — let me know if you want to email it or make edits.' Do NOT say the file is downloading.",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["pdf", "docx", "xlsx", "csv"],
          description: "Output file format.",
        },
        title: {
          type: "string",
          description:
            "Document title / filename base (no extension). Professional, human, Title Case with spaces — e.g. 'Q4 Sales Report', 'Stereoscopic Cameras Comparison'. NEVER use underscores, snake_case, hashes, timestamps, or ids.",
        },
        content: {
          type: "string",
          description:
            "Markdown content to render. Include GFM tables — they will be rendered as real tables in PDF/DOCX and as sheet rows in XLSX/CSV.",
        },
      },
      required: ["format", "title", "content"],
    },
  },
  {
    type: "function",
    name: "web_scrape",
    description: "Fetch the readable markdown of a specific URL when you need real detail off a page.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "product_search",
    description:
      "Search the web for real shoppable products (gadgets, gear, tools, appliances, software). Use INSTEAD of web_search when the user wants to buy/compare/recommend a specific product. Then briefly summarize aloud.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max products, default 5" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "search_knowledge_base",
    description:
      "Semantic search over the user's uploaded company docs. Use FIRST for anything internal/company-specific. Cite the document name.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "recall_facts",
    description:
      "Load durable facts the user has asked you to remember (boss, company, timezone, preferences). Call once early in the conversation when personal context might help.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "remember_fact",
    description:
      "Silently save a durable fact about the user (name, role, company, timezone, sign-off, preference). Do not announce it aloud.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short snake_case slug, e.g. 'timezone' or 'boss'." },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    type: "function",
    name: "save_lesson",
    description:
      "Silently record a durable lesson to apply in every future conversation (a user correction or standing preference). Do not announce it.",
    parameters: {
      type: "object",
      properties: {
        lesson: { type: "string" },
        context: { type: "string" },
      },
      required: ["lesson"],
    },
  },
];

const BAD_TABLE_REFUSAL = /(?:I(?:'m| am)\s+)?unable to display a visual table directly in this chat interface\.?/gi;
const BPA_INTRO = /^\s*(?:Hi,?\s*)?I(?:'m| am)\s+BPA Bot\s*[—-]\s*BP Automation'?s assistant\.\s*How can I help\??\s*/i;
const STRUCTURED_TABLE_REFUSAL = /I can present the information in a clear, structured text format that you can easily copy and paste\.\s*/gi;
const TABLE_RETRY_PROMPT = /Would you like me to provide the comparison details in that text format again\??/gi;

type VoiceUiState = "idle" | "starting" | "connected" | "stopping";

function cleanAssistantText(text: string) {
  return text
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    .replace(/^\s*Hello there!\s*I'm Alex[\s\S]*?today\??\s*/i, "")
    .replace(/^\s*How can I help you with web research or sending emails today\??\s*/i, "")
    .replace(/Hello there!\s*I'm Alex, your personal assistant\.\s*/gi, "")
    .replace(BPA_INTRO, "")
    .replace(BAD_TABLE_REFUSAL, "Here is the table:")
    .replace(STRUCTURED_TABLE_REFUSAL, "")
    .replace(TABLE_RETRY_PROMPT, "")
    .trim();
}

function normalizeVoiceQuery(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isVoiceChatPointer(text: string) {
  return /\b(chat|breakdown|comparison|details|laid out|posted|full answer|full list)\b/i.test(text) &&
    /\b(full|there|in the chat|take a look|posted|laid out|up)\b/i.test(text);
}

function voiceFollowupInstructions(result: { ok?: boolean; error?: string; note?: string; answer?: string }) {
  if (result.ok) {
    const answer = (result as { answer?: string }).answer?.trim();
    const answerBlock = answer
      ? `\n\nHere is the answer that was just posted to the chat — read the substance of it aloud in natural conversational voice:\n\n"""\n${answer.slice(0, 6000)}\n"""`
      : "";
    return [
      "The full answer is now visible in the chat.",
      "Read the substance aloud in natural conversational voice — name the top pick and why, mention the runners-up by name with a brief reason, and hit the key numbers or tradeoffs. Aim for roughly 30–60 seconds of speech.",
      "Do NOT just say 'check the chat' — the whole point of voice is that the user hears the answer.",
      "Do NOT read URLs, long tables, or citation lists aloud — summarize sources by name.",
      "End with a brief pointer like 'full details and sources are in the chat.'",
      "Do NOT post another chat message.",
    ].join(" ") + answerBlock;
  }
  return [
    `The background chat answer did not complete successfully: ${result.error ?? "unknown error"}.`,
    "Apologize briefly and say you're retrying or ask for one short clarification if needed.",
    "Do not claim anything is in the chat.",
  ].join(" ");
}

function stripMarkdownForSpeech(text: string) {
  return cleanAssistantText(text)
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^\|/.test(trimmed)) return false;
      if (/^[-:|\s]+$/.test(trimmed)) return false;
      if (/^\s*#{1,6}\s*$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(ARTIFACT_MARKER_RE, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkForSpeech(text: string, maxWords = 260) {
  const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (wordCount(sentence) > maxWords) {
      flush();
      const words = sentence.match(/\S+/g) ?? [];
      for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(" "));
      }
      continue;
    }
    if (current && wordCount(current) + wordCount(sentence) > maxWords) flush();
    current += sentence;
  }
  flush();
  return chunks;
}

function looksLikeReadAloudRequest(text: string) {
  return /\b(read|say|speak|tell)\b[\s\S]{0,50}\b(it|that|this|answer|response|message|out loud|aloud)\b/i.test(text) ||
    /\b(read it|read that|read this|read the answer|read the response|say it out loud|speak it)\b/i.test(text);
}

function cleanThreadTitle(title: string) {
  const cleaned = cleanAssistantText(title);
  return !cleaned || /Alex|personal assistant/i.test(title) ? "New conversation" : cleaned;
}

function groupThreadsByDate<T extends { updated_at: string }>(items: T[]): Array<{ label: string; items: T[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOf7 = startOfToday - 7 * 24 * 60 * 60 * 1000;
  const startOf30 = startOfToday - 30 * 24 * 60 * 60 * 1000;
  const buckets: Record<string, T[]> = { Today: [], Yesterday: [], "Previous 7 days": [], "Previous 30 days": [], Older: [] };
  for (const it of items) {
    const t = new Date(it.updated_at).getTime();
    if (t >= startOfToday) buckets.Today.push(it);
    else if (t >= startOfYesterday) buckets.Yesterday.push(it);
    else if (t >= startOf7) buckets["Previous 7 days"].push(it);
    else if (t >= startOf30) buckets["Previous 30 days"].push(it);
    else buckets.Older.push(it);
  }
  return Object.entries(buckets)
    .filter(([, arr]) => arr.length > 0)
    .map(([label, arr]) => ({ label, items: arr }));
}

function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      title={copied ? "Copied" : "Copy"}
      className={`inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition ${className}`}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function FeedbackButtons({ messageId }: { messageId: string }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(next: "up" | "down") {
    if (saving) return;
    setSaving(true);
    const note =
      next === "down"
        ? window.prompt("What was wrong? (optional — helps BPA Bot learn)") ?? ""
        : "";
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    const { error } = await supabase.from("message_feedback").upsert(
      {
        user_id: user.id,
        message_id: messageId,
        rating: next,
        note: note.trim() || null,
      },
      { onConflict: "user_id,message_id" },
    );
    if (!error) setRating(next);
    setSaving(false);
  }
  return (
    <>
      <button
        type="button"
        onClick={() => submit("up")}
        title="Helpful"
        className={`inline-flex items-center text-xs transition px-1.5 py-1 rounded hover:text-foreground ${
          rating === "up" ? "text-primary" : "text-muted-foreground"
        }`}
      >
        <ThumbsUp size={12} />
      </button>
      <button
        type="button"
        onClick={() => submit("down")}
        title="Not helpful"
        className={`inline-flex items-center text-xs transition px-1.5 py-1 rounded hover:text-foreground ${
          rating === "down" ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        <ThumbsDown size={12} />
      </button>
    </>
  );
}

type SearchData = {
  threads: Array<{ id: string; title: string; updated_at: string }>;
  messages: Array<{ id: string; thread_id: string; role: string; snippet: string; created_at: string }>;
};

function SearchResults({
  data,
  activeId,
  onPick,
}: {
  data: SearchData;
  activeId: string;
  onPick: () => void;
}) {
  const hasAny = data.threads.length > 0 || data.messages.length > 0;
  if (!hasAny) {
    return <div className="text-xs text-muted-foreground px-2 py-3">No matches</div>;
  }
  return (
    <div className="space-y-3">
      {data.threads.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 mb-1">Chats</div>
          {data.threads.map((t) => (
            <Link
              key={t.id}
              to="/chat/$threadId"
              params={{ threadId: t.id }}
              onClick={onPick}
              className={`block truncate px-2 py-1.5 rounded-md text-sm ${
                t.id === activeId ? "bg-secondary text-foreground" : "hover:bg-secondary/60 text-muted-foreground"
              }`}
            >
              {cleanThreadTitle(t.title)}
            </Link>
          ))}
        </div>
      )}
      {data.messages.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 mb-1">Messages</div>
          {data.messages.map((m) => (
            <Link
              key={m.id}
              to="/chat/$threadId"
              params={{ threadId: m.thread_id }}
              onClick={onPick}
              className="block px-2 py-1.5 rounded-md text-xs hover:bg-secondary/60 text-muted-foreground"
            >
              <div className="text-[10px] uppercase tracking-wide opacity-70">{m.role}</div>
              <div className="line-clamp-2">{m.snippet}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  ssr: false,
  head: () => ({ meta: [{ title: "BPA Bot" }] }),
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = useParams({ from: "/_authenticated/chat/$threadId" });
  return <ThreadView key={threadId} threadId={threadId} />;
}

function ThreadView({ threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const del = useServerFn(deleteThread);
  const getMsgs = useServerFn(getThreadMessages);
  const add = useServerFn(addMessage);
  const rename = useServerFn(renameThread);
  const createVoiceSession = useServerFn(createRealtimeSession);
  const logUsage = useServerFn(logVoiceUsage);
  const vScrape = useServerFn(voiceWebScrape);
  const vProducts = useServerFn(voiceProductSearch);
  const vKb = useServerFn(voiceKnowledgeSearch);
  const vRecall = useServerFn(voiceRecallFacts);
  const vRemember = useServerFn(voiceRememberFact);
  const vLesson = useServerFn(voiceSaveLesson);
  const createUploadUrl = useServerFn(createChatUploadUrl);
  const searchFn = useServerFn(searchChats);

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });
  const messagesQ = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getMsgs({ data: { threadId } }),
  });
  const contactsQ = useQuery({
    queryKey: ["contacts-for-voice"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("name,email,notes")
        .order("name", { ascending: true })
        .limit(100);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const [input, setInput] = useState("");
  const [webSearchOn, setWebSearchOn] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string>("");
  const [pendingActivity, setPendingActivity] = useState<ToolActivity[]>([]);
  type Attachment = { path: string; name: string; mimeType: string; size: number };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirror attachments in a ref so the voice onMessage closure (registered
  // once with the realtime hook) can read the latest pending uploads and
  // attach them to the voice-driven user turn.
  const attachmentsRef = useRef<Attachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  const [chatSearch, setChatSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(chatSearch.trim()), 250);
    return () => clearTimeout(t);
  }, [chatSearch]);
  const searchResults = useQuery({
    queryKey: ["chat-search", debouncedSearch],
    queryFn: () => searchFn({ data: { query: debouncedSearch } }),
    enabled: debouncedSearch.length > 0,
  });
  const [voiceUiState, setVoiceUiState] = useState<VoiceUiState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const pendingContextRef = useRef<string>("");
  const conversationRef = useRef<ReturnType<typeof useRealtimeVoice> | null>(null);
  const seenVoiceEventsRef = useRef<Set<string>>(new Set());
  const voiceStateRef = useRef<VoiceUiState>("idle");
  const startAttemptRef = useRef(0);
  const connectTimeoutRef = useRef<number | null>(null);
  const hasConnectedVoiceRef = useRef(false);
  const voiceUserHasSpokenRef = useRef(false);
  const lastUserSpeechAtRef = useRef<number>(0);
  const lastVoiceUserTextRef = useRef<string>("");
  const idleTimerRef = useRef<number | null>(null);
  const liveAssistantRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  // Speculative deep-research prefetch: kicks off the /api/chat pipeline the
  // moment the user's spoken transcript arrives if it looks research-y, so
  // that by the time the voice model decides to call deep_answer the work
  // is already streaming (or done). Massive perceived-latency win.
  const deepAnswerInFlightRef = useRef<{
    query: string;
    key: string;
    promise: Promise<{ ok?: boolean; error?: string; note?: string; answer?: string }>;
    abort: AbortController;
  } | null>(null);
  // Query text of the most recently COMPLETED deep_answer run. If the model
  // calls deep_answer again with the same query (common: user says "I don't
  // see it" and the model retries), we short-circuit instead of re-running
  // the whole /api/chat pipeline and posting a duplicate answer.
  const lastDeepAnswerQueryRef = useRef<string>("");
  const lastDeepAnswerCompletedAtRef = useRef<number>(0);
  const lastDeepAnswerTextRef = useRef<string>("");
  const lastVoiceUserAtRef = useRef<number>(0);
  const suppressNextVoiceAssistantRef = useRef(false);
  const readAloudAbortRef = useRef<AbortController | null>(null);
  const readAloudAudioRef = useRef<AudioContext | null>(null);
  const readAloudSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = () => setExportOpen(false);
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [exportOpen]);

  const messages = messagesQ.data ?? [];
  // (Voice usage is billed via OpenAI Realtime tokens — no separate quota UI.)

  function scrollToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    // Find the last actual message bubble inside the scroll container and
    // bring it into view at the bottom edge of that container only.
    const bubbles = el.querySelectorAll<HTMLElement>(":scope > div:not([aria-hidden])");
    const last = bubbles[bubbles.length - 1];
    const target = last ? last.offsetTop + last.offsetHeight - el.clientHeight + 16 : el.scrollHeight;
    el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    setShowScrollDown(false);
  }

  useEffect(() => {
    scrollToLatest();
  }, [messages.length, pendingAssistant, pendingUser]);

  // Kick off the full deep-research pipeline. Streams into the pending
  // assistant bubble immediately so the user sees "Researching…" and live
  // progress rather than silence. Returns a serialisable result for the
  // realtime tool call.
  const startDeepAnswer = useCallback(
    async (
      query: string,
      signal?: AbortSignal,
    ): Promise<{ ok?: boolean; error?: string; note?: string; answer?: string }> => {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return { error: "not signed in" };
      try {
        setPendingActivity([]);
        setPendingAssistant("🔍 Researching your question — pulling live sources and building the full answer now. I’ll speak once it’s actually in the chat.");
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ threadId, content: query, skipUserInsert: true }),
          signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          setPendingAssistant("");
          setPendingActivity([]);
          return { error: `deep answer failed: ${errText.slice(0, 200)}` };
        }
        let acc = "";
        const reader = res.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let buf = "";
          let inCtrl = false;
          let activity: ToolActivity[] = [];
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (signal?.aborted) {
              try { await reader.cancel(); } catch { /* noop */ }
              setPendingAssistant("");
              setPendingActivity([]);
              return { error: "cancelled by newer user turn" };
            }
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            while (true) {
              const idx = buf.indexOf(TOOL_FRAME_DELIM);
              if (idx === -1) break;
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              if (!inCtrl) {
                if (chunk) acc += chunk;
              } else {
                try {
                  const ev = JSON.parse(chunk) as ToolEvent;
                  activity = foldToolEvent(activity, ev);
                  setPendingActivity(activity);
                } catch {
                  // ignore malformed frame
                }
              }
              inCtrl = !inCtrl;
            }
            if (!inCtrl && buf) {
              acc += buf;
              buf = "";
            }
            setPendingAssistant(cleanAssistantText(acc));
          }
        }
        await qc.invalidateQueries({ queryKey: ["messages", threadId] });
        await qc.invalidateQueries({ queryKey: ["threads"] });
        setPendingAssistant("");
        setPendingActivity([]);
        lastDeepAnswerQueryRef.current = normalizeVoiceQuery(query);
        lastDeepAnswerCompletedAtRef.current = Date.now();
        lastDeepAnswerTextRef.current = acc;
        return {
          ok: true,
          answer: acc,
          note: "The full researched answer is now posted and visible in the chat. Read the substance aloud in natural conversational voice (top pick + why, runners-up by name, key numbers/tradeoffs) — do NOT just say 'check the chat', and do NOT post another chat message.",
        };
      } catch (err) {
        setPendingAssistant("");
        setPendingActivity([]);
        if (err instanceof Error && err.name === "AbortError") {
          return { error: "cancelled by newer user turn" };
        }
        const msg = err instanceof Error ? err.message : "deep answer failed";
        return { error: msg };
      }
    },
    [threadId, qc],
  );

  const stopReadAloud = useCallback(() => {
    readAloudAbortRef.current?.abort();
    readAloudAbortRef.current = null;
    readAloudSourcesRef.current.forEach((source) => {
      try { source.stop(); } catch { /* already stopped */ }
    });
    readAloudSourcesRef.current.clear();
  }, []);

  const streamVoiceReadout = useCallback(async (rawText: string) => {
    const spokenText = stripMarkdownForSpeech(rawText);
    if (!spokenText) return;
    stopReadAloud();
    const controller = new AbortController();
    readAloudAbortRef.current = controller;
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) throw new Error("not signed in");

    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error("Audio playback is not supported in this browser");
    const audioCtx = readAloudAudioRef.current ?? new AudioContextCtor({ sampleRate: 24000 });
    readAloudAudioRef.current = audioCtx;
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});

    let playhead = 0;
    let pending = new Uint8Array(0);
    const playPcm = (incoming: Uint8Array) => {
      const bytes = new Uint8Array(pending.length + incoming.length);
      bytes.set(pending);
      bytes.set(incoming, pending.length);
      const usable = bytes.length - (bytes.length % 2);
      pending = bytes.slice(usable);
      if (usable === 0) return;
      const samples = new Int16Array(bytes.buffer.slice(0, usable));
      const floats = Float32Array.from(samples, (sample) => sample / 32768);
      const buffer = audioCtx.createBuffer(1, floats.length, 24000);
      buffer.copyToChannel(floats, 0);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      readAloudSourcesRef.current.add(source);
      source.onended = () => readAloudSourcesRef.current.delete(source);
      playhead = playhead === 0 ? audioCtx.currentTime + 0.05 : Math.max(playhead, audioCtx.currentTime);
      source.start(playhead);
      playhead += buffer.duration;
    };

    const parseSseBlock = (block: string) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return;
      let payload: { type?: string; audio?: string };
      try { payload = JSON.parse(data); } catch { return; }
      if (payload.type !== "speech.audio.delta" || !payload.audio) return;
      const binary = atob(payload.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      playPcm(bytes);
    };

    for (const chunk of chunkForSpeech(spokenText)) {
      if (controller.signal.aborted) return;
      const res = await fetch("/api/voice-readout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: chunk }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`read-aloud failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        blocks.forEach(parseSseBlock);
      }
      if (buffer.trim()) parseSseBlock(buffer);
    }
  }, [stopReadAloud]);

  const speakDeepAnswerResult = useCallback((result: { ok?: boolean; error?: string; note?: string; answer?: string }) => {
    const answer = result.answer?.trim() || lastDeepAnswerTextRef.current.trim();
    if (result.ok && answer) {
      streamVoiceReadout(answer).catch((err) => {
        console.warn("voice readout failed; falling back to realtime", err);
        suppressNextVoiceAssistantRef.current = true;
        conversationRef.current?.createResponse(voiceFollowupInstructions({ ...result, answer }));
      });
      return;
    }
    suppressNextVoiceAssistantRef.current = true;
    conversationRef.current?.createResponse(voiceFollowupInstructions(result));
  }, [streamVoiceReadout]);

  // Heuristic: does this spoken turn deserve the full research pipeline?
  // Keep it broad — false positives just do extra work quietly in the
  // background, while false negatives are what the user is complaining
  // about (voice claims "in chat", nothing there for 10s).
  const RESEARCH_QUERY_RE =
    /\b(best|top|compare|comparison|vs\.?|versus|options?|recommend|recommendation|which|what('?s| is)|find|list|show me|research|deep dive|breakdown|guide|how to|how do i|near|nearby|around|in|outside|cheapest|highest[- ]rated|top[- ]rated|reviews?|price|pricing|cost)\b/i;
  function looksLikeResearchQuery(text: string): boolean {
    const t = text.trim();
    if (t.length < 12) return false;
    return RESEARCH_QUERY_RE.test(t);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollDown(distance > 40);
    };
    onScroll();
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    const id = window.setInterval(onScroll, 500);
    el.addEventListener("scroll", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.clearInterval(id);
    };
  }, [messages.length]);

  // Guard against an ElevenLabs SDK bug where malformed error events throw
  // `undefined is not an object (evaluating 'event.error_event.error_type')`
  // as an unhandled rejection.
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const msg = String((e.reason as { message?: string })?.message ?? e.reason ?? "");
      if (msg.includes("error_event") || msg.includes("error_type")) {
        e.preventDefault();
        console.warn("Suppressed voice malformed error event:", msg);
      }
    };
    window.addEventListener("unhandledrejection", handler);
    return () => {
      window.removeEventListener("unhandledrejection", handler);
      voiceStateRef.current = "idle";
      clearVoiceConnectTimeout();
      try {
        conversationRef.current?.endSession();
      } catch (err) {
        console.warn("voice cleanup failed", err);
      }
    };
  }, []);

  const conversation = useRealtimeVoice({
    toolDefs: REALTIME_TOOL_DEFS,
    createSession: ({ instructions, tools }) =>
      createVoiceSession({ data: { instructions, tools } }),
    onUsage: (u) => {
      // Fire-and-forget: log per-turn realtime token usage for the spend dashboard.
      logUsage({ data: u }).catch((err) => console.warn("logVoiceUsage failed", err));
    },
    clientTools: {
      deep_answer: async () => {
        const latestUserMessage =
          lastVoiceUserTextRef.current ||
          [...(messagesQ.data ?? [])].reverse().find((m) => m.role === "user")?.content?.trim() ||
          "";
        if (!latestUserMessage) return { error: "no user message available" };
        const latestKey = normalizeVoiceQuery(latestUserMessage);
        // Reuse the speculative prefetch if it matches — this is the whole
        // point: by the time the model calls deep_answer, the answer is
        // usually already streaming into the chat.
        const inflight = deepAnswerInFlightRef.current;
        if (inflight && inflight.key === latestKey) {
          const result = await inflight.promise;
          speakDeepAnswerResult(result);
          return { ...result, shown_to_user: true };
        }
        // Dedupe: if this exact query was JUST completed (e.g. the model
        // heard "I don't see it" and is retrying), don't run the whole
        // pipeline again — the answer is already in chat.
        if (lastDeepAnswerQueryRef.current === latestKey) {
          const result = {
            ok: true,
            answer: lastDeepAnswerTextRef.current,
            note: "The researched answer for this exact question is already in the chat from a moment ago — read it aloud now. Do NOT run again and do NOT post another chat message.",
          };
          speakDeepAnswerResult(result);
          return { ...result, shown_to_user: true };
        }
        const abort = new AbortController();
        const promise = startDeepAnswer(latestUserMessage, abort.signal);
        deepAnswerInFlightRef.current = { query: latestUserMessage, key: latestKey, promise, abort };
        const result = await promise;
        if (deepAnswerInFlightRef.current?.key === latestKey) {
          deepAnswerInFlightRef.current = null;
        }
        speakDeepAnswerResult(result);
        return { ...result, shown_to_user: true };
      },
      show_in_chat: async (params) => {
        const md = String((params as { markdown?: string; content?: string }).markdown ?? (params as { content?: string }).content ?? "").trim();
        if (!md) return JSON.stringify({ error: "markdown required" });
        try {
          setPendingAssistant(md);
          liveAssistantRef.current = md;
          await add({ data: { threadId, role: "assistant", content: md } });
          await qc.invalidateQueries({ queryKey: ["messages", threadId] });
          setPendingAssistant("");
          liveAssistantRef.current = "";
          return JSON.stringify({ ok: true });
        } catch (err) {
          console.warn("show_in_chat failed", err);
          return JSON.stringify({ error: "failed to render" });
        }
      },
      web_search: async (params) => {
        const p = params as { query?: string; limit?: number };
        const query = p.query?.trim();
        if (!query) return JSON.stringify({ error: "query required" });

        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        const res = await fetch("/api/public/web-search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query, limit: p.limit ?? 5 }),
        });
        const data = await res.json().catch(() => ({ error: "search failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "search failed" });
        return JSON.stringify(data);
      },
      send_email: async (params) => {
        const p = params as { to?: string; subject?: string; body?: string; cc?: string; attach_last_document?: boolean };
        if (!p.to || !p.subject || !p.body) {
          return JSON.stringify({ error: "to, subject and body are required" });
        }
        if (looksLikeCalendarInviteText(`${p.subject}\n${p.body}`) || (p.attach_last_document && looksLikeCalendarInviteText(p.subject))) {
          return JSON.stringify({
            error:
              "This looks like a calendar/Teams invite. Use create_calendar_event so Outlook sends a real invite with accept/decline and a Teams link.",
          });
        }
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        let attachment: { filename: string; mimeType: string; contentBase64: string } | undefined;
        if (p.attach_last_document) {
          const art = getLatestArtifact();
          if (!art) {
            return JSON.stringify({ error: "no document to attach — generate one first" });
          }
          attachment = { filename: art.filename, mimeType: art.mimeType, contentBase64: art.base64 };
        }
        const res = await fetch("/api/public/jarvis/tools/send_email", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            to: p.to,
            subject: p.subject,
            body: p.body,
            cc: p.cc,
            ...(attachment ? { attachment } : {}),
          }),
        });
        const data = await res.json().catch(() => ({ error: "send failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "send failed" });
        return JSON.stringify(data);
      },
      list_contacts: async () => {
        const { data, error } = await supabase
          .from("contacts")
          .select("id,name,email,notes")
          .order("name", { ascending: true });
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify({ contacts: data ?? [] });
      },
      create_calendar_event: async (params) => {
        const p = params as {
          title?: string;
          start?: string;
          end?: string;
          description?: string;
          location?: string;
          attendees?: string[];
          timezone?: string;
          online_meeting?: boolean;
        };
        if (!p.title || !p.start || !p.end) {
          return JSON.stringify({ error: "title, start and end are required" });
        }
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        const res = await fetch("/api/public/jarvis/tools/create_calendar_event", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            title: p.title,
            start: p.start,
            end: p.end,
            description: p.description,
            location: p.location,
            attendees: p.attendees,
            timezone: p.timezone,
            online_meeting: p.online_meeting ?? true,
          }),
        });
        const data = await res.json().catch(() => ({ error: "calendar create failed" }));
        const providerLabel = "Outlook";
        const meetingLabel = "Teams";
        const assistantMessage = !res.ok
          ? `I tried to create the real calendar invite, but ${providerLabel} returned: ${data?.error ?? "calendar create failed"}${data?.detail ? `\n\n${data.detail}` : ""}`
          : [
              `Done — I created **${p.title}** on your ${providerLabel}.`,
              Array.isArray(data?.attendees) && data.attendees.length > 0
                ? `Calendar invites were sent to: ${data.attendees.join(", ")}.`
                : "No attendees were included, so no invite emails were sent.",
              data?.teams_join_url
                ? `${meetingLabel} link: ${data.teams_join_url}`
                : data?.teams_unavailable_reason ??
                  `${providerLabel} created the event, but Microsoft did not create a Teams link for this account.`,
              data?.link ? `${providerLabel} event: ${data.link}` : "",
            ]
              .filter(Boolean)
              .join("\n\n");
        try {
          setPendingAssistant(assistantMessage);
          liveAssistantRef.current = assistantMessage;
          await add({ data: { threadId, role: "assistant", content: assistantMessage } });
          await qc.invalidateQueries({ queryKey: ["messages", threadId] });
          await qc.invalidateQueries({ queryKey: ["threads"] });
          setPendingAssistant("");
          liveAssistantRef.current = "";
          conversationRef.current?.cancelResponse();
        } catch (err) {
          console.warn("calendar confirmation persist failed", err);
        }
        if (!res.ok) return { error: data?.error ?? "calendar create failed", detail: data?.detail, shown_to_user: true };
        return { ...data, shown_to_user: true, final_message: assistantMessage };
      },
      list_calendar_events: async (params) => {
        const p = params as { days?: number; max_results?: number; start?: string; end?: string };
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        const res = await fetch("/api/public/jarvis/tools/list_calendar_events", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ days: p.days, max_results: p.max_results, start: p.start, end: p.end }),
        });
        const data = await res.json().catch(() => ({ error: "calendar read failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "calendar read failed", detail: data?.detail });
        return JSON.stringify(data);
      },
      cancel_calendar_event: async (params) => {
        const p = params as { event_id?: string; comment?: string };
        if (!p.event_id) return JSON.stringify({ error: "event_id required" });
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        const res = await fetch("/api/public/jarvis/tools/cancel_calendar_event", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ event_id: p.event_id, comment: p.comment }),
        });
        const data = await res.json().catch(() => ({ error: "calendar cancel failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "calendar cancel failed", detail: data?.detail });
        return JSON.stringify(data);
      },
      respond_calendar_event: async (params) => {
        const p = params as { event_id?: string; response?: "accept" | "tentative" | "decline"; comment?: string; send_response?: boolean };
        if (!p.event_id || !p.response) return JSON.stringify({ error: "event_id and response required" });
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        const res = await fetch("/api/public/jarvis/tools/respond_calendar_event", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ event_id: p.event_id, response: p.response, comment: p.comment, send_response: p.send_response }),
        });
        const data = await res.json().catch(() => ({ error: "calendar response failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "calendar response failed", detail: data?.detail });
        return JSON.stringify(data);
      },
      generate_document: async (params) => {
        const p = params as {
          format?: string;
          title?: string;
          content?: string;
        };
        const format = (p.format ?? "pdf").toLowerCase();
        const title = (p.title ?? "BPA Bot document").slice(0, 80);
        const content = String(p.content ?? "").trim();
        const inviteLike = looksLikeCalendarInviteText(`${title}\n${content}`);
        if (inviteLike) {
          return JSON.stringify({
            error:
              "This is a calendar/Teams invite, not a document. Do not generate a placeholder file. Show the meeting draft if needed, then call create_calendar_event with online_meeting=true so Outlook sends the real invite and Teams link.",
          });
        }
        if (!content) return JSON.stringify({ error: "content required" });
        if (!["pdf", "docx", "xlsx", "csv"].includes(format)) {
          return JSON.stringify({ error: "format must be pdf, docx, xlsx or csv" });
        }
        try {
          // Use the SERVER-SIDE document generator (proper tables, headings,
          // page layout) instead of the lightweight client builder that dumps
          // raw markdown text.
          const safeBase = title.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "document";
          const gen = await generateAndStoreDocument({
            data: {
              format: format as "pdf" | "docx" | "xlsx" | "csv",
              filename: safeBase,
              title,
              markdown: content,
            },
          });
          const art = saveArtifact({
            filename: gen.filename,
            mimeType: gen.mimeType,
            base64: gen.base64,
            size: gen.size,
            formatLabel: gen.formatLabel,
          });
          const formatLabel = gen.formatLabel;

          // Post an assistant message with the artifact marker so the Bubble
          // renders a preview + download card next to the content.
          const previewSnippet = content.length > 600 ? `${content.slice(0, 600)}…` : content;
          const messageBody = `${previewSnippet}\n\n${artifactMarker(art.id)}`;
          setPendingAssistant(messageBody);
          liveAssistantRef.current = messageBody;
          await add({ data: { threadId, role: "assistant", content: messageBody } });
          await qc.invalidateQueries({ queryKey: ["messages", threadId] });
          setPendingAssistant("");
          liveAssistantRef.current = "";

          toast.success(`${formatLabel} ready in the chat`);
          return JSON.stringify({
            ok: true,
            format,
            title,
            filename: gen.filename,
            artifact_id: art.id,
            note: "File is previewed in the chat with Download and Email buttons. Did NOT auto-download.",
          });
        } catch (err) {
          console.warn("generate_document failed", err);
          return JSON.stringify({ error: err instanceof Error ? err.message : "generate failed" });
        }
      },
      web_scrape: async (params) => {
        const p = params as { url?: string };
        if (!p.url) return JSON.stringify({ error: "url required" });
        try {
          const r = await vScrape({ data: { url: p.url } });
          return JSON.stringify(r);
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "scrape failed" });
        }
      },
      product_search: async (params) => {
        const p = params as { query?: string; limit?: number };
        if (!p.query) return JSON.stringify({ error: "query required" });
        try {
          const r = await vProducts({ data: { query: p.query, limit: p.limit } });
          return JSON.stringify(r);
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "product search failed" });
        }
      },
      search_knowledge_base: async (params) => {
        const p = params as { query?: string; limit?: number };
        if (!p.query) return JSON.stringify({ error: "query required" });
        try {
          const r = await vKb({ data: { query: p.query, limit: p.limit } });
          return JSON.stringify(r);
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "kb search failed" });
        }
      },
      recall_facts: async () => {
        try {
          const r = await vRecall({});
          return JSON.stringify(r);
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "recall failed" });
        }
      },
      remember_fact: async (params) => {
        const p = params as { key?: string; value?: string };
        if (!p.key || !p.value) return JSON.stringify({ error: "key and value required" });
        try {
          const r = await vRemember({ data: { key: p.key, value: p.value } });
          return JSON.stringify(r);
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "remember failed" });
        }
      },
      save_lesson: async (params) => {
        const p = params as { lesson?: string; context?: string };
        if (!p.lesson) return JSON.stringify({ error: "lesson required" });
        try {
          const r = await vLesson({ data: { lesson: p.lesson, context: p.context } });
          return JSON.stringify(r);
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "lesson failed" });
        }
      },
    },
    onAssistantDelta: (part) => {
      // Stream assistant transcript in real time as OpenAI Realtime generates it.
      const kind = part.kind;
      const chunk = part.text;
      if (kind === "start") {
        liveAssistantRef.current = chunk;
      } else if (kind === "delta") {
        liveAssistantRef.current += chunk;
      } else if (kind === "stop") {
        if (chunk) liveAssistantRef.current += chunk;
      }
      setPendingAssistant(cleanAssistantText(liveAssistantRef.current));
    },
    onConnect: () => {
      clearVoiceConnectTimeout();
      hasConnectedVoiceRef.current = true;
      voiceStateRef.current = "connected";
      setVoiceUiState("connected");
      setVoiceError(null);
      // Instructions were already sent inside session.update on data-channel open.
      pendingContextRef.current = "";
    },
    onDisconnect: (details) => {
      clearVoiceConnectTimeout();
      if (idleTimerRef.current) { window.clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
      const wasStopping = voiceStateRef.current === "stopping";
      voiceStateRef.current = "idle";
      setVoiceUiState("idle");
      pendingContextRef.current = "";
      if (wasStopping) return;
      const closeText = details?.message ?? "";
      // Browsers only show microphone prompts reliably from a direct user tap.
      // Do not silently restart voice after disconnects; ask the user to tap again.
      voiceUserHasSpokenRef.current = false;
      if (hasConnectedVoiceRef.current || details?.reason === "error") {
        setVoiceError(closeText || "Voice disconnected. Tap the mic once to reconnect.");
      }
    },
    onError: (e: string) => {
      const msg = String(e || "");
      console.warn("voice error", msg);
      clearVoiceConnectTimeout();
      voiceStateRef.current = "idle";
      setVoiceUiState("idle");
      voiceUserHasSpokenRef.current = false;
      setVoiceError(msg || "Voice failed to connect. Tap the mic once to try again.");
    },
    onMessage: async (message) => {
      const text = message?.message;
      if (!text) {
        // Filtered / empty final transcript → clear the in-progress
        // "listening…" bubble so the UI never freezes on the last partial.
        if (message?.source === "user" && message.isFinal) {
          setPendingUser(null);
        }
        return;
      }
      if (message.source === "user" && message.isFinal === false) {
        voiceUserHasSpokenRef.current = true;
        lastUserSpeechAtRef.current = Date.now();
        lastVoiceUserTextRef.current = text;
        stopReadAloud();
        try { conversationRef.current?.cancelResponse(); } catch { /* noop */ }
        setPendingUser(text);
        return;
      }
      const eventKey = `${message.source}:${message.event_id ?? text}`;
      if (seenVoiceEventsRef.current.has(eventKey)) return;
      seenVoiceEventsRef.current.add(eventKey);
      if (seenVoiceEventsRef.current.size > 250) {
        seenVoiceEventsRef.current = new Set(Array.from(seenVoiceEventsRef.current).slice(-120));
      }
      try {
        if (message.source === "user") {
          voiceUserHasSpokenRef.current = true;
          lastUserSpeechAtRef.current = Date.now();
          // STT ghost filter: bare single-word farewells/greetings
          // ("Bye.", "Hi.", "OK.", "Thanks.") that arrive within 3s of
          // another user turn are almost always STT hallucinations from
          // non-speech audio. Drop them so the model doesn't reply
          // "Bye — reach out anytime" in the middle of a real question.
          const now = Date.now();
          const trimmed = text.trim();
          const isBareFiller = /^(bye|hi|hey|ok|okay|thanks|thank you|yes|no|uh|um|mm|hm+)[.!?]?$/i.test(trimmed);
          const veryClose = now - lastVoiceUserAtRef.current < 3000;
          if (isBareFiller && veryClose) {
            setPendingUser(null);
            return;
          }
          lastVoiceUserAtRef.current = now;
          // Any new user turn cancels an in-flight prefetch — the user
          // changed topics, so posting the stale answer would be worse
          // than nothing.
          if (deepAnswerInFlightRef.current) {
            try { deepAnswerInFlightRef.current.abort.abort(); } catch { /* noop */ }
            deepAnswerInFlightRef.current = null;
          }
          stopReadAloud();
          // Preempt any in-flight assistant response the moment a new user
          // turn arrives. Realtime VAD sometimes lets the model keep
          // generating a reply to the PREVIOUS turn ("Got it, what's next?")
          // for a beat after the user has already asked something new,
          // producing a stale spoken/typed answer that lands out of order.
          // Cancelling here guarantees the next createResponse binds to the
          // fresh user turn.
          try { conversationRef.current?.cancelResponse(); } catch { /* noop */ }
          suppressNextVoiceAssistantRef.current = false;
          setPendingAssistant("");
          liveAssistantRef.current = "";
          lastVoiceUserTextRef.current = text;
          // Reset 90s idle auto-stop on every user utterance.
          if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
          idleTimerRef.current = window.setTimeout(() => {
            if (voiceStateRef.current === "connected") {
              setVoiceError("Voice paused after 90s of silence. Tap the mic to resume.");
              try { conversationRef.current?.endSession(); } catch (err) { console.warn(err); }
            }
          }, 90_000);
          try { conversationRef.current?.setVolume({ volume: 1 }); } catch (err) { console.warn(err); }
          // Live update: show the user's spoken turn immediately.
          setPendingUser(text);
          // Attach any files the user uploaded while voice was active so they
          // render as clickable previews on the user's transcript bubble,
          // just like in chat mode. Clear the composer chips after sending.
          const pendingFiles = attachmentsRef.current;
          if (pendingFiles.length > 0) {
            setAttachments([]);
            attachmentsRef.current = [];
          }
          await add({
            data: {
              threadId,
              role: "user",
              content: text,
              ...(pendingFiles.length > 0 ? { attachments: pendingFiles } : {}),
            },
          });
          await qc.invalidateQueries({ queryKey: ["messages", threadId] });
          setPendingUser(null);
          if (looksLikeReadAloudRequest(text) && lastDeepAnswerTextRef.current.trim()) {
            streamVoiceReadout(lastDeepAnswerTextRef.current).catch((err) => {
              console.warn("manual read-aloud failed", err);
              toast.error("Read-aloud failed. I can try again if you ask me to read it.");
            });
            return;
          }
          // Speculative prefetch: if this looks like a research/list/compare
          // question, start the full deep-answer pipeline NOW in parallel
          // with the realtime model's tool-calling decision. When the model
          // then calls deep_answer, it awaits this same promise instead of
          // firing a second request.
          if (looksLikeResearchQuery(text) && !deepAnswerInFlightRef.current) {
            const textKey = normalizeVoiceQuery(text);
            const abort = new AbortController();
            const promise = startDeepAnswer(text, abort.signal);
            deepAnswerInFlightRef.current = { query: text, key: textKey, promise, abort };
            promise.then((result) => {
              if (lastVoiceUserTextRef.current && normalizeVoiceQuery(lastVoiceUserTextRef.current) !== textKey) return;
              speakDeepAnswerResult(result);
            }).catch((err) => {
              speakDeepAnswerResult({
                error: err instanceof Error ? err.message : "background answer failed",
              });
            });
            promise.finally(() => {
              window.setTimeout(() => {
                if (deepAnswerInFlightRef.current?.key === textKey) {
                  deepAnswerInFlightRef.current = null;
                }
              }, 2000);
            });
          } else {
            conversationRef.current?.createResponse();
          }
        } else if (message.source === "ai") {
          const cleaned = cleanAssistantText(text);
          const shouldSuppressVoiceFollowup = suppressNextVoiceAssistantRef.current &&
            (isVoiceChatPointer(cleaned) || cleaned.length < 240);
          if (shouldSuppressVoiceFollowup) {
            suppressNextVoiceAssistantRef.current = false;
            setPendingAssistant("");
            liveAssistantRef.current = "";
            return;
          }
          suppressNextVoiceAssistantRef.current = false;
          // Live update: show assistant turn the moment the transcript arrives.
          setPendingAssistant(cleaned);
          liveAssistantRef.current = cleaned;
          await add({ data: { threadId, role: "assistant", content: cleaned } });
          await qc.invalidateQueries({ queryKey: ["messages", threadId] });
          setPendingAssistant("");
          liveAssistantRef.current = "";
          const t = threads.data?.find((x) => x.id === threadId);
          if (t && t.title === "New conversation") {
            const title = text.slice(0, 48).replace(/\s+/g, " ").trim();
            await rename({ data: { id: threadId, title } });
          }
        }
        qc.invalidateQueries({ queryKey: ["threads"] });
      } catch (err) {
        console.warn("Failed to persist voice message", err);
      }
    },
  });

  const isConnected = conversation.status === "connected";
  conversationRef.current = conversation;

  function setVoiceState(next: VoiceUiState) {
    voiceStateRef.current = next;
    setVoiceUiState(next);
  }

  function clearVoiceConnectTimeout() {
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }

  function buildVoiceContext() {
    const MAX_CHARS = 12000;
    const recent = (messages ?? []).slice(-100).map(
      (m) => `${m.role === "user" ? "User" : "BPA Bot"}: ${m.role === "assistant" ? cleanAssistantText(m.content) : m.content}`,
    );
    let total = 0;
    const kept: string[] = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const line = recent[i];
      if (total + line.length + 1 > MAX_CHARS) break;
      kept.unshift(line);
      total += line.length + 1;
    }
    const history = kept.join("\n");
    const rules = [
      "Behavioral rules for this session:",
      "- Do not greet or introduce yourself again.",
      "- TABLES / LONG STRUCTURED CONTENT: call the show_in_chat tool with the full Markdown table. Do NOT read the table aloud. After the tool returns, say one short spoken sentence (e.g. \"Here's the table.\").",
      "- FACTS: for any real company, person, address, price, phone number, or current event, call web_search FIRST. Never invent details.",
      "- CALENDAR MEETINGS COME FIRST: if the user asks to book, schedule, create, or send a calendar invite / meeting invite / Outlook invite / Teams meeting, this is NEVER a file/document task. Show a concise draft, wait for explicit approval, then CALL create_calendar_event. Microsoft Teams is default and Teams only; set online_meeting=true unless the user explicitly says no online meeting.",
      "- YOU CAN CREATE TEAMS MEETINGS: create_calendar_event creates the Outlook calendar invite and Microsoft Teams join link. Never say you cannot directly create the meeting inside Teams, never tell the user to open Teams, and never offer copy/paste meeting details instead.",
      "- CALENDAR MANAGEMENT: for what meetings do I have, availability, canceling, accepting, tentatively accepting, or declining meetings, use the calendar tools. If cancel/respond is ambiguous, list events first and confirm which one.",
      "- CONTACT NAMES FOR MEETINGS: saved contact names like Bill are valid attendees. Pass the contact name to create_calendar_event; the server resolves it to an email address.",
      "- FILE EXPORTS: if the user asks to create, generate, export, download, save, or convert to PDF, Word, DOCX, Excel, XLSX, or CSV, CALL the generate_document tool. This does NOT apply to calendar/meeting invites. Never say you cannot make a file. Never tell them to copy into Word or Google Docs.",
      "- CALENDAR MEETINGS: if the user asks to book, schedule, create, or send a calendar invite / meeting invite / Teams meeting, do NOT generate a document and do NOT use send_email. Show a concise draft, wait for explicit approval, then CALL create_calendar_event. Default to an online meeting; the server uses Microsoft Teams through Outlook.",
      "- EMAIL: before drafting any email, ALWAYS confirm the recipient's email address out loud (e.g. \"Just to confirm, send this to john@example.com?\") and wait for the user to confirm. Never guess or invent addresses.",
      "- EMAIL FORMATTING: always write emails in clean, professional Markdown — a proper greeting, short well-structured paragraphs, bullet lists or tables where helpful, and a sign-off. Never send a plain unformatted dump.",
      "- EMAIL APPROVAL: present a full draft (To, Subject, Body) and wait for explicit user approval (\"send it\", \"yes send\") before calling send_email.",
      "- Stay in the session. Do not end the conversation, say goodbye, or wind down even if the user is silent. Wait quietly for their next message.",
      "- INTERRUPTION: if the user starts speaking while you are talking, stop immediately mid-sentence and listen. Never talk over the user. Resume only after they finish.",
      "- BE CONCISE: keep spoken replies short and conversational. Avoid long monologues so the user can interject naturally.",
      "- NO REPETITION: do NOT re-ask for information the user already provided in this thread (names, emails, recipients, dates, preferences). Read the prior conversation above first; if a detail is there, use it directly.",
      "- REMEMBER WITHIN THE TURN: once the user confirms something (a recipient, a draft, a choice), do not ask again in the same task. Move forward.",
      "- ONE QUESTION AT A TIME: if you truly need missing info, ask only the single most important question, not a checklist.",
    ].join("\n");
    const contacts = (contactsQ.data ?? [])
      .map((contact) => `- ${contact.name}: ${contact.email}${contact.notes ? ` (${contact.notes})` : ""}`)
      .join("\n");
    const currentContext = `Current server time: ${new Date().toISOString()}\n${contacts ? `\nSaved contacts:\n${contacts}` : ""}`;
    return history
      ? `${currentContext}\n\nPrior conversation in this thread (most recent last):\n${history}\n\n${rules}\n\nContinue naturally from here.`
      : `${currentContext}\n\nVoice mode is open. Wait for the user's next message.\n\n${rules}`;
  }

  async function startVoice() {
    if (voiceStateRef.current === "starting" || voiceStateRef.current === "connected") return;
    const attemptId = startAttemptRef.current + 1;
    let microphoneStream: MediaStream | null = null;
    startAttemptRef.current = attemptId;
    hasConnectedVoiceRef.current = false;
    voiceUserHasSpokenRef.current = false;
    setVoiceState("starting");
    setVoiceError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone recording is not available in this browser.");
      }
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const instructions = `${VOICE_SESSION_PROMPT}\n\n${buildVoiceContext()}`;
      pendingContextRef.current = "";
      clearVoiceConnectTimeout();
      connectTimeoutRef.current = window.setTimeout(() => {
        if (startAttemptRef.current !== attemptId || voiceStateRef.current !== "starting") return;
        setVoiceState("idle");
        pendingContextRef.current = "";
        setVoiceError("Voice took too long to connect. Tap the mic once to try again.");
        try { conversationRef.current?.endSession(); } catch (err) { console.warn(err); }
      }, 32000);
      await conversation.startSession({
        instructions,
        microphoneStream,
      });
      microphoneStream = null;
    } catch (e) {
      stopMediaStream(microphoneStream);
      clearVoiceConnectTimeout();
      const raw = e instanceof Error ? `${e.name}: ${e.message}` : "Could not start voice";
      console.warn("startVoice failed", e);
      setVoiceState("idle");
      pendingContextRef.current = "";
      const message = voiceStartMessage(e);
      setVoiceError(message);
      if (/microphone access is blocked|permission is still being rejected/i.test(message)) {
        toast.error("Microphone blocked");
      } else {
        toast.error(raw.includes("Microphone") ? message : "Voice failed to connect");
      }
    }
  }

  async function stopVoice() {
    startAttemptRef.current += 1;
    clearVoiceConnectTimeout();
    stopReadAloud();
    setVoiceState("stopping");
    pendingContextRef.current = "";
    setVoiceError(null);
    try {
      await conversation.endSession();
    } catch (err) {
      console.warn("endSession failed", err);
    } finally {
      hasConnectedVoiceRef.current = false;
      voiceUserHasSpokenRef.current = false;
      setVoiceState("idle");
    }
  }

  const addMut = useMutation({
    mutationFn: async ({ content, files, regenerate, forceWebSearch }: { content: string; files: Attachment[]; regenerate?: boolean; forceWebSearch?: boolean }) => {
      if (!regenerate) setPendingUser(content);
      setPendingAssistant("");

      // If voice is connected, route through the realtime voice channel instead.
      if (isConnected && !regenerate) {
        voiceUserHasSpokenRef.current = true;
        lastVoiceUserTextRef.current = content;
        stopReadAloud();
        try { conversation.setVolume({ volume: 1 }); } catch (err) { console.warn(err); }
        await add({ data: { threadId, role: "user", content } });
        if (looksLikeReadAloudRequest(content) && lastDeepAnswerTextRef.current.trim()) {
          streamVoiceReadout(lastDeepAnswerTextRef.current).catch((err) => {
            console.warn("manual read-aloud failed", err);
            toast.error("Read-aloud failed. I can try again if you ask me to read it.");
          });
          setPendingUser(null);
          return;
        }
        if (looksLikeResearchQuery(content)) {
          const textKey = normalizeVoiceQuery(content);
          const abort = new AbortController();
          const promise = startDeepAnswer(content, abort.signal);
          deepAnswerInFlightRef.current = { query: content, key: textKey, promise, abort };
          conversation.sendUserMessage(content, { createResponse: false });
          promise.then((result) => {
            if (lastVoiceUserTextRef.current && normalizeVoiceQuery(lastVoiceUserTextRef.current) !== textKey) return;
            speakDeepAnswerResult(result);
          }).catch((err) => {
            speakDeepAnswerResult({
              error: err instanceof Error ? err.message : "background answer failed",
            });
          }).finally(() => {
            window.setTimeout(() => {
              if (deepAnswerInFlightRef.current?.key === textKey) deepAnswerInFlightRef.current = null;
            }, 2000);
          });
        } else {
          conversation.sendUserMessage(content);
        }
        setPendingUser(null);
        return;
      }

      // Text chat: stream from Lovable AI.
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Session expired. Please sign in again.");
        setPendingUser(null);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      let res: Response;
      try {
        res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId, content, attachments: files, regenerate, forceWebSearch }),
        signal: controller.signal,
      });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setPendingUser(null);
          setPendingAssistant("");
          qc.invalidateQueries({ queryKey: ["messages", threadId] });
          return;
        }
        throw err;
      }

      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => "");
        let msg = raw || "BPA Bot is unavailable";
        try {
          const j = JSON.parse(raw);
          if (j?.error) msg = j.error;
          if (j?.code === "SPEND_CAP_REACHED") msg = `${j.error} Head to Spend tracker to raise it.`;
        } catch { /* not JSON */ }
        toast.error(msg);
        setPendingUser(null);
        return;
      }

      // user message was saved server-side; reflect it locally
      qc.invalidateQueries({ queryKey: ["messages", threadId] });
      setPendingUser(null);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let buf = "";
      let inCtrl = false;
      let activity: ToolActivity[] = [];
      setPendingActivity([]);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Split buffer on RS delimiter, alternating text / control-frame.
          while (true) {
            const idx = buf.indexOf(TOOL_FRAME_DELIM);
            if (idx === -1) break;
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!inCtrl) {
              if (chunk) acc += chunk;
            } else {
              try {
                const ev = JSON.parse(chunk) as ToolEvent;
                activity = foldToolEvent(activity, ev);
                setPendingActivity(activity);
              } catch {
                // ignore malformed frame
              }
            }
            inCtrl = !inCtrl;
          }
          if (!inCtrl && buf) {
            acc += buf;
            buf = "";
          }
          setPendingAssistant(cleanAssistantText(acc));
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
      setPendingAssistant("");
      setPendingActivity([]);
      abortRef.current = null;
      qc.invalidateQueries({ queryKey: ["messages", threadId] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: (e) => {
      if ((e as Error).name === "AbortError") return;
      toast.error(e instanceof Error ? e.message : "Failed");
      setPendingUser(null);
      setPendingAssistant("");
      setPendingActivity([]);
    },
  });

  function stopGenerating() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function regenerate() {
    if (addMut.isPending) return;
    if (isConnected) {
      toast.error("Regenerate is for text chat. Stop voice first.");
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    addMut.mutate({ content: "", files: [], regenerate: true });
  }

  function buildChatMarkdown() {
    const lines = [`# ${cleanThreadTitle(threads.data?.find((t) => t.id === threadId)?.title ?? "BPA Bot chat")}`, ""];
    for (const m of messages) {
      lines.push(`## ${m.role === "user" ? "You" : "BPA Bot"} — ${new Date(m.created_at).toLocaleString()}`);
      lines.push("");
      lines.push(m.role === "assistant" ? cleanAssistantText(m.content) : m.content);
      lines.push("");
    }
    return lines.join("\n");
  }

  function exportMarkdown() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    const md = buildChatMarkdown();
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bpa-bot-chat-${threadId.slice(0, 8)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportPrint() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    window.print();
  }

  function currentTitle() {
    return cleanThreadTitle(threads.data?.find((t) => t.id === threadId)?.title ?? "BPA Bot conversation");
  }
  function exportPdf() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try { exportToPdf(currentTitle(), messages); } catch (e) { toast.error(e instanceof Error ? e.message : "PDF export failed"); }
  }
  async function exportDocx() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try { await exportToDocx(currentTitle(), messages); } catch (e) { toast.error(e instanceof Error ? e.message : "Word export failed"); }
  }
  function exportXlsx() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try { exportToXlsx(currentTitle(), messages); } catch (e) { toast.error(e instanceof Error ? e.message : "Excel export failed"); }
  }
  function exportCsv() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try { exportToCsv(currentTitle(), messages); } catch (e) { toast.error(e instanceof Error ? e.message : "CSV export failed"); }
  }

  async function exportEmailToMe() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    const { data: u } = await supabase.auth.getUser();
    const to = u.user?.email;
    if (!to) return toast.error("Could not find your email on file.");
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Sign in again");
    const subject = `BPA Bot — ${cleanThreadTitle(threads.data?.find((t) => t.id === threadId)?.title ?? "Conversation")}`;
    const body = buildChatMarkdown();
    const promise = fetch("/api/public/jarvis/tools/send_email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, subject, body }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(await r.text().catch(() => "Send failed"));
    });
    toast.promise(promise, {
      loading: `Emailing chat to ${to}…`,
      success: `Sent to ${to}`,
      error: (e) => (e instanceof Error ? e.message : "Send failed"),
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = input.trim();
    if (!v && attachments.length === 0) return;
    if (uploading) return;
    const files = attachments;
    setInput("");
    setAttachments([]);
    addMut.mutate({
      content: v || (files.length === 1 ? `Sent: ${files[0].name}` : `Sent ${files.length} files`),
      files,
      forceWebSearch: webSearchOn,
    });
    if (webSearchOn) setWebSearchOn(false);
  }

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    if (attachments.length + incoming.length > 5) {
      toast.error("Up to 5 files per message");
      return;
    }
    setUploading(true);
    try {
      for (const file of incoming) {
        if (file.size > 20 * 1024 * 1024) {
          toast.error(`${file.name} is over 20MB`);
          continue;
        }
        try {
          const { path, token } = await createUploadUrl({
            data: { threadId, name: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
          });
          const { error } = await supabase.storage
            .from("chat-uploads")
            .uploadToSignedUrl(path, token, file, { contentType: file.type || undefined });
          if (error) throw new Error(error.message);
          setAttachments((cur) => [
            ...cur,
            { path, name: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
          ]);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const createMut = useMutation({
    mutationFn: async () => create({ data: {} }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
    },
  });
  const delMut = useMutation({
    mutationFn: async (id: string) => del({ data: { id } }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      if (id === threadId) navigate({ to: "/chat" });
    },
  });

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", search: { next: undefined } });
  }

  const voiceActive = voiceUiState === "connected" || voiceUiState === "starting";
  const voiceConnecting = voiceUiState === "starting";

  return (
    <div className="h-dvh flex relative overflow-hidden overflow-x-hidden touch-pan-y">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 hud-panel border-r border-primary/30 flex flex-col transform transition-transform md:transform-none ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="p-5 border-b border-border">
          <div className="flex items-start justify-between">
            <div>
              <img src={bpaLogo.url} alt="BP Automation" className="h-8 w-auto mb-2" />
              <div className="text-base font-semibold text-foreground">BPA Bot</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                BP Automation assistant
              </div>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="md:hidden text-muted-foreground hover:text-foreground p-1"
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <button
          onClick={() => {
            setSidebarOpen(false);
            createMut.mutate();
          }}
          className="mx-4 mt-4 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-sm font-medium"
        >
          <Plus size={14} /> New chat
        </button>

        <div className="mx-4 mt-3 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={chatSearch}
            onChange={(e) => setChatSearch(e.target.value)}
            placeholder="Search chats…"
            className="w-full pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1 mt-2">
          {chatSearch.trim() && searchResults.data ? (
            <SearchResults
              data={searchResults.data}
              activeId={threadId}
              onPick={() => {
                setSidebarOpen(false);
                setChatSearch("");
              }}
            />
          ) : (
            groupThreadsByDate(threads.data ?? []).map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
                  {group.label}
                </div>
                {group.items.map((t) => {
                  const active = t.id === threadId;
                  return (
                    <div
                      key={t.id}
                      className={`group flex items-center gap-1 rounded-md pr-1 text-sm ${
                        active ? "bg-secondary text-foreground" : "hover:bg-secondary/60 text-muted-foreground"
                      }`}
                    >
                      <Link
                        to="/chat/$threadId"
                        params={{ threadId: t.id }}
                        className="flex-1 truncate px-2 py-1.5"
                        onClick={() => setSidebarOpen(false)}
                      >
                        {cleanThreadTitle(t.title)}
                      </Link>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const name = cleanThreadTitle(t.title);
                          if (confirm(`Delete "${name}"? This cannot be undone.`)) {
                            delMut.mutate(t.id);
                          }
                        }}
                        aria-label="Delete chat"
                        className="shrink-0 p-2 rounded text-foreground/70 hover:text-destructive hover:bg-destructive/10 transition"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <Link
          to="/contacts"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-3 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Users size={12} /> Saved contacts
        </Link>
        <Link
          to="/inbox"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-2 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Mail size={12} /> Inbox triage
        </Link>
        <Link
          to="/knowledge"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-2 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <BookOpen size={12} /> Knowledge base
        </Link>
        <Link
          to="/activity"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-2 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Sparkles size={12} /> Activity & memory
        </Link>
        <Link
          to="/usage"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-2 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <DollarSign size={12} /> Spend tracker
        </Link>
        <button
          onClick={signOut}
          className="m-4 flex items-center gap-2 justify-center py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <LogOut size={12} /> Sign out
        </button>
      </aside>

      {/* Main HUD */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Desktop export menu */}
        <div className="hidden md:block absolute top-3 right-4 z-30 print:hidden">
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setExportOpen((o) => !o); }}
              className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground border border-border bg-card"
              aria-label="Export chat"
              title="Export chat"
            >
              <MoreVertical size={16} />
            </button>
            {exportOpen && <ExportMenu onPrint={exportPrint} onMarkdown={exportMarkdown} onEmail={exportEmailToMe} onPdf={exportPdf} onDocx={exportDocx} onXlsx={exportXlsx} onCsv={exportCsv} />}
          </div>
        </div>
        {/* Mobile header */}
        <div className="md:hidden fixed top-0 left-0 right-0 z-20 flex items-center gap-2 px-3 py-2 border-b border-border bg-card/95 backdrop-blur">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-md hover:bg-secondary text-foreground"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <div className="text-sm font-semibold text-foreground truncate">BPA Bot</div>
          <div className="relative ml-auto">
            <button
              onClick={(e) => { e.stopPropagation(); setExportOpen((o) => !o); }}
              className="p-2 rounded-md hover:bg-secondary text-foreground"
              aria-label="Export chat"
              title="Export chat"
            >
              <MoreVertical size={18} />
            </button>
            {exportOpen && <ExportMenu onPrint={exportPrint} onMarkdown={exportMarkdown} onEmail={exportEmailToMe} onPdf={exportPdf} onDocx={exportDocx} onXlsx={exportXlsx} onCsv={exportCsv} />}
          </div>
        </div>
        {/* Messages */}
        <div ref={scrollRef} className="relative z-10 flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y pt-16 md:pt-6 pb-6">
          <div className="mx-auto w-full max-w-3xl px-4 md:px-6 space-y-6">
            {messages.length === 0 && !pendingUser && !pendingAssistant && (
              <div className="pt-16 md:pt-24 flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-semibold mb-4">
                  BP
                </div>
                <h2 className="text-xl md:text-2xl font-semibold text-foreground">How can I help today?</h2>
                <p className="text-sm text-muted-foreground mt-1">Ask anything, draft an email, search the web, or generate a document.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-6 w-full max-w-xl">
                  {[
                    { title: "Draft an email", body: "Draft a professional email to a client following up on our last meeting." },
                    { title: "Compare options", body: "Compare the pros and cons of three CRMs for a small B2B team in a table." },
                    { title: "Summarize a topic", body: "Give me a brief, executive-level summary of BP Automation's industry." },
                    { title: "Export a report", body: "Create a one-page PDF report titled \"Weekly Update\" with sample sections." },
                  ].map((p) => (
                    <button
                      key={p.title}
                      type="button"
                      onClick={() => setInput(p.body)}
                      className="text-left rounded-lg border border-border bg-card hover:bg-secondary/60 transition p-3"
                    >
                      <div className="text-sm font-medium text-foreground">{p.title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{p.body}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => {
              const att = (m as unknown as { attachments?: Attachment[] | null }).attachments;
              return (
                <Bubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  messageId={m.id}
                  attachments={Array.isArray(att) ? att : []}
                />
              );
            })}
            {pendingUser && <Bubble role="user" content={pendingUser} />}
            {(pendingAssistant || pendingActivity.length > 0) && (
              <Bubble
                role="assistant"
                content={pendingAssistant}
                streaming
                liveActivity={pendingActivity}
              />
            )}
            {addMut.isPending && !pendingAssistant && pendingActivity.length === 0 && !isConnected && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                  <img src={bpaLogo.url} alt="BPA Bot" className="w-full h-full object-contain p-1" />
                </div>
                <div className="flex items-center gap-1.5 pt-3 text-muted-foreground text-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}
            <div ref={latestMessageRef} aria-hidden="true" />
          </div>
        </div>

        {/* Composer */}
        {(messages.length > 0 || pendingUser || pendingAssistant) && (
          <button
            type="button"
            onClick={scrollToLatest}
            aria-label="Scroll to latest"
            title="Scroll to latest"
            className={`fixed bottom-24 right-4 md:right-10 z-30 w-11 h-11 rounded-full border shadow-lg flex items-center justify-center transition ${
              showScrollDown
                ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                : "bg-card text-muted-foreground border-border hover:bg-secondary hover:text-foreground"
            }`}
          >
            <ArrowDown size={18} />
          </button>
        )}
        {voiceError && (
          <div className="relative z-10 mx-4 md:mx-10 mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {voiceError}
          </div>
        )}
        <form
          onSubmit={onSubmit}
          className="relative z-10 mx-auto w-full max-w-3xl px-4 md:px-6 mb-6"
        >
          <div className="rounded-2xl border border-border bg-card shadow-sm p-2 flex flex-col gap-2">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pt-1">
              {attachments.map((a) => (
                <ComposerAttachmentPreview
                  key={a.path}
                  attachment={a}
                  onRemove={() =>
                    setAttachments((cur) => cur.filter((x) => x.path !== a.path))
                  }
                />
              ))}
              {uploading && (
                <span className="text-xs text-muted-foreground self-center">Uploading…</span>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown"
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />
          <textarea
            autoFocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 220) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
              }
            }}
            rows={1}
            placeholder={
              voiceConnecting
                ? "Connecting voice…"
                : voiceActive
                ? conversation.isSpeaking
                  ? "BPA Bot is speaking…"
                  : "Listening… or type"
                : "Message BPA Bot…"
            }
            className="w-full bg-transparent outline-none px-1 py-1 text-[15px] leading-6 resize-none max-h-[220px] min-h-[36px]"
          />
          <div className="flex items-center gap-1.5 mt-1">
            <button
              type="button"
              onClick={() => {
                if (voiceActive) void stopVoice();
                else void startVoice();
              }}
              title={
                voiceConnecting
                  ? "Connecting…"
                  : voiceActive
                  ? conversation.isSpeaking
                    ? "Speaking…"
                    : "Listening… tap to stop"
                  : "Tap to talk"
              }
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center border transition ${
                voiceActive
                  ? "border-red-500 bg-red-500 text-white hud-pulse shadow-[0_0_0_4px_rgba(239,68,68,0.25)]"
                  : "border-border bg-secondary hover:bg-secondary/80 text-primary"
              }`}
            >
              <Mic size={16} />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach file"
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center border border-border bg-secondary hover:bg-secondary/80 text-primary disabled:opacity-40"
            >
              <Paperclip size={15} />
            </button>
            <button
              type="button"
              onClick={() => setWebSearchOn((v) => !v)}
              title={webSearchOn ? "Web search is ON for the next message" : "Force web search for the next message"}
              aria-pressed={webSearchOn}
              className={`shrink-0 h-9 rounded-full flex items-center gap-1.5 border text-sm transition ${
                webSearchOn
                  ? "border-primary bg-primary/10 text-primary px-3"
                  : "border-border bg-secondary hover:bg-secondary/80 text-muted-foreground w-9 justify-center sm:w-auto sm:px-3"
              }`}
            >
              <Globe size={14} />
              <span className={webSearchOn ? "inline" : "hidden sm:inline"}>Search web</span>
            </button>
            <div className="flex-1" />
            {addMut.isPending && !isConnected ? (
              <button
                type="button"
                onClick={stopGenerating}
                className="h-9 px-3 sm:px-4 rounded-full bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 flex items-center gap-1.5"
                title="Stop generating"
              >
                <Square size={14} />
                <span className="hidden sm:inline">Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={(!input.trim() && attachments.length === 0) || uploading}
                className="h-9 w-9 sm:w-auto sm:px-4 rounded-full sm:rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 flex items-center justify-center gap-1.5"
                title="Send"
              >
                <Send size={14} />
                <span className="hidden sm:inline">Send</span>
              </button>
            )}
          </div>
          </div>
        </form>
        {/* Regenerate action below composer when there's an assistant message and we're idle */}
        {!addMut.isPending && !isConnected && messages.some((m) => m.role === "assistant") && (
          <div className="relative z-10 -mt-4 mb-4 flex justify-center">
            <button
              type="button"
              onClick={regenerate}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-3 py-1 rounded-full border border-border bg-card"
              title="Regenerate last response"
            >
              <RotateCcw size={12} /> Regenerate
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function ExportMenu({ onPrint, onMarkdown, onEmail, onPdf, onDocx, onXlsx, onCsv }: { onPrint: () => void; onMarkdown: () => void; onEmail: () => void; onPdf: () => void; onDocx: () => void; onXlsx: () => void; onCsv: () => void }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-full mt-1 w-60 rounded-md border border-border bg-card shadow-lg z-50 overflow-hidden"
    >
      <button onClick={onPdf} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <FileType2 size={14} /> Download PDF
      </button>
      <button onClick={onDocx} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <FileText size={14} /> Download Word (.docx)
      </button>
      <button onClick={onXlsx} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <FileSpreadsheet size={14} /> Download Excel (.xlsx)
      </button>
      <button onClick={onCsv} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <Download size={14} /> Download CSV
      </button>
      <div className="h-px bg-border" />
      <button onClick={onPrint} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <Printer size={14} /> Print
      </button>
      <button onClick={onMarkdown} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <Download size={14} /> Download Markdown
      </button>
      <button onClick={onEmail} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <Mail size={14} /> Email chat to me
      </button>
    </div>
  );
}

type AttachmentMeta = { path: string; name: string; mimeType: string; size?: number };

const signedUrlCache = new Map<string, { url: string; expires: number }>();

async function getAttachmentSignedUrl(path: string): Promise<string | null> {
  const cached = signedUrlCache.get(path);
  const now = Date.now();
  if (cached && cached.expires > now + 60_000) return cached.url;
  const { data, error } = await supabase.storage
    .from("chat-uploads")
    .createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) return null;
  signedUrlCache.set(path, { url: data.signedUrl, expires: now + 60 * 60 * 1000 });
  return data.signedUrl;
}

function AttachmentPreview({
  attachment,
  tone,
}: {
  attachment: AttachmentMeta;
  tone: "user" | "assistant";
}) {
  return AttachmentPreviewInner({ attachment, tone });
}

// Composer chip — clickable thumbnail preview BEFORE sending, so users can
// verify they've picked the right image/PDF (ChatGPT-style).
function ComposerAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: AttachmentMeta;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getAttachmentSignedUrl(attachment.path).then((u) => {
      if (alive && u) setUrl(u);
    });
    return () => { alive = false; };
  }, [attachment.path]);
  const isImage = attachment.mimeType.startsWith("image/");
  const ext = attachment.name.split(".").pop()?.toUpperCase() || "";
  const isPdf = attachment.mimeType === "application/pdf" || ext === "PDF";
  const open = () => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };
  return (
    <div className="relative group/chip">
      {isImage ? (
        <button
          type="button"
          onClick={open}
          className="block h-14 w-14 rounded-lg overflow-hidden border border-border bg-secondary/60 hover:opacity-90 transition"
          title={`Preview ${attachment.name}`}
        >
          {url ? (
            <img src={url} alt={attachment.name} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              <ImageIcon size={16} />
            </div>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={open}
          className="flex items-center gap-2 h-14 pl-2 pr-3 rounded-lg border border-border bg-secondary/60 hover:bg-secondary transition max-w-[220px]"
          title={`Preview ${attachment.name}`}
        >
          <div className={`flex items-center justify-center h-9 w-9 rounded-md shrink-0 ${isPdf ? "bg-[#ff5a5f] text-white" : "bg-primary/80 text-primary-foreground"}`}>
            <FileText size={16} />
          </div>
          <div className="min-w-0 text-left">
            <div className="text-xs font-medium truncate leading-tight">{attachment.name}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{isPdf ? "PDF" : ext || "FILE"}</div>
          </div>
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-foreground text-background flex items-center justify-center shadow opacity-0 group-hover/chip:opacity-100 transition"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function AttachmentPreviewInner({
  attachment,
  tone,
}: {
  attachment: AttachmentMeta;
  tone: "user" | "assistant";
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getAttachmentSignedUrl(attachment.path).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [attachment.path]);
  const isImage = attachment.mimeType.startsWith("image/");
  if (isImage) {
    return (
      <a
        href={url ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-lg overflow-hidden border border-border bg-background/40 max-w-[260px]"
        title={attachment.name}
        onClick={(e) => {
          if (!url) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          window.open(url, "_blank", "noopener,noreferrer");
        }}
      >
        {url ? (
          <img
            src={url}
            alt={attachment.name}
            className="max-h-64 w-auto object-contain"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="h-32 w-40 flex items-center justify-center text-xs text-muted-foreground">
            {failed ? "Preview unavailable" : "Loading…"}
          </div>
        )}
      </a>
    );
  }
  // ChatGPT-style file card: red PDF (or generic) icon tile + filename + type label.
  const ext = attachment.name.split(".").pop()?.toUpperCase() || "";
  const isPdf = attachment.mimeType === "application/pdf" || ext === "PDF";
  const typeLabel = isPdf
    ? "PDF"
    : ext && ext.length <= 5
      ? ext
      : attachment.mimeType.split("/").pop()?.toUpperCase() || "FILE";
  const cardClass =
    tone === "user"
      ? "group/att flex items-center gap-3 rounded-2xl p-2.5 pr-4 bg-primary-foreground/10 hover:bg-primary-foreground/20 text-primary-foreground transition cursor-pointer max-w-[320px]"
      : "group/att flex items-center gap-3 rounded-2xl p-2.5 pr-4 bg-card hover:bg-secondary/60 border border-border text-foreground transition cursor-pointer max-w-[320px]";
  const iconTileClass = isPdf
    ? "flex items-center justify-center h-10 w-10 rounded-xl bg-[#ff5a5f] text-white shrink-0"
    : "flex items-center justify-center h-10 w-10 rounded-xl bg-primary/80 text-primary-foreground shrink-0";
  return (
    <a
      href={url ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className={cardClass}
      onClick={(e) => {
        if (!url) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
      }}
      title={`Open ${attachment.name}`}
    >
      <div className={iconTileClass}>
        <FileText size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate leading-tight">{attachment.name}</div>
        <div className="text-xs opacity-70 mt-0.5">{typeLabel}</div>
      </div>
    </a>
  );
}

function Bubble({
  role,
  content,
  attachments = [],
  streaming = false,
  messageId,
  liveActivity,
}: {
  role: string;
  content: string;
  attachments?: Array<{ path: string; name: string; mimeType: string; size?: number }>;
  streaming?: boolean;
  messageId?: string;
  liveActivity?: ToolActivity[];
}) {
  const isUser = role === "user";
  // Pull tool-activity marker out of persisted assistant messages so we can
  // render Claude-style search chips above the answer.
  const { activities: storedActivity, content: withoutActivity } = isUser
    ? { activities: [] as ToolActivity[], content }
    : extractToolActivity(content);
  const cleanedRaw = isUser ? content : cleanAssistantText(withoutActivity);
  const activities = liveActivity && liveActivity.length > 0 ? liveActivity : storedActivity;
  // Extract artifact markers so we can render preview cards.
  const artifactIds: string[] = [];
  const displayContent = cleanedRaw
    .replace(ARTIFACT_MARKER_RE, (_m, id: string) => {
      artifactIds.push(id);
      return "";
    })
    .replace(/(^|\n)\s*\|[^\n]*\|\s*\n\s*\|[\s\-:|]+\|\s*(?=\n\s*(?:\|[\s\-:|]*\|\s*)*$|\s*$)/g, "")
    .trim();
  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] min-w-0 overflow-x-auto rounded-2xl rounded-tr-md px-4 py-2.5 text-[15px] leading-relaxed bg-primary text-primary-foreground">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map((a) => (
                <AttachmentPreview key={a.path} attachment={a} tone="user" />
              ))}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{displayContent}</div>
        </div>
        <div className="opacity-0 group-hover:opacity-100 transition pr-1">
          <CopyButton text={displayContent} />
        </div>
      </div>
    );
  }
  return (
    <div className="group flex gap-3">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
        <img src={bpaLogo.url} alt="BPA Bot" className="w-full h-full object-contain p-1" />
      </div>
      <div className="flex-1 min-w-0">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a) => (
              <AttachmentPreview key={a.path} attachment={a} tone="assistant" />
            ))}
          </div>
        )}
        {activities.length > 0 && <ToolActivityList items={activities} streaming={streaming} />}
        <div
          className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-table:my-3 prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-md prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.9em] prose-a:text-accent prose-a:underline-offset-2 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ node: _n, ...props }) => (
                <div className="my-3 -mx-1 max-h-[420px] overflow-auto rounded-md border border-border">
                  <table {...props} className="w-full min-w-max border-collapse text-sm" />
                </div>
              ),
            }}
          >{displayContent}</ReactMarkdown>
          {streaming && (
            <span className="inline-block w-1.5 h-4 align-[-2px] ml-0.5 bg-foreground/70 animate-pulse rounded-sm" />
          )}
        </div>
        {artifactIds.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {artifactIds.map((id) => (
              <ArtifactCard key={id} artifactId={id} />
            ))}
          </div>
        )}
        {!streaming && displayContent && (
          <div className="mt-2 flex items-center gap-1 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition">
            <CopyButton text={displayContent} />
            {messageId && <FeedbackButtons messageId={messageId} />}
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function ToolActivityList({
  items,
  streaming = false,
}: {
  items: ToolActivity[];
  streaming?: boolean;
}) {
function labelFor(a: ToolActivity, pending: boolean): string {
  const host = hostOf(a.url) || "page";
  const map: Record<string, [string, string]> = {
    web_search: ["Searching the web…", "Searched the web"],
    web_scrape: [`Opening ${host}…`, `Read ${host}`],
    product_search: ["Finding products…", "Found products"],
    deep_research: ["Researching…", "Deep research"],
    search_knowledge_base: ["Searching your docs…", "Searched your docs"],
    send_email: ["Sending email…", "Email sent"],
    list_contacts: ["Looking up contacts…", "Contacts loaded"],
    save_contact: ["Saving contact…", "Contact saved"],
    list_calendar_events: ["Checking your calendar…", "Calendar checked"],
    create_calendar_event: ["Creating calendar event…", "Meeting scheduled"],
    cancel_calendar_event: ["Cancelling event…", "Event cancelled"],
    respond_calendar_event: ["Responding to invite…", "Invite response sent"],
    generate_document: ["Generating document…", "Document ready"],
    recall_facts: ["Recalling what I know…", ""],
    remember_fact: ["Saving note…", "Noted"],
    forget_fact: ["Forgetting…", "Forgotten"],
    save_lesson: ["Learning from this…", "Learned"],
  };
  const pair = map[a.name] ?? ["Working…", "Done"];
  const base = pending ? pair[0] : pair[1];
  return a.label ? `${base} — ${a.label}` : base;
}

  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      {items.map((a, idx) => {
        // Server-side generate_document (chat mode) returns a signed URL
        // instead of a client artifact. Render a full doc card in place of
        // the tool-activity chip so the user gets Preview + Download + Email.
        if (a.name === "generate_document" && a.docFile?.url) {
          return <RemoteDocCard key={a.id} doc={a.docFile} />;
        }
        const isLast = idx === items.length - 1;
        const pending =
          streaming && isLast && !a.results && !a.scraped && !a.products && !a.citations && !a.error;
        const isOpen = expandedId === a.id;
        const label = labelFor(a, pending);
        const canExpand =
          (a.name === "web_search" && (a.results?.length ?? 0) > 0) ||
          (a.name === "deep_research" && (a.citations?.length ?? 0) > 0);
        const hasProducts = a.name === "product_search" && (a.products?.length ?? 0) > 0;
        const expandItems =
          a.name === "deep_research" ? (a.citations ?? []).map((c) => ({ title: c.title, url: c.url, snippet: undefined })) : a.results;
        return (
          <div
            key={a.id}
            className="rounded-lg border border-border bg-secondary/40 text-[13px] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => canExpand && setExpandedId(isOpen ? null : a.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left ${canExpand ? "hover:bg-secondary/70 cursor-pointer" : "cursor-default"}`}
            >
              {a.name === "product_search" ? (
                <ShoppingBag size={13} className="text-muted-foreground shrink-0" />
              ) : a.name === "deep_research" ? (
                <BookOpen size={13} className="text-muted-foreground shrink-0" />
              ) : (
                <Search size={13} className="text-muted-foreground shrink-0" />
              )}
              <span className="text-muted-foreground shrink-0">{label}</span>
              {a.query && (
                <span className="text-foreground font-medium truncate">
                  {a.query}
                </span>
              )}
              {a.name === "web_scrape" && a.url && (
                <span className="text-foreground font-medium truncate">
                  {hostOf(a.url)}
                </span>
              )}
              {pending && (
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                  <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
                </span>
              )}
              {!pending && canExpand && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {a.name === "deep_research"
                    ? `${a.citations?.length} source${(a.citations?.length ?? 0) === 1 ? "" : "s"}`
                    : `${a.results?.length} result${(a.results?.length ?? 0) === 1 ? "" : "s"}`}
                </span>
              )}
              {!pending && hasProducts && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {a.products?.length} product{(a.products?.length ?? 0) === 1 ? "" : "s"}
                </span>
              )}
            </button>
            {isOpen && expandItems && expandItems.length > 0 && (
              <div className="border-t border-border bg-background/40 divide-y divide-border">
                {expandItems.map((r, i) => {
                  const fav = faviconFor(r.url);
                  return (
                    <a
                      key={`${a.id}-${i}`}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2.5 px-3 py-2 hover:bg-secondary/40"
                    >
                      {fav ? (
                        <img
                          src={fav}
                          alt=""
                          className="w-4 h-4 mt-0.5 rounded-sm shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-4 h-4 mt-0.5 rounded-sm bg-muted shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-foreground truncate">
                          {r.title || r.url}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {hostOf(r.url)}
                        </div>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}
            {hasProducts && (
              <div className="border-t border-border bg-background/40 p-2 overflow-x-auto">
                <div className="flex gap-2 min-w-max">
                  {a.products!.map((p, i) => {
                    const fav = faviconFor(p.url);
                    return (
                      <a
                        key={`${a.id}-p-${i}`}
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-44 shrink-0 rounded-md border border-border bg-card hover:bg-secondary/60 transition overflow-hidden flex flex-col"
                      >
                        <div className="w-full h-28 bg-muted overflow-hidden flex items-center justify-center">
                          {p.image ? (
                            <img
                              src={p.image}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <ShoppingBag size={22} className="text-muted-foreground/60" />
                          )}
                        </div>
                        <div className="p-2 flex flex-col gap-1 min-w-0">
                          <div className="text-[12.5px] font-medium text-foreground line-clamp-2 leading-tight min-h-[2.4em]">
                            {p.title || hostOf(p.url)}
                          </div>
                          <div className="flex items-center justify-between gap-1">
                            {p.price ? (
                              <span className="text-[12px] font-semibold text-primary">{p.price}</span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">View</span>
                            )}
                            <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground truncate">
                              {fav && (
                                <img src={fav} alt="" className="w-3 h-3 rounded-sm" loading="lazy" />
                              )}
                              <span className="truncate max-w-[80px]">{p.merchant || hostOf(p.url)}</span>
                              <ExternalLink size={9} className="shrink-0" />
                            </span>
                          </div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ArtifactCard({ artifactId }: { artifactId: string }) {
  const art = getArtifact(artifactId);
  const [sending, setSending] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  if (!art) {
    return (
      <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        Attachment expired (reload cleared it).
      </div>
    );
  }
  const ext = art.filename.toLowerCase().split(".").pop() ?? "";
  const canPreview = ["pdf", "docx", "csv", "txt", "md", "xlsx", "xls"].includes(ext);

  async function openPreview() {
    if (!art) return;
    setPreviewOpen(true);
    if (previewHtml || previewText || previewUrl) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const blob = base64ToBlob(art.base64, art.mimeType);
      if (ext === "pdf") {
        setPreviewUrl(URL.createObjectURL(blob));
      } else if (ext === "docx") {
        const buf = await blob.arrayBuffer();
        const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
        // Match the branded DOCX template so the preview visually mirrors
        // the downloaded file (title colour, heading colour, spacing, rule).
        const brand = "#0D4763";
        const stripped = (value || "").replace(/^\s*<h1[^>]*>[^<]*<\/h1>/i, "");
        const titleHtml = `<h1 style="font-size:26px;font-weight:700;color:${brand};margin:0 0 4px">${art.filename.replace(/\.[^.]+$/, "")}</h1><div style="height:2px;background:${brand};width:64px;margin:0 0 20px"></div>`;
        setPreviewHtml(
          `<style>
            .docx-preview{font-family:Arial,sans-serif;color:#1f2937;font-size:14px;line-height:1.55}
            .docx-preview h1,.docx-preview h2,.docx-preview h3{color:${brand};font-weight:700;margin:18px 0 8px}
            .docx-preview h1{font-size:20px}
            .docx-preview h2{font-size:16px}
            .docx-preview h3{font-size:14px}
            .docx-preview p{margin:0 0 10px}
            .docx-preview ul,.docx-preview ol{margin:0 0 12px 22px}
            .docx-preview table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
            .docx-preview th{background:#DCEAF2;color:${brand};font-weight:700;border:1px solid #CBD5E1;padding:6px 10px;text-align:left}
            .docx-preview td{border:1px solid #CBD5E1;padding:6px 10px}
            .docx-preview tr:nth-child(even) td{background:#F8FAFC}
          </style>
          <div class="docx-preview">${titleHtml}${stripped || "<p><em>Document is empty.</em></p>"}</div>`,
        );
      } else if (ext === "csv" || ext === "txt" || ext === "md") {
        setPreviewText(await blob.text());
      } else if (ext === "xlsx" || ext === "xls") {
        const buf = await blob.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const parts = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
          return `<h3 style="margin:16px 0 8px;font-size:14px;font-weight:600;color:#374151">${name}</h3>${html}`;
        }).join("");
        setPreviewHtml(
          `<style>table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #e5e7eb;padding:4px 8px;text-align:left}tr:nth-child(even) td{background:#f9fafb}</style>${parts || "<p><em>Empty spreadsheet.</em></p>"}`,
        );
      }
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not preview file");
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function emailToMe() {
    if (!art) return;
    setSending(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const to = u.user?.email;
      if (!to) return toast.error("Could not find your email on file.");
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return toast.error("Sign in again");
      const res = await fetch("/api/public/jarvis/tools/send_email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to,
          subject: art.filename,
          body: `Attached: **${art.filename}** (${art.formatLabel}).`,
          attachment: { filename: art.filename, mimeType: art.mimeType, contentBase64: art.base64 },
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "send failed");
        throw new Error(t.slice(0, 200));
      }
      toast.success(`Emailed to ${to}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <FileText size={18} />
        </div>
        <button
          type="button"
          onClick={canPreview ? openPreview : () => downloadArtifact(art)}
          className="min-w-0 flex-1 text-left hover:opacity-80 transition"
        >
          <div className="text-sm font-medium truncate">{art.filename}</div>
          <div className="text-xs text-muted-foreground truncate">
            {art.formatLabel} · {formatBytes(art.size)}
          </div>
        </button>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {canPreview && (
          <button
            type="button"
            onClick={openPreview}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5"
          >
            <Eye size={12} /> Preview
          </button>
        )}
        <button
          type="button"
          onClick={() => downloadArtifact(art)}
          className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5"
        >
          <Download size={12} /> Download
        </button>
        <button
          type="button"
          onClick={emailToMe}
          disabled={sending}
          className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5 disabled:opacity-50"
        >
          <Mail size={12} /> {sending ? "Sending…" : "Email to me"}
        </button>
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl w-[95vw] h-[85vh] flex flex-col p-0 gap-0">
          <DialogHeader className="p-4 border-b border-border">
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileText size={16} /> {art.filename}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto bg-secondary/30">
            {previewLoading && (
              <div className="p-8 text-sm text-muted-foreground">Loading preview…</div>
            )}
            {previewError && (
              <div className="p-8 text-sm text-destructive">{previewError}</div>
            )}
            {!previewLoading && !previewError && previewUrl && ext === "pdf" && (
              <iframe src={previewUrl} title={art.filename} className="w-full h-full bg-white" />
            )}
            {!previewLoading && !previewError && previewHtml && (
              <div className="mx-auto max-w-3xl bg-white text-neutral-900 shadow-sm my-6 p-10 rounded-md">
                <div
                  className="prose prose-sm max-w-none prose-headings:font-semibold"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            )}
            {!previewLoading && !previewError && previewText && (
              <pre className="p-6 text-xs whitespace-pre-wrap font-mono text-foreground">
                {previewText}
              </pre>
            )}
          </div>
          <div className="p-3 border-t border-border flex justify-end gap-2">
            <button
              type="button"
              onClick={() => downloadArtifact(art)}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5"
            >
              <Download size={12} /> Download
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RemoteDocCard({
  doc,
}: {
  doc: { url: string; filename: string; formatLabel?: string; mimeType?: string; size?: number };
}) {
  const [sending, setSending] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const ext = doc.filename.toLowerCase().split(".").pop() ?? "";
  const label = doc.formatLabel ?? ext.toUpperCase();
  const canPreview = ["pdf", "docx", "csv", "txt", "md", "xlsx", "xls"].includes(ext);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function openPreview() {
    setPreviewOpen(true);
    if (ext === "pdf" || previewHtml || previewText) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(doc.url);
      if (!res.ok) throw new Error(`Could not load file (${res.status})`);
      const blob = await res.blob();
      if (ext === "docx") {
        const buf = await blob.arrayBuffer();
        const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
        const brand = "#0D4763";
        const stripped = (value || "").replace(/^\s*<h1[^>]*>[^<]*<\/h1>/i, "");
        const titleHtml = `<h1 style="font-size:26px;font-weight:700;color:${brand};margin:0 0 4px">${doc.filename.replace(/\.[^.]+$/, "")}</h1><div style="height:2px;background:${brand};width:64px;margin:0 0 20px"></div>`;
        setPreviewHtml(
          `<style>
            .docx-preview{font-family:Arial,sans-serif;color:#1f2937;font-size:14px;line-height:1.55}
            .docx-preview h1,.docx-preview h2,.docx-preview h3{color:${brand};font-weight:700;margin:18px 0 8px}
            .docx-preview h1{font-size:20px}
            .docx-preview h2{font-size:16px}
            .docx-preview h3{font-size:14px}
            .docx-preview p{margin:0 0 10px}
            .docx-preview ul,.docx-preview ol{margin:0 0 12px 22px}
            .docx-preview table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
            .docx-preview th{background:#DCEAF2;color:${brand};font-weight:700;border:1px solid #CBD5E1;padding:6px 10px;text-align:left}
            .docx-preview td{border:1px solid #CBD5E1;padding:6px 10px}
            .docx-preview tr:nth-child(even) td{background:#F8FAFC}
          </style>
          <div class="docx-preview">${titleHtml}${stripped || "<p><em>Document is empty.</em></p>"}</div>`,
        );
      } else if (ext === "xlsx" || ext === "xls") {
        const buf = await blob.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const parts = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
          return `<h3 style="margin:16px 0 8px;font-size:14px;font-weight:600;color:#374151">${name}</h3>${html}`;
        }).join("");
        setPreviewHtml(
          `<style>table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #e5e7eb;padding:4px 8px;text-align:left}tr:nth-child(even) td{background:#f9fafb}</style>${parts || "<p><em>Empty spreadsheet.</em></p>"}`,
        );
      } else if (ext === "csv" || ext === "txt" || ext === "md") {
        setPreviewText(await blob.text());
      }
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not preview file");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function emailToMe() {
    setSending(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const to = u.user?.email;
      if (!to) return toast.error("Could not find your email on file.");
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return toast.error("Sign in again");
      // Fetch the file bytes so we can attach it via send_email.
      const fileRes = await fetch(doc.url);
      if (!fileRes.ok) throw new Error("Could not download the file to attach");
      const buf = await fileRes.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      const res = await fetch("/api/public/jarvis/tools/send_email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to,
          subject: doc.filename,
          body: `Attached: **${doc.filename}** (${label}).`,
          attachment: {
            filename: doc.filename,
            mimeType: doc.mimeType ?? "application/octet-stream",
            contentBase64: base64,
          },
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "send failed");
        throw new Error(t.slice(0, 200));
      }
      toast.success(`Emailed to ${to}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <FileText size={18} />
        </div>
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 text-left hover:opacity-80 transition"
        >
          <div className="text-sm font-medium truncate">{doc.filename}</div>
          <div className="text-xs text-muted-foreground truncate">
            {label}
            {typeof doc.size === "number" ? ` · ${formatBytes(doc.size)}` : ""}
          </div>
        </a>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {canPreview && (
          <button
            type="button"
            onClick={openPreview}
            className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5"
          >
            <Eye size={12} /> Preview
          </button>
        )}
        <a
          href={doc.url}
          download={doc.filename}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5"
        >
          <Download size={12} /> Download
        </a>
        <button
          type="button"
          onClick={emailToMe}
          disabled={sending}
          className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5 disabled:opacity-50"
        >
          <Mail size={12} /> {sending ? "Sending…" : "Email to me"}
        </button>
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl w-[95vw] h-[85vh] flex flex-col p-0 gap-0">
          <DialogHeader className="p-4 border-b border-border">
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileText size={16} /> {doc.filename}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto bg-secondary/30">
            {ext === "pdf" ? (
              <iframe src={doc.url} title={doc.filename} className="w-full h-full bg-white" />
            ) : previewLoading ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                Loading preview…
              </div>
            ) : previewError ? (
              <div className="h-full flex items-center justify-center text-sm text-destructive px-4 text-center">
                {previewError}
              </div>
            ) : previewHtml ? (
              <div className="p-6 bg-white min-h-full">
                <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
              </div>
            ) : previewText ? (
              <pre className="p-6 bg-white min-h-full text-xs whitespace-pre-wrap font-mono">
                {previewText}
              </pre>
            ) : null}
          </div>
          <div className="p-3 border-t border-border flex justify-end gap-2">
            <a
              href={doc.url}
              download={doc.filename}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary flex items-center gap-1.5"
            >
              <Download size={12} /> Download
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
