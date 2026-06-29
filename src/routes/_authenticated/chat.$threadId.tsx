import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useConversation, ConversationProvider } from "@elevenlabs/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Plus, Trash2, LogOut, Send, Menu, X, ArrowDown, Users, Paperclip, FileText, Image as ImageIcon, Search, Square, RotateCcw, Download, Printer, Mail, MoreVertical, Sparkles, BookOpen } from "lucide-react";
import { toast } from "sonner";
import bpaLogo from "@/assets/bpa-logo.png.asset.json";
import {
  addMessage,
  createThread,
  deleteThread,
  getElevenLabsAgentSignedUrl,
  getThreadMessages,
  listThreads,
  renameThread,
  searchChats,
} from "@/lib/jarvis.functions";
import { createChatUploadUrl } from "@/lib/uploads.functions";
import { getVoiceQuota } from "@/lib/voice-quota.functions";
import { supabase } from "@/integrations/supabase/client";
import { exportChatToPdf, exportChatToDocx, exportChatToXlsx, type ChatMsg } from "@/lib/export-chat";

const VOICE_SESSION_PROMPT = `You are BPA Bot, BP Automation's assistant. Continue the active conversation; do not introduce yourself, do not greet again, and do not say your name unless asked.

Format answers for this chat UI. If the user asks for a table, visual table, comparison, schedule, specs, rows/columns, or tabular data, output a GitHub-Flavored Markdown table using pipes, for example:
| Item | Detail |
| --- | --- |
| Example | Value |

Never say you are unable to display a visual table directly in this chat interface. The interface renders Markdown tables. Be concise and contribute directly to the conversation.`;

// (Voice agent prompt is configured in ElevenLabs; keep this for reference / contextual updates.)

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

