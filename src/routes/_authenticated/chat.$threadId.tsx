import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useConversation, ConversationProvider } from "@elevenlabs/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mic, MicOff, Plus, Trash2, LogOut, Send } from "lucide-react";
import { toast } from "sonner";
import bpaLogo from "@/assets/bpa-logo.png.asset.json";
import {
  addMessage,
  createThread,
  deleteThread,
  getElevenLabsAgentToken,
  getThreadMessages,
  listThreads,
  renameThread,
} from "@/lib/jarvis.functions";
import { supabase } from "@/integrations/supabase/client";

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
  const getToken = useServerFn(getElevenLabsAgentToken);

  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });
  const messagesQ = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getMsgs({ data: { threadId } }),
  });

  const [input, setInput] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingContextRef = useRef<string>("");
  const conversationRef = useRef<ReturnType<typeof useConversation> | null>(null);

  const messages = messagesQ.data ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pendingAssistant, pendingUser]);

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
    onConnect: () => {
      toast.success("BPA Bot online");
      const ctx = pendingContextRef.current;
      if (ctx) {
        try {
          conversationRef.current?.sendContextualUpdate(ctx);
        } catch (err) {
          console.warn("contextual update failed", err);
        }
        pendingContextRef.current = "";
      }
    },
    onDisconnect: () => toast("BPA Bot offline"),
    onError: (e) => toast.error(typeof e === "string" ? e : "Voice error"),
    onMessage: async (message: { source?: string; message?: string }) => {
      const text = message?.message;
      if (!text) return;
      try {
        if (message.source === "user") {
          await add({ data: { threadId, role: "user", content: text } });
        } else if (message.source === "ai") {
          await add({ data: { threadId, role: "assistant", content: text } });
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

  async function startVoice() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { token } = await getToken({});
      // Build conversational context to inject AFTER connect (no override needed).
      const MAX_CHARS = 12000;
      const recent = (messages ?? []).slice(-100).map(
        (m) => `${m.role === "user" ? "User" : "BPA Bot"}: ${m.content}`,
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
      pendingContextRef.current = history
        ? `Prior conversation in this thread (most recent last):\n${history}\n\nContinue naturally from here. Do not greet again.`
        : "";
      await conversation.startSession({
        conversationToken: token,
        connectionType: "webrtc",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start voice");
    }
  }
  async function stopVoice() {
    await conversation.endSession();
  }

  const addMut = useMutation({
    mutationFn: async (content: string) => {
      setPendingUser(content);
      setPendingAssistant("");

      // If voice is connected, route through ElevenLabs instead.
      if (isConnected) {
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
        setPendingAssistant(acc);
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

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-72 hud-panel border-r border-primary/30 flex flex-col">
        <div className="p-5 border-b border-border">
          <img src={bpaLogo.url} alt="BP Automation" className="h-8 w-auto mb-2" />
          <div className="text-base font-semibold text-foreground">BPA Bot</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            BP Automation assistant
          </div>
        </div>

        <button
          onClick={() => createMut.mutate()}
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
                >
                  {t.title}
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
        {/* Voice button */}
        <div className="relative z-10 pt-6 pb-4 flex flex-col items-center border-b border-border bg-card/40">
          <button
            onClick={isConnected ? stopVoice : startVoice}
            className={`relative w-20 h-20 rounded-full flex items-center justify-center transition border-2 ${
              isConnected
                ? "border-accent bg-accent/15 hud-pulse"
                : "border-primary bg-primary/5 hover:bg-primary/10"
            }`}
          >
            {isConnected ? <MicOff size={26} className="text-accent" /> : <Mic size={26} className="text-primary" />}
          </button>
          <div className="mt-2 text-xs text-muted-foreground">
            {isConnected
              ? conversation.isSpeaking
                ? "Speaking…"
                : "Listening…"
              : "Tap to talk"}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-4 md:px-10 py-6 space-y-6">
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
        </div>

        {/* Composer */}
        <form
          onSubmit={onSubmit}
          className="relative z-10 mx-4 md:mx-10 mb-6 rounded-xl border border-border bg-card shadow-sm p-2 flex gap-2"
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isConnected ? "Type or speak…" : "Message BPA Bot…"}
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
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[11px] font-semibold shrink-0">
          BP
        </div>
      )}
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card border border-border text-foreground"
        }`}
      >
        <div
          className={`prose prose-sm max-w-none ${
            isUser ? "prose-invert" : ""
          } prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2 prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-accent`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
