import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Plus, Trash2, LogOut, Send, Menu, X, ArrowDown, Users, Paperclip, FileText, Image as ImageIcon, Search, Square, RotateCcw, Download, Printer, Mail, MoreVertical, Sparkles, BookOpen, FileSpreadsheet, FileType2, Copy, Check, ThumbsUp, ThumbsDown, Settings as SettingsIcon, FlaskConical } from "lucide-react";
import { exportToPdf, exportToDocx, exportToXlsx, exportToCsv } from "@/lib/chat-export";
import { toast } from "sonner";
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
import { getAssistantSettings } from "@/lib/assistant/settings.functions";
import {
  startOpenAiRealtimeSession,
  preflightOpenAiRealtime,
  type RealtimeSession,
  type RealtimePhase,
} from "@/lib/voice/openai-realtime";
import { looksLikeDocumentIntent } from "@/lib/doc-intent";
import { filterOutTransientVoiceErrors } from "@/lib/voice/transient-errors";

const BPA_LOGO_SRC = "/icon-512.png";

const VOICE_SESSION_PROMPT = `You are BPA Bot, BP Automation's assistant. Continue the active conversation; do not introduce yourself, do not greet again, and do not say your name unless asked.

VOICE OUTPUT CONTRACT:
- Speak in 1-2 short sentences by default. Keep spoken answers under 25 words unless the user explicitly asks for detail.
- Never think out loud, fill silence, narrate internal steps, ramble, repeat yourself, or say unrelated/random words.
- If you are unsure, ask one concise clarifying question. Do not improvise details.
- For tables, comparisons, email drafts, documents, code, lists, or anything long: keep the spoken response brief; the chat transcript will show the text.
- Do not read long tables, long drafts, or long research results out loud.
- If the user interrupts, stop immediately and listen.

Format answers for this chat UI. If the user asks for a table, visual table, comparison, schedule, specs, rows/columns, or tabular data, output a GitHub-Flavored Markdown table using pipes, for example:
| Item | Detail |
| --- | --- |
| Example | Value |

Never say you are unable to display a visual table directly in this chat interface. The interface renders Markdown tables. Be concise and contribute directly to the conversation.`;