// While the assistant is streaming, a markdown table is incomplete until the
// second row (the |---|---| separator) arrives. Showing the raw pipes mid-stream
// looks like garbled text, especially during voice. Detect an unfinished table
// at the end of the buffer and replace it with a tidy placeholder until done.
function hidePartialTables(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  // Walk the buffer and hide ANY incomplete table block — not just trailing ones.
  // During streaming, the bot may emit header rows for several tables before the
  // separator/body arrives. Showing raw pipes mid-stream looks like garbled text.
  const out: string[] = [];
  let i = 0;
  const isPipeLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = (l: string) => /^\s*\|?\s*:?-{3,}/.test(l);
  while (i < lines.length) {
    if (isPipeLine(lines[i])) {
      let j = i;
      while (j < lines.length && isPipeLine(lines[j])) j++;
      const block = lines.slice(i, j);
      const hasSep = block.some(isSeparator);
      const isTrailing = j === lines.length;
      // Treat as incomplete if: no separator yet, or it's the trailing block
      // and only has 1–2 rows (still being written).
      if (!hasSep || (isTrailing && block.length < 3)) {
        out.push("_Building table…_");
      } else {
        out.push(...block);
      }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
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
  return (
    <ConversationProvider>
      <ThreadView key={threadId} threadId={threadId} />
    </ConversationProvider>
  );
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
  const getAgentSignedUrl = useServerFn(getElevenLabsAgentSignedUrl);
  const createUploadUrl = useServerFn(createChatUploadUrl);
  const searchFn = useServerFn(searchChats);

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });
  const messagesQ = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getMsgs({ data: { threadId } }),
  });

  const [input, setInput] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string>("");
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
  const conversationRef = useRef<ReturnType<typeof useConversation> | null>(null);
  const seenVoiceEventsRef = useRef<Set<string>>(new Set());
  const voiceStateRef = useRef<VoiceUiState>("idle");
  const startAttemptRef = useRef(0);
  const connectTimeoutRef = useRef<number | null>(null);
  const hasConnectedVoiceRef = useRef(false);
  const voiceUserHasSpokenRef = useRef(false);
  const liveAssistantRef = useRef<string>("");
  const lastAssistantTextRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = () => setExportOpen(false);
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [exportOpen]);

  const messages = messagesQ.data ?? [];

  const voiceQuotaFn = useServerFn(getVoiceQuota);
  const voiceQuotaQ = useQuery({
    queryKey: ["voiceQuota"],
    queryFn: () => voiceQuotaFn(),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const quota = voiceQuotaQ.data;
  const quotaTone =
    quota && quota.available
      ? quota.percentUsed >= 95
        ? "danger"
        : quota.percentUsed >= 80
        ? "warn"
        : "ok"
      : "unknown";
  const warnedQuotaRef = useRef<string | null>(null);
  useEffect(() => {
    if (!quota || !quota.available || quota.limit <= 0) return;
    const key = quotaTone;
    if (warnedQuotaRef.current === key) return;
    if (quotaTone === "danger") {
      toast.error(`Voice quota ${quota.percentUsed}% used — ${quota.remaining.toLocaleString()} chars left.`);
      warnedQuotaRef.current = key;
    } else if (quotaTone === "warn") {
      toast.warning(`Voice quota ${quota.percentUsed}% used.`);
      warnedQuotaRef.current = key;
    } else {
      warnedQuotaRef.current = key;
    }
  }, [quota, quotaTone]);

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

  const conversation = useConversation({
    clientTools: {
      web_search: async (params: { query?: string; limit?: number }) => {
        const query = params.query?.trim();
        if (!query) return JSON.stringify({ error: "query required" });

        const res = await fetch("/api/public/web-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit: params.limit ?? 5 }),
        });
        const data = await res.json().catch(() => ({ error: "search failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "search failed" });
        return JSON.stringify(data);
      },
      send_email: async (params: { to?: string; subject?: string; body?: string; cc?: string }) => {
        if (!params.to || !params.subject || !params.body) {
          return JSON.stringify({ error: "to, subject and body are required" });
        }
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return JSON.stringify({ error: "not signed in" });
        const res = await fetch("/api/public/jarvis/tools/send_email", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(params),
        });
        const data = await res.json().catch(() => ({ error: "send failed" }));
        if (!res.ok) return JSON.stringify({ error: data?.error ?? "send failed" });
        return JSON.stringify(data);
      },
    },
    onAgentChatResponsePart: (part: { text?: string; type?: "start" | "delta" | "stop"; event_id?: number }) => {
      // Stream agent text to the chat in real time as ElevenLabs generates it.
      const kind = part?.type;
      const chunk = part?.text ?? "";
      if (kind === "start") {
        liveAssistantRef.current = chunk;
      } else if (kind === "delta") {
        liveAssistantRef.current += chunk;
      } else if (kind === "stop") {
        if (chunk) liveAssistantRef.current += chunk;
      }
      setPendingAssistant(cleanAssistantText(liveAssistantRef.current));
    },
    onAudioAlignment: (props: { chars?: string[] }) => {
      // Fallback live transcript: reveal each character as the audio chunk
      // for it is generated. This guarantees the chat updates while the bot
      // is speaking even when the agent does not stream text response parts.
      const chars = props?.chars;
      if (!chars || chars.length === 0) return;
      liveAssistantRef.current += chars.join("");
      setPendingAssistant(cleanAssistantText(liveAssistantRef.current));
    },
    onAgentResponseCorrection: (props: { corrected_agent_response?: string }) => {
      const corrected = props?.corrected_agent_response;
      if (!corrected) return;
      liveAssistantRef.current = corrected;
      setPendingAssistant(cleanAssistantText(corrected));
    },
    onConnect: () => {
      clearVoiceConnectTimeout();
      hasConnectedVoiceRef.current = true;
      voiceStateRef.current = "connected";
      setVoiceUiState("connected");
      setVoiceError(null);
      try { conversationRef.current?.setVolume({ volume: voiceUserHasSpokenRef.current ? 1 : 0 }); } catch (err) { console.warn(err); }
      const ctx = pendingContextRef.current;
      pendingContextRef.current = "";
      if (ctx) {
        try { conversationRef.current?.sendContextualUpdate(ctx); } catch (err) { console.warn(err); }
      }
    },
    onDisconnect: (details?: { reason?: string; message?: string; closeCode?: number; closeReason?: string }) => {
      clearVoiceConnectTimeout();
      const wasStopping = voiceStateRef.current === "stopping";
      voiceStateRef.current = "idle";
      setVoiceUiState("idle");
      pendingContextRef.current = "";
      if (wasStopping) return;
      const closeText = details?.closeReason || details?.message || "";
      if (/quota/i.test(closeText)) {
        setVoiceError("ElevenLabs voice quota is exhausted. Text chat still works.");
        return;
      }
      // If the session was previously connected and dropped for any non-error
      // reason (typically ElevenLabs idle timeout), silently reconnect so the
      // user stays in voice mode until they explicitly tap to stop.
      if (hasConnectedVoiceRef.current && details?.reason !== "error") {
        setTimeout(() => {
          if (voiceStateRef.current === "idle") void startVoice();
        }, 300);
        return;
      }
      voiceUserHasSpokenRef.current = false;
      if (hasConnectedVoiceRef.current || details?.reason === "error") {
        setVoiceError(closeText || "Voice disconnected. Tap the mic once to reconnect.");
      }
    },
    onError: (e) => {
      const msg = String(e || "");
      if (msg.includes("error_event") || msg.includes("error_type")) return;
      console.warn("voice error", msg);
      clearVoiceConnectTimeout();
      voiceStateRef.current = "idle";
      setVoiceUiState("idle");
      voiceUserHasSpokenRef.current = false;
      if (/quota/i.test(msg)) {
        setVoiceError("ElevenLabs voice quota is exhausted. Text chat still works.");
        return;
      }
      // Silent auto-reconnect if we were mid-session (transient socket glitch).
      if (hasConnectedVoiceRef.current) {
        setTimeout(() => {
          if (voiceStateRef.current === "idle") void startVoice();
        }, 500);
        return;
      }
      setVoiceError(msg || "Voice failed to connect. Tap the mic once to try again.");
    },
    onMessage: async (message: { source?: string; message?: string }) => {
      const text = message?.message;
      if (!text) return;
      const voiceMessage = message as { source?: string; message?: string; event_id?: number };
      const eventKey = `${voiceMessage.source ?? "unknown"}:${voiceMessage.event_id ?? text}`;
      if (seenVoiceEventsRef.current.has(eventKey)) return;
      seenVoiceEventsRef.current.add(eventKey);
      if (seenVoiceEventsRef.current.size > 250) {
        seenVoiceEventsRef.current = new Set(Array.from(seenVoiceEventsRef.current).slice(-120));
      }
      try {
        if (message.source === "user") {
          voiceUserHasSpokenRef.current = true;
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
    // Keep ElevenLabs context healthy on long threads: strip markdown noise
    // (tables, bullets, headings) so the LLM doesn't try to read it aloud, and
    // cap to ~6k chars + 60 turns. Overflow is the #1 cause of voice "gibberish".
    const MAX_CHARS = 6000;
    const MAX_TURNS = 60;
    const stripMd = (s: string) =>
      s
        .replace(/```[\s\S]*?```/g, "[code]")
        .replace(/^\s*\|.*\|\s*$/gm, "")
        .replace(/^\s*#{1,6}\s+/gm, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/[*_`>]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const recent = (messages ?? []).slice(-MAX_TURNS).map(
      (m) =>
        `${m.role === "user" ? "User" : "BPA Bot"}: ${
          m.role === "assistant" ? stripMd(cleanAssistantText(m.content)) : m.content
        }`,
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
      "- VOICE BREVITY: keep spoken replies under 60 words and conversational. Never read out long lists, tables, or markdown syntax — summarize them out loud and say \"I've put the details in the chat.\" The full structured answer (tables, bullets) goes silently to the chat via the visual transcript.",
      "- NO MARKDOWN OUT LOUD: do NOT speak characters like \"asterisk\", \"pipe\", \"hash\", or read tables row by row. If you need to show structured data, mention it briefly and let the chat render it.",
      "- If asked for a table, output a GitHub-Flavored Markdown table directly in the chat, and say one short sentence summarizing it out loud.",
      "- EMAIL: before drafting any email, ALWAYS confirm the recipient's email address out loud (e.g. \"Just to confirm, send this to john@example.com?\") and wait for the user to confirm. Never guess or invent addresses.",
      "- EMAIL FORMATTING: always write emails in clean, professional Markdown — a proper greeting, short well-structured paragraphs, bullet lists or tables where helpful, and a sign-off. Never send a plain unformatted dump.",
      "- EMAIL APPROVAL: present a full draft (To, Subject, Body) and wait for explicit user approval (\"send it\", \"yes send\") before calling send_email.",
      "- Stay in the session. Do not end the conversation, say goodbye, or wind down even if the user is silent. Wait quietly for their next message.",
      "- INTERRUPTION: if the user starts speaking while you are talking, stop immediately mid-sentence and listen. Never talk over the user. Resume only after they finish.",
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
    if (quota && quota.available && quota.limit > 0 && quota.remaining <= 0) {
      toast.error("Voice quota exhausted — text chat still works.");
      setVoiceError("ElevenLabs voice quota is exhausted. Text chat still works.");
      return;
    }
    const attemptId = startAttemptRef.current + 1;
    startAttemptRef.current = attemptId;
    hasConnectedVoiceRef.current = false;
    voiceUserHasSpokenRef.current = false;
    setVoiceState("starting");
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const { signedUrl } = await getAgentSignedUrl({});
      if (startAttemptRef.current !== attemptId) return;
      pendingContextRef.current = buildVoiceContext();
      clearVoiceConnectTimeout();
      connectTimeoutRef.current = window.setTimeout(() => {
        if (startAttemptRef.current !== attemptId || voiceStateRef.current !== "starting") return;
        setVoiceState("idle");
        pendingContextRef.current = "";
        setVoiceError("Voice took too long to connect. Tap the mic once to try again.");
        try { conversationRef.current?.endSession(); } catch (err) { console.warn(err); }
      }, 20000);
      conversation.startSession({
        signedUrl,
        connectionType: "websocket",
      });
    } catch (e) {
      clearVoiceConnectTimeout();
      const raw = e instanceof Error ? e.message : "Could not start voice";
      setVoiceState("idle");
      pendingContextRef.current = "";
      if (/permission|notallowed/i.test(raw)) {
        setVoiceError("Microphone access is blocked. Allow it, then tap the mic.");
        toast.error("Microphone blocked");
      } else if (/quota/i.test(raw)) {
        setVoiceError("ElevenLabs voice quota is exhausted. Text chat still works.");
      } else {
        console.warn("startVoice failed", raw);
        setVoiceError("Voice failed to connect. Tap the mic once to try again.");
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
    mutationFn: async ({ content, files, regenerate }: { content: string; files: Attachment[]; regenerate?: boolean }) => {
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

  function getChatTitle() {
    return cleanThreadTitle(threads.data?.find((t) => t.id === threadId)?.title ?? "BPA Bot chat");
  }

  function getExportMessages(): ChatMsg[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.role === "assistant" ? cleanAssistantText(m.content) : m.content,
      created_at: m.created_at,
    }));
  }

  function exportPdf() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try {
      exportChatToPdf(getChatTitle(), getExportMessages(), `bpa-bot-chat-${threadId.slice(0, 8)}.pdf`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF export failed");
    }
  }

  async function exportDocx() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try {
      await exportChatToDocx(getChatTitle(), getExportMessages(), `bpa-bot-chat-${threadId.slice(0, 8)}.docx`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Word export failed");
    }
  }

  function exportXlsx() {
    setExportOpen(false);
    if (messages.length === 0) return toast.error("Nothing to export yet");
    try {
      exportChatToXlsx(getChatTitle(), getExportMessages(), `bpa-bot-chat-${threadId.slice(0, 8)}.xlsx`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Excel export failed");
    }
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

  const voiceActive = voiceUiState === "connected" || (voiceUiState === "starting" && conversation.status !== "error");
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
            threads.data?.map((t) => {
              const active = t.id === threadId;
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-1 rounded-md pr-1 text-sm ${
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
                    className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
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
        {quota && quota.available && quota.limit > 0 && (
          <div className="mx-4 mt-3 rounded-md border border-border bg-card p-2.5">
            <div className="flex items-center justify-between text-[11px] mb-1.5">
              <span className="font-medium text-foreground">Voice quota</span>
              <span
                className={
                  quotaTone === "danger"
                    ? "text-destructive font-semibold"
                    : quotaTone === "warn"
                    ? "text-amber-500 font-semibold"
                    : "text-muted-foreground"
                }
              >
                {quota.percentUsed}% used
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className={
                  quotaTone === "danger"
                    ? "h-full bg-destructive"
                    : quotaTone === "warn"
                    ? "h-full bg-amber-500"
                    : "h-full bg-primary"
                }
                style={{ width: `${Math.min(100, quota.percentUsed)}%` }}
              />
            </div>
            <div className="mt-1.5 text-[10px] text-muted-foreground">
              {quota.remaining.toLocaleString()} chars left
              {quota.resetAt
                ? ` · resets ${new Date(quota.resetAt).toLocaleDateString()}`
                : ""}
            </div>
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
            {exportOpen && <ExportMenu onPdf={exportPdf} onDocx={exportDocx} onXlsx={exportXlsx} onPrint={exportPrint} onMarkdown={exportMarkdown} onEmail={exportEmailToMe} />}
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
          {quota && quota.available && quota.limit > 0 && (
            <span
              title={`Voice quota: ${quota.percentUsed}% used`}
              className={
                "ml-auto text-[10px] font-medium px-2 py-0.5 rounded-full " +
                (quotaTone === "danger"
                  ? "bg-destructive/15 text-destructive"
                  : quotaTone === "warn"
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : "bg-secondary text-muted-foreground")
              }
            >
              🎙 {quota.percentUsed}%
            </span>
          )}
          <div className={`relative ${quota && quota.available && quota.limit > 0 ? "ml-1" : "ml-auto"}`}>
            <button
              onClick={(e) => { e.stopPropagation(); setExportOpen((o) => !o); }}
              className="p-2 rounded-md hover:bg-secondary text-foreground"
              aria-label="Export chat"
              title="Export chat"
            >
              <MoreVertical size={18} />
            </button>
            {exportOpen && <ExportMenu onPdf={exportPdf} onDocx={exportDocx} onXlsx={exportXlsx} onPrint={exportPrint} onMarkdown={exportMarkdown} onEmail={exportEmailToMe} />}
          </div>
        </div>
        {/* Messages */}
        <div ref={scrollRef} className="relative z-10 flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y px-4 md:px-10 pt-16 md:pt-6 pb-6 space-y-6">
          {messages.length === 0 && !pendingUser && (
            <div className="text-center text-muted-foreground text-sm pt-12">
              How can I help you today?
            </div>
          )}
          {messages.map((m) => {
            const att = (m as unknown as { attachments?: Attachment[] | null }).attachments;
            return (
              <Bubble
                key={m.id}
                role={m.role}
                content={m.content}
                attachments={Array.isArray(att) ? att : []}
              />
            );
          })}
          {pendingUser && <Bubble role="user" content={pendingUser} />}
          {pendingAssistant && <Bubble role="assistant" content={pendingAssistant} />}
          <div ref={latestMessageRef} aria-hidden="true" />
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
          className="relative z-10 mx-4 md:mx-10 mb-6 rounded-xl border border-border bg-card shadow-sm p-2 flex flex-col gap-2"
        >
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
                ? "border-accent bg-accent/15 hud-pulse text-accent"
                : "border-border bg-secondary hover:bg-secondary/80 text-primary"
            }`}
          >
            {voiceActive ? <MicOff size={18} /> : <Mic size={18} />}
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
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              voiceConnecting
                ? "Connecting voice…"
                : voiceActive
                ? conversation.isSpeaking
                  ? "BPA Bot is speaking…"
                  : "Listening… or type"
                : "Message BPA Bot…"
            }
            className="flex-1 bg-transparent outline-none px-3 text-sm"
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

function ExportMenu({ onPdf, onDocx, onXlsx, onPrint, onMarkdown, onEmail }: { onPdf: () => void; onDocx: () => void; onXlsx: () => void; onPrint: () => void; onMarkdown: () => void; onEmail: () => void }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-full mt-1 w-56 rounded-md border border-border bg-card shadow-lg z-50 overflow-hidden"
    >
      <button onClick={onPdf} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <FileText size={14} /> Download PDF
      </button>
      <button onClick={onDocx} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <FileText size={14} /> Download Word (.docx)
      </button>
      <button onClick={onXlsx} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <FileText size={14} /> Download Excel (.xlsx)
      </button>
      <button onClick={onPrint} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-secondary">
        <Printer size={14} /> Print / Save as PDF
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
}: {
  role: string;
  content: string;
  attachments?: Array<{ path: string; name: string; mimeType: string; size?: number }>;
}) {
  const isUser = role === "user";
  const displayContent = isUser
    ? content
    : hidePartialTables(cleanAssistantText(content));
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-semibold shrink-0">
          BP
        </div>
      )}
      <div
        className={`max-w-[78%] min-w-0 overflow-x-auto rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card border border-border text-foreground"
        }`}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((a) => (
              <div
                key={a.path}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
                  isUser
                    ? "bg-primary-foreground/15 text-primary-foreground"
                    : "bg-secondary text-foreground border border-border"
                }`}
              >
                {a.mimeType.startsWith("image/") ? "🖼️" : "📎"}
                <span className="max-w-[180px] truncate">{a.name}</span>
              </div>
            ))}
          </div>
        )}
        <div
          className={`prose prose-sm max-w-none ${
            isUser ? "prose-invert" : ""
          } prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2 prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-table:my-3 prose-table:w-full prose-table:border-collapse prose-th:border prose-th:border-border prose-th:bg-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-accent`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
