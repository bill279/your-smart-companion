import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRealtimeVoice, type RealtimeToolDef } from "@/lib/useRealtimeVoice";
import { createRealtimeSession } from "@/lib/realtime-voice.functions";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, Plus, Trash2, LogOut, Send, Menu, X, ArrowDown, Users, Paperclip, FileText, Image as ImageIcon, Search, Square, RotateCcw, Download, Printer, Mail, MoreVertical, Sparkles, BookOpen, FileSpreadsheet, FileType2, Copy, Check, ThumbsUp, ThumbsDown, Globe, ShoppingBag, ExternalLink } from "lucide-react";
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

const VOICE_SESSION_PROMPT = `You are BPA Bot, BP Automation's assistant. Continue the active conversation; do not introduce yourself, do not greet again, and do not say your name unless asked.

Format answers for this chat UI. If the user asks for a table, visual table, comparison, schedule, specs, rows/columns, or tabular data, output a GitHub-Flavored Markdown table using pipes, for example:
| Item | Detail |
| --- | --- |
| Example | Value |

Never say you are unable to display a visual table directly in this chat interface. The interface renders Markdown tables. Be concise and contribute directly to the conversation.

TOOL USE — non-negotiable:
- For ANY table, comparison, list, code block, email draft, or long structured content: CALL the show_in_chat tool with the markdown. Do NOT read the content aloud. After the tool returns, say ONE short spoken sentence like "Here's the table" or "I've put the draft in the chat."
- For ANY factual question about real companies, people, prices, addresses, news, or anything time-sensitive: CALL web_search FIRST. Never invent facts, addresses, phone numbers, or pricing.
- If the user asks you to create, generate, export, save, or convert something to a PDF, Word document, DOCX, Excel, XLSX, or CSV: CALL the generate_document tool. NEVER say you cannot generate a file, and NEVER tell the user to copy the content into Word or Google Docs. The tool shows the file as a preview card in the chat — it does NOT auto-download. After calling, say something like "I've put the document in the chat — you can preview it, download it, or ask me to email it." Do NOT say "downloading now." Choose a sensible short filename.
- If the user asks you to email a document you just generated (e.g. "email me that Word doc"): call send_email with attach_last_document=true so the file is attached. Confirm the recipient address first.`;

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
  return "Voice failed to connect. Tap the mic once to try again.";
}

