import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useConversation, ConversationProvider } from "@elevenlabs/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Plus, Trash2, LogOut, Send, Menu, X, ArrowDown } from "lucide-react";
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
} from "@/lib/jarvis.functions";
import { supabase } from "@/integrations/supabase/client";

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

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });
  const messagesQ = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getMsgs({ data: { threadId } }),
  });

  const [input, setInput] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string>("");
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

  const messages = messagesQ.data ?? [];

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
      if (!voiceUserHasSpokenRef.current) return;
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
      voiceUserHasSpokenRef.current = false;
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
      setVoiceError(/quota/i.test(msg) ? "ElevenLabs voice quota is exhausted. Text chat still works." : msg || "Voice failed to connect. Tap the mic once to try again.");
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
          setPendingUser(null);
        } else if (message.source === "ai") {
          if (!voiceUserHasSpokenRef.current) return;
          const cleaned = cleanAssistantText(text);
          // Live update: show assistant turn the moment the transcript arrives.
          setPendingAssistant(cleaned);
          await add({ data: { threadId, role: "assistant", content: cleaned } });
          setPendingAssistant("");
          liveAssistantRef.current = "";
          const t = threads.data?.find((x) => x.id === threadId);
          if (t && t.title === "New conversation") {
            const title = text.slice(0, 48).replace(/\s+/g, " ").trim();
            await rename({ data: { id: threadId, title } });
          }
        }
        qc.invalidateQueries({ queryKey: ["messages", threadId] });
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
      "- If asked for a table, output a GitHub-Flavored Markdown table directly.",
      "- EMAIL: before drafting any email, ALWAYS confirm the recipient's email address out loud (e.g. \"Just to confirm, send this to john@example.com?\") and wait for the user to confirm. Never guess or invent addresses.",
      "- EMAIL FORMATTING: always write emails in clean, professional Markdown — a proper greeting, short well-structured paragraphs, bullet lists or tables where helpful, and a sign-off. Never send a plain unformatted dump.",
      "- EMAIL APPROVAL: present a full draft (To, Subject, Body) and wait for explicit user approval (\"send it\", \"yes send\") before calling send_email.",
      "- Stay in the session. Do not end the conversation, say goodbye, or wind down even if the user is silent. Wait quietly for their next message.",
    ].join("\n");
    return history
      ? `Prior conversation in this thread (most recent last):\n${history}\n\n${rules}\n\nContinue naturally from here.`
      : `Voice mode is open. Wait for the user's next message.\n\n${rules}`;
  }

  async function startVoice() {
    if (voiceStateRef.current === "starting" || voiceStateRef.current === "connected") return;
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
    mutationFn: async (content: string) => {
      setPendingUser(content);
      setPendingAssistant("");

      // If voice is connected, route through ElevenLabs instead.
      if (isConnected) {
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

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId, content }),
      });

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
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setPendingAssistant(cleanAssistantText(acc));
      }
      setPendingAssistant("");
      qc.invalidateQueries({ queryKey: ["messages", threadId] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed");
      setPendingUser(null);
      setPendingAssistant("");
    },
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = input.trim();
    if (!v) return;
    setInput("");
    addMut.mutate(v);
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

        <div className="flex-1 overflow-y-auto p-3 space-y-1 mt-3">
          {threads.data?.map((t) => {
            const active = t.id === threadId;
            return (
              <div
                key={t.id}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer ${
                  active ? "bg-secondary text-foreground" : "hover:bg-secondary/60 text-muted-foreground"
                }`}
              >
                <Link
                  to="/chat/$threadId"
                  params={{ threadId: t.id }}
                  className="flex-1 truncate"
                  onClick={() => setSidebarOpen(false)}
                >
                  {cleanThreadTitle(t.title)}
                </Link>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    delMut.mutate(t.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <button
          onClick={signOut}
          className="m-4 flex items-center gap-2 justify-center py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <LogOut size={12} /> Sign out
        </button>
      </aside>

      {/* Main HUD */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
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
        </div>
        {/* Messages */}
        <div ref={scrollRef} className="relative z-10 flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y px-4 md:px-10 pt-16 md:pt-6 pb-6 space-y-6">
          {messages.length === 0 && !pendingUser && (
            <div className="text-center text-muted-foreground text-sm pt-12">
              How can I help you today?
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} content={m.content} />
          ))}
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
          className="relative z-10 mx-4 md:mx-10 mb-6 rounded-xl border border-border bg-card shadow-sm p-2 flex items-center gap-2"
        >
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
          <button
            type="submit"
            disabled={!input.trim() || addMut.isPending}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 flex items-center gap-2"
          >
            <Send size={14} /> Send
          </button>
        </form>
      </main>
    </div>
  );
}

function Bubble({ role, content }: { role: string; content: string }) {
  const isUser = role === "user";
  const displayContent = isUser ? content : cleanAssistantText(content);
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
