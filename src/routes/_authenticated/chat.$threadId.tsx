import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useConversation } from "@elevenlabs/react";
import ReactMarkdown from "react-markdown";
import { Mic, MicOff, Plus, Trash2, LogOut, Send } from "lucide-react";
import { toast } from "sonner";
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
  head: () => ({ meta: [{ title: "JARVIS" }] }),
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

  const messages = messagesQ.data ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pendingAssistant, pendingUser]);

  const conversation = useConversation({
    onConnect: () => toast.success("JARVIS online"),
    onDisconnect: () => toast("JARVIS standby"),
    onError: (e) => toast.error(typeof e === "string" ? e : "Voice error"),
    onMessage: async (message: { source?: string; message?: string }) => {
      const text = message?.message;
      if (!text) return;
      if (message.source === "user") {
        await add({ data: { threadId, role: "user", content: text } });
      } else if (message.source === "ai") {
        await add({ data: { threadId, role: "assistant", content: text } });
        // auto-name new threads
        const t = threads.data?.find((x) => x.id === threadId);
        if (t && t.title === "New conversation") {
          const title = text.slice(0, 48).replace(/\s+/g, " ").trim();
          await rename({ data: { id: threadId, title } });
        }
      }
      qc.invalidateQueries({ queryKey: ["messages", threadId] });
      qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });

  const isConnected = conversation.status === "connected";

  async function startVoice() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { token } = await getToken({});
      await conversation.startSession({ conversationToken: token, connectionType: "webrtc" });
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
        toast.error(msg || "JARVIS is unavailable");
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
        <div className="p-5 border-b border-primary/20">
          <div className="text-2xl font-bold tracking-[0.4em] text-primary hud-glow">JARVIS</div>
          <div className="text-[10px] text-muted-foreground tracking-widest mt-1">v1.0 // ONLINE</div>
        </div>

        <button
          onClick={() => createMut.mutate()}
          className="mx-4 mt-4 flex items-center gap-2 justify-center py-2 rounded border border-primary/40 hover:bg-primary/10 text-sm tracking-wider"
        >
          <Plus size={14} /> NEW SESSION
        </button>

        <div className="flex-1 overflow-y-auto p-3 space-y-1 mt-3">
          {threads.data?.map((t) => {
            const active = t.id === threadId;
            return (
              <div
                key={t.id}
                className={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer ${
                  active ? "bg-primary/20 border border-primary/40" : "hover:bg-primary/5"
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
          className="m-4 flex items-center gap-2 justify-center py-2 text-xs text-muted-foreground hover:text-primary tracking-wider"
        >
          <LogOut size={12} /> DISCONNECT
        </button>
      </aside>

      {/* Main HUD */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Decorative rings */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-20">
          <div className="absolute w-[600px] h-[600px] rounded-full border border-primary/40 hud-spin-slow" />
          <div className="absolute w-[480px] h-[480px] rounded-full border border-primary/30 hud-spin-rev" />
          <div className="absolute w-[360px] h-[360px] rounded-full border border-accent/30 hud-spin-slow" />
        </div>

        {/* Reactor / voice button */}
        <div className="relative z-10 pt-10 pb-6 flex flex-col items-center">
          <button
            onClick={isConnected ? stopVoice : startVoice}
            className={`relative w-32 h-32 rounded-full flex items-center justify-center transition border-2 ${
              isConnected
                ? "border-accent bg-accent/20 hud-pulse"
                : "border-primary bg-primary/10 hover:bg-primary/20"
            }`}
          >
            {isConnected ? <MicOff size={36} className="text-accent" /> : <Mic size={36} className="text-primary" />}
            <div className="absolute -inset-2 rounded-full border border-primary/30" />
            <div className="absolute -inset-5 rounded-full border border-primary/15" />
          </button>
          <div className="mt-4 text-xs tracking-[0.3em] text-muted-foreground">
            {isConnected
              ? conversation.isSpeaking
                ? "RESPONDING…"
                : "LISTENING…"
              : "TAP TO SPEAK"}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-8 pb-6 space-y-4">
          {messages.length === 0 && !pendingUser && (
            <div className="text-center text-muted-foreground text-sm pt-12">
              Good day. How may I assist you?
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
          className="relative z-10 m-6 hud-panel hud-corner rounded-lg p-3 flex gap-2"
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isConnected ? "Type or speak…" : "Type a command…"}
            className="flex-1 bg-transparent outline-none px-3 text-sm"
          />
          <button
            type="submit"
            disabled={!input.trim() || addMut.isPending}
            className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm tracking-wider disabled:opacity-40 flex items-center gap-2"
          >
            <Send size={14} /> SEND
          </button>
        </form>
      </main>
    </div>
  );
}

function Bubble({ role, content }: { role: string; content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm leading-relaxed border ${
          isUser
            ? "bg-primary/15 border-primary/40 text-foreground"
            : "bg-card border-accent/40 text-foreground hud-corner"
        }`}
      >
        <div className="text-[10px] tracking-[0.25em] mb-1 opacity-60">
          {isUser ? "USER" : "JARVIS"}
        </div>
        <div className="prose prose-invert prose-sm max-w-none prose-p:my-1">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