// Realtime voice tool catalog. Passed to OpenAI Realtime via session.update.
const REALTIME_TOOL_DEFS: RealtimeToolDef[] = [
  {
    type: "function",
    name: "show_in_chat",
    description:
      "Render rich markdown (tables, lists, code, long drafts, email drafts) directly in the chat WITHOUT speaking it. Use this whenever the user asks for a table, list, code, or any long content. Then say a brief one-sentence spoken summary — never read the content aloud.",
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
      "Send an email on the user's behalf. ALWAYS confirm the recipient address out loud first and wait for explicit approval before calling. Set attach_last_document=true to attach the most recent document you generated via generate_document.",
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
    name: "generate_document",
    description:
      "Generate a document file (PDF, DOCX, XLSX, or CSV) from provided content and show it as a preview card in the chat (with Download and Email buttons). Does NOT auto-download. Use whenever the user asks to create, export, save, or convert content to a file. NEVER refuse; NEVER tell the user to copy into another app. After calling, briefly confirm out loud, e.g. 'I've put the Word doc in the chat — let me know if you want to email it or make edits.' Do NOT say the file is downloading.",
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
          description: "Document title / filename base (no extension).",
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
  const createSession = useServerFn(createRealtimeSession);
  const createUploadUrl = useServerFn(createChatUploadUrl);
  const searchFn = useServerFn(searchChats);

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });
  const messagesQ = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getMsgs({ data: { threadId } }),
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
  const idleTimerRef = useRef<number | null>(null);
  const liveAssistantRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
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
    clientTools: {
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
      generate_document: async (params) => {
        const p = params as {
          format?: string;
          title?: string;
          content?: string;
        };
        const format = (p.format ?? "pdf").toLowerCase();
        const title = (p.title ?? "BPA Bot document").slice(0, 80);
        const content = String(p.content ?? "").trim();
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
      if (!text) return;
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
          await add({ data: { threadId, role: "user", content: text } });
          await qc.invalidateQueries({ queryKey: ["messages", threadId] });
          setPendingUser(null);
        } else if (message.source === "ai") {
          const cleaned = cleanAssistantText(text);
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
      "- FILE EXPORTS: if the user asks to create, generate, export, download, save, or convert to PDF, Word, DOCX, Excel, XLSX, or CSV, CALL the generate_document tool. Never say you cannot make a file. Never tell them to copy into Word or Google Docs.",
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
    return history
      ? `Prior conversation in this thread (most recent last):\n${history}\n\n${rules}\n\nContinue naturally from here.`
      : `Voice mode is open. Wait for the user's next message.\n\n${rules}`;
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
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const session = await createSession({});
      if (startAttemptRef.current !== attemptId) {
        stopMediaStream(microphoneStream);
        return;
      }
      const instructions = `${VOICE_SESSION_PROMPT}\n\n${buildVoiceContext()}`;
      pendingContextRef.current = "";
      clearVoiceConnectTimeout();
      connectTimeoutRef.current = window.setTimeout(() => {
        if (startAttemptRef.current !== attemptId || voiceStateRef.current !== "starting") return;
        setVoiceState("idle");
        pendingContextRef.current = "";
        setVoiceError("Voice took too long to connect. Tap the mic once to try again.");
        try { conversationRef.current?.endSession(); } catch (err) { console.warn(err); }
      }, 20000);
      await conversation.startSession({
        clientSecret: session.clientSecret,
        model: session.model,
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

      // If voice is connected, route through ElevenLabs instead.
      if (isConnected && !regenerate) {
        voiceUserHasSpokenRef.current = true;
        try { conversation.setVolume({ volume: 1 }); } catch (err) { console.warn(err); }
        await add({ data: { threadId, role: "user", content } });
        conversation.sendUserMessage(content);
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
            className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center border transition ${
              voiceActive
                ? "border-red-500 bg-red-500 text-white hud-pulse shadow-[0_0_0_4px_rgba(239,68,68,0.25)]"
                : "border-border bg-secondary hover:bg-secondary/80 text-primary"
            }`}
          >
            <Mic size={18} />
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
          <button
            type="button"
            onClick={() => setWebSearchOn((v) => !v)}
            title={webSearchOn ? "Web search is ON for the next message" : "Force web search for the next message"}
            aria-pressed={webSearchOn}
            className={`shrink-0 h-10 px-3 rounded-full flex items-center gap-1.5 border text-sm transition ${
              webSearchOn
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-secondary hover:bg-secondary/80 text-muted-foreground"
            }`}
          >
            <Globe size={14} />
            <span className="hidden sm:inline">Search web</span>
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
              voiceConnecting
                ? "Connecting voice…"
                : voiceActive
                ? conversation.isSpeaking
                  ? "BPA Bot is speaking…"
                  : "Listening… or type"
                : "Message BPA Bot…"
            }
            className="flex-1 bg-transparent outline-none px-3 py-2 text-[15px] leading-6 resize-none max-h-[220px] min-h-[40px]"
          />
          {addMut.isPending && !isConnected ? (
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
    .trim();
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
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
        <img src={bpaLogo.url} alt="BPA Bot" className="w-full h-full object-contain p-1" />
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
        {activities.length > 0 && <ToolActivityList items={activities} streaming={streaming} />}
        <div
          className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-table:my-3 prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-md prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.9em] prose-a:text-accent prose-a:underline-offset-2 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ node: _n, ...props }) => (
                <div className="my-3 -mx-1 overflow-x-auto rounded-md border border-border">
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      {items.map((a, idx) => {
        const isLast = idx === items.length - 1;
        const pending =
          streaming && isLast && !a.results && !a.scraped && !a.products && !a.error;
        const isOpen = expandedId === a.id;
        const label =
          a.name === "web_search"
            ? pending
              ? `Searching the web…`
              : `Searched the web`
            : a.name === "product_search"
              ? pending
                ? `Finding products…`
                : `Found products`
              : pending
                ? `Opening ${hostOf(a.url) || "page"}…`
                : `Read ${hostOf(a.url) || "page"}`;
        const canExpand =
          a.name === "web_search" && (a.results?.length ?? 0) > 0;
        const hasProducts = a.name === "product_search" && (a.products?.length ?? 0) > 0;
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
                  {a.results?.length} result{(a.results?.length ?? 0) === 1 ? "" : "s"}
                </span>
              )}
              {!pending && hasProducts && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {a.products?.length} product{(a.products?.length ?? 0) === 1 ? "" : "s"}
                </span>
              )}
            </button>
            {isOpen && a.results && a.results.length > 0 && (
              <div className="border-t border-border bg-background/40 divide-y divide-border">
                {a.results.map((r, i) => {
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
  const canPreview = ["pdf", "docx", "csv", "txt", "md"].includes(ext);

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
        setPreviewHtml(value || "<p><em>Document is empty.</em></p>");
      } else if (ext === "csv" || ext === "txt" || ext === "md") {
        setPreviewText(await blob.text());
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
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <FileText size={18} />
      </div>
      <button
        type="button"
        onClick={canPreview ? openPreview : () => downloadArtifact(art)}
        className="min-w-0 flex-1 text-left hover:opacity-80 transition"
      >
        <div className="text-sm font-medium truncate">{art.filename}</div>
        <div className="text-xs text-muted-foreground">
          {art.formatLabel} · {formatBytes(art.size)}
        </div>
      </button>
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
