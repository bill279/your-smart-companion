import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef } from "react";
import { Bot, LayoutDashboard, Loader2, Plus } from "lucide-react";
import { createThread, listThreads } from "@/lib/jarvis.functions";

export const Route = createFileRoute("/_authenticated/chat/")({
  ssr: false,
  head: () => ({ meta: [{ title: "BPA Bot" }] }),
  component: ChatLauncher,
});

const STARTUP_ACTIONS: Record<string, { title: string; prompt?: string; voice?: boolean }> = {
  voice: { title: "Voice conversation", voice: true },
  "morning-briefing": {
    title: "Morning briefing",
    prompt:
      "Give me an Outlook morning briefing. Executive style only: high-level priorities, emails needing action, calendar, and next steps. Do not include sender email addresses.",
  },
};

function ChatLauncher() {
  const qc = useQueryClient();
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const handledRef = useRef(false);
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => list({}) });

  const startupAction = useMemo(() => {
    if (typeof window === "undefined") return null;
    const action = new URLSearchParams(window.location.search).get("action");
    return action ? STARTUP_ACTIONS[action] ?? null : null;
  }, []);

  const createMut = useMutation({
    mutationFn: async (payload?: { title?: string; prompt?: string; voice?: boolean }) => {
      const thread = await create({ data: { title: payload?.title } });
      return { thread, prompt: payload?.prompt, voice: payload?.voice };
    },
    onSuccess: ({ thread, prompt, voice }) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      const params = new URLSearchParams();
      if (prompt) params.set("prompt", prompt);
      if (voice) params.set("voice", "1");
      const search = params.toString() ? `?${params.toString()}` : "";
      window.location.replace(`/chat/${thread.id}${search}`);
    },
  });

  useEffect(() => {
    if (handledRef.current || !threads.data) return;
    handledRef.current = true;

    if (startupAction) {
      createMut.mutate(startupAction);
      return;
    }

    const latest = threads.data[0];
    if (latest) {
      window.location.replace(`/chat/${latest.id}`);
      return;
    }

    createMut.mutate({ title: "New conversation" });
  }, [threads.data, startupAction]);

  return (
    <main className="safe-area-page flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-primary/10">
          <img src="/icon-192.png" alt="BP Automation" className="h-14 w-14 object-contain" />
        </div>
        <h1 className="text-xl font-semibold">Opening BPA Bot</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {startupAction ? `Starting ${startupAction.title.toLowerCase()}…` : "Loading your latest conversation…"}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          Preparing chat
        </div>
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => createMut.mutate({ title: "New conversation" })}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={15} />
            New chat
          </button>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold hover:bg-muted"
          >
            <LayoutDashboard size={15} />
            Dashboard
          </Link>
        </div>
        <Bot className="mx-auto mt-5 text-muted-foreground" size={18} />
      </div>
    </main>
  );
}