const BAD_TABLE_REFUSAL = /(?:I(?:'m| am)\s+)?unable to display a visual table directly in this chat interface\.?/gi;
const BPA_INTRO = /^\s*(?:Hi,?\s*)?I(?:'m| am)\s+BPA Bot\s*[—-]\s*BP Automation'?s assistant\.\s*How can I help\??\s*/i;
const STRUCTURED_TABLE_REFUSAL = /I can present the information in a clear, structured text format that you can easily copy and paste\.\s*/gi;
const TABLE_RETRY_PROMPT = /Would you like me to provide the comparison details in that text format again\??/gi;

type VoiceUiState = "idle" | "starting" | "connected" | "reconnecting" | "stopping";
type ApprovalCardData =
  | {
      kind: "email";
      title: string;
      to?: string;
      cc?: string;
      subject?: string;
      body?: string;
    }
  | {
      kind: "calendar";
      title: string;
      eventTitle?: string;
      dateTime?: string;
      attendees?: string;
      location?: string;
      description?: string;
    };

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

function cleanThreadTitle(title: string) {
  const cleaned = cleanAssistantText(title);
  return !cleaned || /Alex|personal assistant/i.test(title) ? "New conversation" : cleaned;
}

function looksUnstableVoiceText(text: string) {
  const s = cleanAssistantText(text).trim();
  if (!s) return false;
  // Only flag obvious model glitches: long runs of the same char or literal
  // placeholder tokens. The previous heuristics (short-word runs, consonant
  // ratios) misfired on normal speech and froze the transcript mid-turn.
  if (/(.)\1{15,}/.test(s)) return true;
  if (/\blorem ipsum\b/i.test(s)) return true;
  return false;
}

function parseBoldField(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*-?\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, "im");
  return text.match(re)?.[1]?.trim();
}

function parseApprovalCard(content: string): ApprovalCardData | null {
  const text = cleanAssistantText(content);
  if (!text || /\b(generated and sent|email(?: has been)? sent|scheduled|created)\b/i.test(text)) return null;

  const emailLike =
    /\bdraft email\b/i.test(text) ||
    /\breply ["“']?send["”']? to send/i.test(text) ||
    /^\s*-?\s*(?:\*\*)?to(?:\*\*)?:/im.test(text);
  if (emailLike) {
    const to = parseBoldField(text, "To");
    const cc = parseBoldField(text, "Cc");
    const subject = parseBoldField(text, "Subject");
    if (to || subject) {
      const dividerParts = text.split(/\n\s*---+\s*\n/);
      const body = dividerParts.length >= 3 ? dividerParts[1].trim() : undefined;
      return {
        kind: "email",
        title: "Email ready for approval",
        to,
        cc: cc && cc !== "(none)" ? cc : undefined,
        subject,
        body,
      };
    }
  }

  const calendarLike =
    /\b(calendar event|draft for the calendar|draft preview|please confirm.*(?:event|meeting)|reply ["“']?(create|schedule))/i.test(text);
  if (calendarLike) {
    const eventTitle = parseBoldField(text, "Title");
    const dateTime =
      parseBoldField(text, "Date & time") ??
      parseBoldField(text, "Date/time") ??
      parseBoldField(text, "Time") ??
      parseBoldField(text, "Date");
    const attendees = parseBoldField(text, "Attendees");
    const location = parseBoldField(text, "Location");
    const description =
      parseBoldField(text, "Description") ??
      parseBoldField(text, "Agenda");
    if (eventTitle || dateTime || attendees) {
      return {
        kind: "calendar",
        title: "Calendar event ready for approval",
        eventTitle,
        dateTime,
        attendees,
        location,
        description,
      };
    }
  }

  return null;
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
  const createUploadUrl = useServerFn(createChatUploadUrl);
  const searchFn = useServerFn(searchChats);
  const getSettings = useServerFn(getAssistantSettings);
  const settingsQ = useQuery({ queryKey: ["assistant-settings"], queryFn: () => getSettings({}) });
  // ElevenLabs is deprecated. Any legacy stored value is coerced to
  // OpenAI Realtime, and OpenAI Realtime is the default for new users.
  const rawVoiceProvider = (settingsQ.data?.voice_provider ?? "openai_realtime") as string;
  const voiceProvider: "openai_realtime" | "none" =
    rawVoiceProvider === "none" ? "none" : "openai_realtime";
  const costMode = settingsQ.data?.cost_mode ?? "balanced";
  const openAiSessionRef = useRef<RealtimeSession | null>(null);
  // Voice document-intent dedupe guards (survive re-renders across a session).
  const docInFlightRef = useRef(false);
  const lastDocumentIntentKeyRef = useRef<string>("");
  const lastDocumentIntentCompletedAtRef = useRef<number>(0);
  // Failure counter per intent key. After 2 failures the same intent is
  // suppressed for the completed-TTL window so we don't loop forever if the
  // generator is down.
  const docIntentFailureCountRef = useRef<Map<string, number>>(new Map());
  const DOC_MAX_FAILURES_PER_INTENT = 2;

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });
  const messagesQ = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getMsgs({ data: { threadId } }),
  });

  const [input, setInput] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string>("");
  // Live interim user transcript shown while the user is still speaking
  // during an OpenAI Realtime turn. Cleared once the final user message
  // is persisted (or when the assistant finishes its reply).
  const [pendingUserVoice, setPendingUserVoice] = useState<string>("");
  type Attachment = { path: string; name: string; mimeType: string; size: number };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  // Fine-grained phase surfaced to the mic UI so mobile users know exactly
  // what's happening (mic prompt vs. OpenAI handshake vs. generating a doc).
  const [voicePhase, setVoicePhase] = useState<RealtimePhase | "generating-document" | "idle">(
    "idle",
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = () => setExportOpen(false);
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [exportOpen]);

  const rawMessages = messagesQ.data ?? [];
  // Hide legacy transient voice/session error strings that a prior code
  // path may have persisted as assistant messages. See
  // src/lib/voice/transient-errors.ts for the pattern list.
  const messages = filterOutTransientVoiceErrors(rawMessages);

  // Live voice session timer (used for OpenAI Realtime widget where we don't
  // have a server-reported usage percent to show).
  const [voiceSessionStart, setVoiceSessionStart] = useState<number | null>(null);
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  useEffect(() => {
    if (voiceUiState === "connected") {
      setVoiceSessionStart((s) => s ?? Date.now());
    } else if (voiceUiState === "idle") {
      setVoiceSessionStart(null);
      setVoiceElapsed(0);
    }
  }, [voiceUiState]);
  useEffect(() => {
    if (!voiceSessionStart) return;
    const id = window.setInterval(() => {
      setVoiceElapsed(Math.floor((Date.now() - voiceSessionStart) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [voiceSessionStart]);
  const fmtElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };
  // ElevenLabs quota warnings removed — OpenAI Realtime is the sole voice
  // provider and does not surface a client-side percent-used metric.

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
	  }, [messages.length, pendingAssistant, pendingUser, pendingUserVoice]);

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

  function buildVoiceContext() {
    const MAX_CHARS = 5000;
    const recent = (messages ?? []).slice(-30).map(
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
      "- If asked for a table, output a GitHub-Flavored Markdown table directly.",
      "- EMAIL: never guess or invent addresses. If the user supplied or confirmed the exact email address already, use it directly.",
      "- EMAIL FORMATTING: always write emails in clean, professional Markdown — a proper greeting, short well-structured paragraphs, bullet lists or tables where helpful, and a sign-off. Never send a plain unformatted dump.",
      "- EMAIL SIGNATURE: Microsoft Graph usually does not apply the user's Outlook UI signature, so include an appropriate sign-off in the email body unless the user asks not to.",
      "- EMAIL APPROVAL: present one complete concise readback/draft, then wait. If the next reply is yes, ok, sure, send, confirm, or approved, call send_email immediately with approved: true. Do not ask again. Never call send_email unless the immediately previous assistant turn was the draft/readback.",
      "- OUTLOOK BRIEFING: for morning briefing, catch me up, what needs a reply, or priorities, use get_outlook_briefing. Speak only the top 2-3 priorities; in chat use Top priorities / Emails needing action / Calendar / Next steps. Keep it high-level and avoid sender email addresses unless asked.",
      "- OUTLOOK REPLIES: for reply to latest email from someone, use prepare_outlook_reply, draft the reply, then wait for approval before sending.",
      "- EMAIL SILENCE: if the user is silent or audio is unclear after an email readback, wait quietly. Do not repeat the same confirmation prompt over and over.",
      "- Stay in the session. Do not end the conversation, say goodbye, or wind down even if the user is silent. Wait quietly for their next message.",
      "- INTERRUPTION: if the user starts speaking while you are talking, stop immediately mid-sentence and listen. Never talk over the user. Resume only after they finish.",
      "- BE CONCISE: keep spoken replies to 1-2 short sentences and under 25 words by default. Avoid long monologues so the user can interject naturally.",
      "- PROFESSIONAL INTELLIGENCE: behave like a competent chief-of-staff assistant. Lead with the useful answer/action, not filler. Avoid 'sure thing', 'absolutely', rambling, jokes, apologies loops, and casual throwaway phrases.",
      "- DO NOT ANSWER FRAGMENTS: if the transcript sounds partial, noisy, canceled mid-thought, or like the user is still thinking, wait. Do not invent meaning from weak audio. If genuinely unclear, ask one short repair question. If they say wait/cancel/never mind, say 'Okay — I’ll wait.'",
      "- NO GIBBERISH: never fill silence, think out loud, narrate internal steps, repeat random words, or say unrelated content. If uncertain, ask one concise question.",
      "- VISUAL CONTENT: for tables, comparisons, email drafts, documents, code, or long lists, keep speech short and let the chat transcript carry the text. Do not read long content out loud.",
      "- DOCUMENT GENERATION: you CAN create downloadable PDF, DOCX, Markdown, XLSX, CSV, and TXT files. For requests like 'create a PDF from that summary', 'export this', 'make a Word doc', or 'download this report', call generate_document immediately. Never say you cannot create files, PDFs, attachments, or downloads.",
      "- NO REPETITION: do NOT re-ask for information the user already provided in this thread (names, emails, recipients, dates, preferences). Read the prior conversation above first; if a detail is there, use it directly.",
      "- REMEMBER WITHIN THE TURN: once the user confirms something (a recipient, a draft, a choice), do not ask again in the same task. Move forward.",
      "- CAPABILITIES QUESTION: if asked what you can do, answer exactly one short sentence: 'I can help with research, email, calendar, PDFs/documents, comparisons, and BP Automation knowledge.'",
      "- ONE QUESTION AT A TIME: if you truly need missing info, ask only the single most important question, not a checklist.",
    ].join("\n");
    return history
      ? `Prior conversation in this thread (most recent last):\n${history}\n\n${rules}\n\nContinue naturally from here.`
      : `Voice mode is open. Wait for the user's next message.\n\n${rules}`;
  }

  async function startOpenAiVoice() {
    if (openAiSessionRef.current) return;
    setVoiceError(null);
    setVoiceUiState("starting");
    setVoicePhase("preflight");
    // Server-side preflight BEFORE prompting for mic. If OPENAI_API_KEY is
    // missing or the tools payload is broken, fail with a clear message
    // instead of asking for microphone permissions and then dying.
    const pre = await preflightOpenAiRealtime();
    if (!pre.ok) {
      const msg = pre.message ?? "OpenAI Realtime is not available.";
      setVoiceError(msg);
      toast.error(msg);
      setVoicePhase("failed");
      setVoiceUiState("idle");
      return;
    }
    let assistantBuf = "";
    // Document-intent loop guards use refs so repeated transcript fragments
    // and re-renders can't bypass the dedupe. Key = normalized text + format.
    const DOC_INTENT_COMPLETED_TTL_MS = 60_000;
    const detectFormat = (t: string): string => {
      const s = t.toLowerCase();
      if (/\bpdf\b/.test(s)) return "pdf";
      if (/\b(docx|word)\b/.test(s)) return "docx";
      if (/\b(xlsx|excel|spreadsheet)\b/.test(s)) return "xlsx";
      if (/\bcsv\b/.test(s)) return "csv";
      if (/\bmarkdown|\bmd\b/.test(s)) return "md";
      if (/\btxt|text file\b/.test(s)) return "txt";
      return "auto";
    };
	    const normalizeIntent = (t: string) =>
	      t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200) +
	      "|" +
	      detectFormat(t);
	    const isDocumentLimboReply = (t: string) =>
	      /\b(?:i can|i will|i'll|would you like|need .*overview|cannot|can't|unable)\b/i.test(t) &&
	      /\b(?:pdf|document|file|summary|report)\b/i.test(t);
	    const runDeterministicVoiceDocument = async (text: string, key: string) => {
	      setVoicePhase("generating-document");
	      setPendingAssistant(`Generating ${detectFormat(text).toUpperCase() === "AUTO" ? "document" : detectFormat(text).toUpperCase()}…`);
	      try {
	        const { data: sess } = await supabase.auth.getSession();
	        const token = sess.session?.access_token;
	        if (!token) throw new Error("Session expired. Please sign in again.");
	        const res = await fetch("/api/chat", {
	          method: "POST",
	          headers: {
	            "Content-Type": "application/json",
	            Authorization: `Bearer ${token}`,
	          },
	          body: JSON.stringify({
	            threadId,
	            content: text,
	            attachments: [],
	            voiceDocIntent: true,
	          }),
	        });
	        if (!res.ok || !res.body) {
	          throw new Error((await res.text().catch(() => "")) || `Document generation failed (${res.status}).`);
	        }
	        const reader = res.body.getReader();
	        const decoder = new TextDecoder();
	        let acc = "";
	        while (true) {
	          const { value, done } = await reader.read();
	          if (done) break;
	          acc += decoder.decode(value, { stream: true });
	          setPendingAssistant(cleanAssistantText(acc));
	        }
	        docIntentFailureCountRef.current.delete(key);
	        lastDocumentIntentCompletedAtRef.current = Date.now();
	        toast.success("Document generated.");
	      } catch (err) {
	        const n = (docIntentFailureCountRef.current.get(key) ?? 0) + 1;
	        docIntentFailureCountRef.current.set(key, n);
	        if (n < DOC_MAX_FAILURES_PER_INTENT) {
	          lastDocumentIntentKeyRef.current = "";
	        }
	        toast.error(err instanceof Error ? err.message : "Document generation failed.");
	      } finally {
	        docInFlightRef.current = false;
	        setVoicePhase("live");
	        setPendingAssistant("");
	        qc.invalidateQueries({ queryKey: ["messages", threadId] });
	        qc.invalidateQueries({ queryKey: ["threads"] });
	      }
	    };
	    try {
      const session = await startOpenAiRealtimeSession({
        context: buildVoiceContext(),
        onPhase: (p, detail) => {
          setVoicePhase(p);
          if (p === "failed" && detail) setVoiceError(detail);
        },
      });
      openAiSessionRef.current = session;
      session.onOpen(() => {
        setVoiceUiState("connected");
        setVoicePhase("live");
      });
      session.onClose(() => {
        openAiSessionRef.current = null;
        setVoiceUiState("idle");
        setVoicePhase("idle");
      });
      session.onError((message) => {
        toast.error(message);
        setVoiceError(message);
        if (docInFlightRef.current) {
          docInFlightRef.current = false;
          lastDocumentIntentCompletedAtRef.current = Date.now();
          setVoicePhase("live");
        }
      });
      session.onToolCall((name, _args, result) => {
        if (name !== "generate_document") return;
        const r = result as { ok?: boolean; artifact?: Record<string, unknown> } | null;
        docInFlightRef.current = false;
        lastDocumentIntentCompletedAtRef.current = Date.now();
        setVoicePhase("live");
        if (!r?.ok || !r.artifact) {
          const errMsg =
            (r && typeof (r as { error?: unknown }).error === "string"
              ? ((r as { error?: string }).error as string)
              : null) ?? "Document generation failed.";
          toast.error(errMsg);
          // Track failures per intent-key. After N failures, KEEP the key so
          // repeated identical utterances no longer re-trigger the doc path
          // for the completed-TTL window — this prevents infinite loops when
          // the generator or model keeps returning errors.
          const key = lastDocumentIntentKeyRef.current;
          if (key) {
            const n = (docIntentFailureCountRef.current.get(key) ?? 0) + 1;
            docIntentFailureCountRef.current.set(key, n);
            if (n >= DOC_MAX_FAILURES_PER_INTENT) {
              console.warn(
                "[realtime] doc-intent locked after repeated failures — will not retry same utterance",
                { key, failures: n },
              );
              // Leave key + completed timestamp set so the TTL blocks repeats.
            } else {
              // Clear so the user can retry with same utterance.
              lastDocumentIntentKeyRef.current = "";
            }
          }
          return;
        }
        // Success — clear failure counter for this key.
        docIntentFailureCountRef.current.delete(lastDocumentIntentKeyRef.current);
        const block = "```bpa-artifact\n" + JSON.stringify(r.artifact) + "\n```";
        const content = `Generated ${(r.artifact.filename as string) ?? "document"}.\n\n${block}`;
        void add({ data: { threadId, role: "assistant", content } }).then(() => {
          qc.invalidateQueries({ queryKey: ["messages", threadId] });
        });
        // Keep lastDocumentIntentKey set; completed-TTL blocks repeats for 60s.
      });
      session.onTranscript((role, text, done) => {
	        if (role === "assistant") {
	          assistantBuf = text;
	          if (!docInFlightRef.current) setPendingAssistant(text);
	          if (done && text.trim()) {
	            const recentlyHandledDoc =
	              Date.now() - lastDocumentIntentCompletedAtRef.current < DOC_INTENT_COMPLETED_TTL_MS;
	            if (docInFlightRef.current || (recentlyHandledDoc && isDocumentLimboReply(text))) {
	              setPendingAssistant("");
	              assistantBuf = "";
	              return;
	            }
	            setPendingUserVoice("");
	            void add({ data: { threadId, role: "assistant", content: text } }).then(() => {
	              qc.invalidateQueries({ queryKey: ["messages", threadId] });
            });
            setPendingAssistant("");
            assistantBuf = "";
          }
        } else if (role === "user" && !done) {
          // Interim user transcript — surface a live "you're saying…"
          // bubble so the chat updates in real time while listening.
          setPendingUserVoice(text);
        } else if (role === "user" && done && text.trim()) {
          setPendingUserVoice("");
          void add({ data: { threadId, role: "user", content: text } }).then(() => {
            qc.invalidateQueries({ queryKey: ["messages", threadId] });
          });
          if (looksLikeDocumentIntent(text)) {
            const key = normalizeIntent(text);
            const now = Date.now();
            const completedRecently =
              key === lastDocumentIntentKeyRef.current &&
              now - lastDocumentIntentCompletedAtRef.current <
                DOC_INTENT_COMPLETED_TTL_MS;
            if (docInFlightRef.current) {
              console.log("[realtime] doc-intent ignored — generation already in flight");
            } else if (completedRecently) {
              console.log("[realtime] doc-intent ignored — same intent completed within 60s");
            } else {
              lastDocumentIntentKeyRef.current = key;
              docInFlightRef.current = true;
              setVoicePhase("generating-document");
	              console.log("[realtime] doc-intent detected, using deterministic document route:", text);
	              void runDeterministicVoiceDocument(text, key);
	              // Safety: if the tool call never resolves, release the lock.
	              setTimeout(() => {
                if (docInFlightRef.current) {
                  console.warn("[realtime] doc-intent lock released by timeout");
                  docInFlightRef.current = false;
                  lastDocumentIntentCompletedAtRef.current = Date.now();
                  setVoicePhase("live");
                  // Count the timeout as a failure for repeat suppression.
                  const k = lastDocumentIntentKeyRef.current;
                  if (k) {
                    const n = (docIntentFailureCountRef.current.get(k) ?? 0) + 1;
                    docIntentFailureCountRef.current.set(k, n);
                  }
                }
              }, 45_000);
            }
          }
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "OpenAI voice failed to start.";
      setVoiceError(msg);
      toast.error(msg);
      setVoiceUiState("idle");
      setVoicePhase("failed");
      openAiSessionRef.current = null;
    }
  }

  async function stopOpenAiVoice() {
    const s = openAiSessionRef.current;
    openAiSessionRef.current = null;
    setVoiceUiState("stopping");
    setVoicePhase("idle");
    try { await s?.stop(); } catch (err) { console.warn(err); }
    setPendingAssistant("");
    setPendingUserVoice("");
    setVoiceUiState("idle");
  }

  async function startVoice() {
    if (voiceUiState === "starting" || voiceUiState === "connected") return;
    if (voiceProvider === "none") {
      toast.error("Voice is disabled in settings.");
      return;
    }
    await startOpenAiVoice();
  }

  async function stopVoice() {
    if (openAiSessionRef.current) await stopOpenAiVoice();
  }

  const addMut = useMutation({
    mutationFn: async ({ content, files, regenerate }: { content: string; files: Attachment[]; regenerate?: boolean }) => {
      if (!regenerate) setPendingUser(content);
      setPendingAssistant("");

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
        body: JSON.stringify({ threadId, content, attachments: files, regenerate }),
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
        const msg = await res.text().catch(() => "Request failed");
        toast.error(msg || "BPA Bot is unavailable");
        setPendingUser(null);
        return;
      }

      // user message was saved server-side; reflect it locally
      qc.invalidateQueries({ queryKey: ["messages", threadId] });
      setPendingUser(null);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setPendingAssistant(cleanAssistantText(acc));
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
      setPendingAssistant("");
      abortRef.current = null;
      qc.invalidateQueries({ queryKey: ["messages", threadId] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: (e) => {
      if ((e as Error).name === "AbortError") return;
      toast.error(e instanceof Error ? e.message : "Failed");
      setPendingUser(null);
      setPendingAssistant("");
    },
  });

  function stopGenerating() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function regenerate() {
    if (addMut.isPending) return;
    if (voiceActive) {
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
    addMut.mutate({ content: v || (files.length === 1 ? `Sent: ${files[0].name}` : `Sent ${files.length} files`), files });
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
    navigate({ to: "/auth" });
  }

  const voiceStopping = voiceUiState === "stopping";
  const voiceActive =
    voiceUiState === "connected" ||
    voiceUiState === "reconnecting" ||
    voiceStopping ||
    voiceUiState === "starting";
  const voiceConnecting = voiceUiState === "starting";
  const voiceReconnecting = voiceUiState === "reconnecting";

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
              <img src={BPA_LOGO_SRC} alt="BP Automation" className="h-8 w-auto mb-2" />
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
          to="/quality"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-2 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <FlaskConical size={12} /> Quality Lab
        </Link>
        <Link
          to="/settings"
          onClick={() => setSidebarOpen(false)}
          className="mx-4 mt-2 flex items-center gap-2 justify-center py-2 rounded-md border border-border bg-card hover:bg-secondary text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <SettingsIcon size={12} /> Assistant settings
        </Link>
        {voiceProvider === "openai_realtime" && (
          <div className="mx-4 mt-3 rounded-md border border-border bg-card p-2.5">
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="font-medium text-foreground">OpenAI Voice</span>
              <span className={voiceActive || voicePhase === "failed" ? (voicePhase === "failed" ? "text-destructive font-semibold" : "text-primary font-semibold") : "text-muted-foreground"}>
                {(() => {
                  if (voicePhase === "failed") return "Failed";
                  if (voicePhase === "generating-document") return "Generating doc…";
                  if (voicePhase === "requesting-mic") return "Mic prompt…";
                  if (voicePhase === "preflight") return "Checking…";
                  if (voicePhase === "connecting") return "Connecting…";
                  if (voicePhase === "live" || voiceUiState === "connected") return "Live";
                  if (voiceActive) return voiceUiState;
                  return "Idle";
                })()}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              {voiceActive && voiceSessionStart
                ? `Session ${fmtElapsed(voiceElapsed)} · ${costMode}`
                : `Mode: ${costMode} · usage billed to OpenAI`}
            </div>
            {voiceError && voicePhase === "failed" && (
              <div className="mt-1.5 text-[10px] text-destructive leading-snug">
                {voiceError}
              </div>
            )}
          </div>
        )}
        {voiceProvider === "none" && (
          <div className="mx-4 mt-3 rounded-md border border-border bg-card p-2.5 text-[11px] text-muted-foreground">
            Voice off · text only
          </div>
        )}
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
          {voiceProvider === "openai_realtime" ? (
            <span
              title={voiceActive ? `OpenAI Voice live · ${fmtElapsed(voiceElapsed)}` : `OpenAI Voice idle · ${costMode}`}
              className={
                "ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full " +
                (voiceActive ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")
              }
            >
              {voiceActive ? `🎙 OpenAI live · ${fmtElapsed(voiceElapsed)}` : "🎙 OpenAI idle"}
            </span>
          ) : (
            <span className="ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
              Voice off
            </span>
          )}
          <div className="relative ml-1">
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
                <h2 className="text-xl md:text-2xl font-semibold text-foreground">Hey, I'm BPA Bot.</h2>
                <p className="text-sm text-muted-foreground mt-1">I can research, compare options, draft emails, create files, and help you get work done. What do you want to tackle?</p>
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
                  onQuickReply={(text) => addMut.mutate({ content: text, files: [] })}
                  onPrefill={setInput}
                />
              );
            })}
            {pendingUser && <Bubble role="user" content={pendingUser} />}
            {pendingUserVoice.trim() && (
              <Bubble role="user" content={pendingUserVoice + " …"} streaming />
            )}
            {(() => {
              const p = pendingAssistant.trim();
              if (!p) return null;
              // Hide the streaming bubble if any recent assistant message
              // already contains (or matches the start of) this text — that
              // means the saved message has caught up and the pending bubble
              // is just a stale ghost from a prior partial stream.
              const recent = messages.slice(-3);
              const norm = (s: string) => s.trim().replace(/\s+/g, " ");
              const pn = norm(p);
              const head = pn.slice(0, 60);
              for (const m of recent) {
                if (m.role !== "assistant") continue;
                const mn = norm(m.content || "");
                if (!mn) continue;
                if (mn === pn || mn.startsWith(pn) || pn.startsWith(mn) || mn.includes(head)) {
                  return null;
                }
              }
              return <Bubble role="assistant" content={pendingAssistant} streaming />;
            })()}
            {addMut.isPending && !pendingAssistant && !voiceActive && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-semibold shrink-0">BP</div>
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
                <div
                  key={a.path}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 py-1 text-xs text-foreground"
                >
                  {a.mimeType.startsWith("image/") ? <ImageIcon size={12} /> : <FileText size={12} />}
                  <span className="max-w-[160px] truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((cur) => cur.filter((x) => x.path !== a.path))
                    }
                    className="text-muted-foreground hover:text-destructive ml-1"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {uploading && (
                <span className="text-xs text-muted-foreground self-center">Uploading…</span>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (voiceStopping) return;
              if (voiceActive) void stopVoice();
              else void startVoice();
            }}
            title={
              voicePhase === "preflight"
                ? "Checking voice service…"
                : voicePhase === "requesting-mic"
                ? "Waiting for microphone permission…"
                : voicePhase === "connecting"
                ? "Connecting to OpenAI Realtime…"
                : voicePhase === "generating-document"
                ? "Generating document — tap to stop"
                : voiceStopping
                ? "Stopping voice…"
                : voiceReconnecting
                ? "Reconnecting… tap to stop"
                : voiceActive
                ? "Voice is live — tap to stop"
                : "Tap to talk"
            }
            aria-label={voiceActive ? "Stop voice mode" : "Start voice mode"}
            disabled={voiceStopping}
            className={`relative shrink-0 h-10 rounded-full border font-semibold transition-all duration-200 ${
              voiceActive
                ? "w-[8.25rem] border-destructive bg-destructive text-destructive-foreground shadow-lg shadow-destructive/30"
                : "w-10 border-border bg-secondary hover:bg-secondary/80 text-primary"
            }`}
          >
            <span className="relative z-10 flex h-full items-center justify-center gap-2 px-3">
              {voiceActive ? <Square size={14} fill="currentColor" /> : <Mic size={18} />}
              {voiceActive && (
                <span className="flex items-center gap-1.5 text-xs uppercase">
                  <span className="h-2 w-2 rounded-full bg-destructive-foreground" />
                  {voicePhase === "generating-document"
                    ? "Doc…"
                    : voicePhase === "requesting-mic"
                    ? "Mic…"
                    : voicePhase === "preflight"
                    ? "Check…"
                    : voicePhase === "connecting"
                    ? "Conn…"
                    : "Stop voice"}
                </span>
              )}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown"
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Attach file"
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center border border-border bg-secondary hover:bg-secondary/80 text-primary disabled:opacity-40"
          >
            <Paperclip size={16} />
          </button>
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
              voicePhase === "requesting-mic"
                ? "Allow microphone to continue…"
                : voicePhase === "preflight"
                ? "Checking voice service…"
                : voicePhase === "connecting"
                ? "Connecting to OpenAI…"
                : voicePhase === "generating-document"
                ? "Generating document…"
                : voiceReconnecting
                ? "Reconnecting voice…"
                : voiceActive
                ? "Listening… or type"
                : "Message BPA Bot…"
            }
            className="flex-1 bg-transparent outline-none px-3 py-2 text-[15px] leading-6 resize-none max-h-[220px] min-h-[40px]"
          />
          {addMut.isPending && !voiceActive ? (
            <button
              type="button"
              onClick={stopGenerating}
              className="px-4 py-2 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 flex items-center gap-2"
              title="Stop generating"
            >
              <Square size={14} /> Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={(!input.trim() && attachments.length === 0) || uploading}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 flex items-center gap-2"
            >
              <Send size={14} /> Send
            </button>
          )}
          </div>
          </div>
        </form>
        {/* Regenerate action below composer when there's an assistant message and we're idle */}
        {!addMut.isPending && !voiceActive && messages.some((m) => m.role === "assistant") && (
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

function Bubble({
  role,
  content,
  attachments = [],
  streaming = false,
  messageId,
  onQuickReply,
  onPrefill,
}: {
  role: string;
  content: string;
  attachments?: Array<{ path: string; name: string; mimeType: string; size?: number }>;
  streaming?: boolean;
  messageId?: string;
  onQuickReply?: (text: string) => void;
  onPrefill?: (text: string) => void;
}) {
  const isUser = role === "user";
  const displayContent = isUser ? content : cleanAssistantText(content);
  const approvalCard = !isUser && !streaming ? parseApprovalCard(displayContent) : null;
  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] min-w-0 overflow-x-auto rounded-2xl rounded-tr-md px-4 py-2.5 text-[15px] leading-relaxed bg-primary text-primary-foreground">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a) => (
                <div
                  key={a.path}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs bg-primary-foreground/15 text-primary-foreground"
                >
                  {a.mimeType.startsWith("image/") ? "🖼️" : "📎"}
                  <span className="max-w-[180px] truncate">{a.name}</span>
                </div>
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
      <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-semibold shrink-0 mt-0.5">
        BP
      </div>
      <div className="flex-1 min-w-0">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <div
                key={a.path}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs bg-secondary text-foreground border border-border"
              >
                {a.mimeType.startsWith("image/") ? "🖼️" : "📎"}
                <span className="max-w-[180px] truncate">{a.name}</span>
              </div>
            ))}
          </div>
        )}
        <div
          className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-table:my-3 prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-md prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.9em] prose-a:text-accent prose-a:underline-offset-2 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground"
        >
          {approvalCard && (
            <ApprovalCard
              data={approvalCard}
              onQuickReply={onQuickReply}
              onPrefill={onPrefill}
            />
          )}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ node: _n, ...props }) => (
                <div className="my-3 -mx-1 overflow-x-auto rounded-md border border-border">
                  <table {...props} className="w-full min-w-max border-collapse text-sm" />
                </div>
              ),
              code: ({ inline, className, children, ...props }: {
                inline?: boolean;
                className?: string;
                children?: React.ReactNode;
              }) => {
                const lang = /language-(\w[\w-]*)/.exec(className ?? "")?.[1];
                if (!inline && lang === "bpa-artifact") {
                  const raw = String(children ?? "").trim();
                  try {
                    const data = JSON.parse(raw) as {
                      title?: string;
                      format?: string;
                      filename?: string;
                      url?: string;
                      createdAt?: string;
                    };
                    if (data.url) return <ArtifactCard data={data} />;
                  } catch {
                    /* fall through */
                  }
                }
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >{displayContent}</ReactMarkdown>
          {streaming && (
            <span className="inline-block w-1.5 h-4 align-[-2px] ml-0.5 bg-foreground/70 animate-pulse rounded-sm" />
          )}
        </div>
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

function ArtifactCard({
  data,
}: {
  data: { title?: string; format?: string; filename?: string; url?: string; createdAt?: string };
}) {
  const fmt = (data.format ?? "").toUpperCase();
  const created = data.createdAt ? new Date(data.createdAt) : null;
  const createdLabel = created
    ? created.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;
  const Icon =
    fmt === "PDF"
      ? FileType2
      : fmt === "DOCX"
        ? FileText
        : fmt === "XLSX" || fmt === "CSV"
          ? FileSpreadsheet
          : FileText;
  return (
    <div className="not-prose my-3 flex items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {data.title || data.filename || "Document"}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {fmt && <span className="rounded bg-secondary px-1.5 py-0.5 font-medium">{fmt}</span>}
          {data.filename && <span className="truncate">{data.filename}</span>}
          {createdLabel && <span>· {createdLabel}</span>}
        </div>
      </div>
      {data.url && (
        <div className="flex shrink-0 items-center gap-1.5">
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/80"
          >
            Open
          </a>
          <a
            href={data.url}
            download={data.filename}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download size={12} /> Download
          </a>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  data,
  onQuickReply,
  onPrefill,
}: {
  data: ApprovalCardData;
  onQuickReply?: (text: string) => void;
  onPrefill?: (text: string) => void;
}) {
  const isEmail = data.kind === "email";
  const approveText = isEmail ? "send" : "create";
  const editText = isEmail
    ? `Change this email: `
    : `Change this calendar event: `;
  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-primary/25 bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b border-border bg-primary/5 px-3 py-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {isEmail ? <Mail size={18} /> : <Check size={18} />}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{data.title}</div>
          <div className="text-xs text-muted-foreground">
            Review it, then approve once. No repeated confirmation loop.
          </div>
        </div>
      </div>

      <div className="grid gap-2 px-3 py-3 text-sm">
        {isEmail ? (
          <>
            <ApprovalRow label="To" value={data.to} />
            <ApprovalRow label="Cc" value={data.cc} />
            <ApprovalRow label="Subject" value={data.subject} />
            {data.body && (
              <div className="mt-1 rounded-md border border-border bg-background p-2">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Body preview
                </div>
                <div className="max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                  {data.body}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <ApprovalRow label="Title" value={data.eventTitle} />
            <ApprovalRow label="When" value={data.dateTime} />
            <ApprovalRow label="Attendees" value={data.attendees} />
            <ApprovalRow label="Location" value={data.location} />
            <ApprovalRow label="Description" value={data.description} />
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border bg-background/60 px-3 py-2.5">
        <button
          type="button"
          onClick={() => onQuickReply?.(approveText)}
          disabled={!onQuickReply}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Check size={13} /> {isEmail ? "Send email" : "Create event"}
        </button>
        <button
          type="button"
          onClick={() => onPrefill?.(editText)}
          disabled={!onPrefill}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => onQuickReply?.("cancel")}
          disabled={!onQuickReply}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          <X size={13} /> Cancel
        </button>
      </div>
    </div>
  );
}

function ApprovalRow({ label, value }: { label: string; value?: string }) {
  if (!value || value === "(none specified)" || value === "(none)") return null;
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 break-words text-foreground">{value}</div>
    </div>
  );
}
