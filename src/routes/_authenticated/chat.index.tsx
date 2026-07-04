import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  Inbox,
  MailPlus,
  Mic,
  Plus,
  Settings,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { createThread, getDashboard } from "@/lib/jarvis.functions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/chat/")({
  ssr: false,
  head: () => ({ meta: [{ title: "BPA Bot Dashboard" }] }),
  component: ChatDashboard,
});

const QUICK_ACTIONS = [
  {
    title: "Morning briefing",
    description: "Inbox, calendar, priorities, and next steps.",
    icon: Sparkles,
    accent: "from-primary to-blue-500",
    prompt:
      "Give me an Outlook morning briefing. Executive style only: high-level priorities, emails needing action, calendar, and next steps. Do not include sender email addresses.",
  },
  {
    title: "Check inbox",
    description: "Find what needs attention without the noise.",
    icon: Inbox,
    accent: "from-sky-500 to-cyan-400",
    prompt:
      "Check my Outlook inbox and tell me what needs attention. Keep it high-level and group by action.",
  },
  {
    title: "Draft reply",
    description: "Prepare a professional response for review.",
    icon: MailPlus,
    accent: "from-violet-500 to-fuchsia-500",
    prompt:
      "Help me draft a reply to the latest Outlook email that needs a response. If you need a sender or message, ask one focused question.",
  },
  {
    title: "Create report",
    description: "Make a PDF, Word doc, spreadsheet, or summary.",
    icon: FileText,
    accent: "from-amber-500 to-orange-500",
    prompt:
      "Create a polished one-page report. Ask me one focused question if you need to know the topic or format.",
  },
  {
    title: "Start voice",
    description: "Open a clean voice-ready conversation.",
    icon: Mic,
    accent: "from-emerald-500 to-teal-400",
    voice: true,
  },
] as const;

function ChatDashboard() {
  const qc = useQueryClient();
  const dashboardFn = useServerFn(getDashboard);
  const create = useServerFn(createThread);
  const shortcutHandledRef = useRef(false);

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => dashboardFn({}),
  });
  const microsoftQ = useQuery({
    queryKey: ["microsoft-integration-status"],
    queryFn: async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in again");
      const res = await fetch("/api/integrations/microsoft/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load Microsoft status");
      return json as { connected: boolean; email: string | null; scopes: string[] };
    },
    retry: 1,
  });

  const startTask = useMutation({
    mutationFn: async ({ title, prompt, voice }: { title: string; prompt?: string; voice?: boolean }) => {
      const thread = await create({ data: { title } });
      return { thread, prompt, voice };
    },
    onSuccess: ({ thread, prompt, voice }) => {
      qc.invalidateQueries({ queryKey: ["threads"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      const params = new URLSearchParams();
      if (prompt) params.set("prompt", prompt);
      if (voice) params.set("voice", "1");
      const search = params.toString() ? `?${params.toString()}` : "";
      window.location.href = `/chat/${thread.id}${search}`;
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not start a new chat.");
    },
  });
  useEffect(() => {
    if (shortcutHandledRef.current || startTask.isPending) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (!action) return;

    shortcutHandledRef.current = true;
    params.delete("action");
    const nextSearch = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`,
    );

    if (action === "voice") {
      startTask.mutate({ title: "Start voice", voice: true });
      return;
    }
    if (action === "morning-briefing") {
      const briefing = QUICK_ACTIONS.find((item) => item.title === "Morning briefing");
      if (briefing && "prompt" in briefing) {
        startTask.mutate({ title: briefing.title, prompt: briefing.prompt });
      }
    }
  }, [startTask.isPending]);
  const connectMicrosoft = useMutation({
    mutationFn: async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in again");
      const res = await fetch("/api/integrations/microsoft/connect", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok || !json.url) throw new Error(json.error || "Could not start Outlook connection.");
      return json.url as string;
    },
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not connect Outlook.");
    },
  });

  const microsoft = microsoftQ.data;
  const outlookConnected = !!microsoft?.connected;
  const hasMail = microsoft?.scopes?.some((scope) => scope.toLowerCase() === "mail.read") ?? false;
  const actions = dashboard.data?.actions ?? [];
  const threads = dashboard.data?.threads ?? [];

  return (
    <main className="safe-area-page min-h-dvh bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.14),transparent_32rem),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted)/0.45))] text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-6 sm:py-5 lg:px-8">
        <header className="flex flex-col gap-4 rounded-3xl border border-border/70 bg-card/80 p-5 shadow-sm backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <Bot size={28} />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">BP Automation assistant</p>
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">What should BPA Bot handle?</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/settings"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <Settings size={16} />
              Settings
            </Link>
            <button
              type="button"
              onClick={() => startTask.mutate({ title: "New conversation" })}
              disabled={startTask.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
            >
              <Plus size={16} />
              New chat
            </button>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-2">
          <StatusCard
            connected
            title="OpenAI Realtime"
            detail="Chat, voice, and document generation are running through OpenAI."
          />
          <StatusCard
            connected={outlookConnected && hasMail}
            title="Outlook"
            detail={
              outlookConnected && hasMail
                ? `Connected${microsoft?.email ? ` as ${microsoft.email}` : ""}. Email tools are ready.`
                : outlookConnected
                  ? "Connected, but mail permission may need refresh."
                  : "Not connected yet. Reconnect Outlook to use email and calendar tools."
            }
            action={
              outlookConnected && hasMail
                ? undefined
                : {
                    label: connectMicrosoft.isPending ? "Opening Microsoft…" : "Reconnect Outlook",
                    onClick: () => connectMicrosoft.mutate(),
                    disabled: connectMicrosoft.isPending,
                  }
            }
          />
        </section>

        <section className="rounded-3xl border border-primary/15 bg-primary/5 p-4 text-sm leading-6 text-muted-foreground sm:hidden">
          Tip: in Safari, tap <span className="font-semibold text-foreground">Share → Add to Home Screen</span> to use this like an iPhone app.
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.title}
                type="button"
                onClick={() => startTask.mutate({ title: action.title, prompt: "prompt" in action ? action.prompt : undefined, voice: "voice" in action ? action.voice : undefined })}
                disabled={startTask.isPending}
                className="group rounded-3xl border border-border/70 bg-card p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md disabled:opacity-60"
              >
                <span className={`mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ${action.accent} text-white shadow-sm`}>
                  <Icon size={23} />
                </span>
                <h2 className="text-lg font-semibold">{action.title}</h2>
                <p className="mt-2 min-h-12 text-sm leading-6 text-muted-foreground">{action.description}</p>
                <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                  Start
                  <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
                </span>
              </button>
            );
          })}
        </section>

        <section className="grid flex-1 gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Recent activity</h2>
                <p className="text-sm text-muted-foreground">Latest assistant actions and tool results.</p>
              </div>
              <Link to="/activity" className="text-sm font-medium text-primary hover:underline">
                View all
              </Link>
            </div>
            {dashboard.isLoading ? (
              <SkeletonRows />
            ) : actions.length ? (
              <div className="space-y-3">
                {actions.map((action) => (
                  <div key={action.id} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold capitalize">{action.action.replace(/_/g, " ")}</p>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{action.summary || "No summary recorded."}</p>
                      </div>
                      <StatusPill status={action.status} />
                    </div>
                    <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock size={12} />
                      {formatTime(action.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Activity size={22} />}
                title="No activity yet"
                detail="Run a briefing, send an email, or create a document and it will show up here."
              />
            )}
          </div>

          <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Recent conversations</h2>
                <p className="text-sm text-muted-foreground">Jump back into anything you were working on.</p>
              </div>
            </div>
            {dashboard.isLoading ? (
              <SkeletonRows />
            ) : threads.length ? (
              <div className="space-y-2">
                {threads.map((thread) => (
                  <Link
                    key={thread.id}
                    to="/chat/$threadId"
                    params={{ threadId: thread.id }}
                    className="block rounded-2xl border border-border/70 bg-background/70 p-4 transition hover:border-primary/50 hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-semibold">{thread.title || "New conversation"}</p>
                      <ArrowRight size={15} className="shrink-0 text-muted-foreground" />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{formatTime(thread.updated_at)}</p>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Bot size={22} />}
                title="No chats yet"
                detail="Start with a briefing or create a new conversation."
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function StatusCard({
  connected,
  title,
  detail,
  action,
}: {
  connected: boolean;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
            connected ? "bg-emerald-500/12 text-emerald-600" : "bg-destructive/10 text-destructive"
          }`}
        >
          {connected ? <Wifi size={22} /> : <WifiOff size={22} />}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{title}</h2>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                connected ? "bg-emerald-500/12 text-emerald-700" : "bg-destructive/10 text-destructive"
              }`}
            >
              {connected ? "Ready" : "Needs attention"}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p>
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              className="mt-3 inline-flex items-center rounded-full bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const ok = /success|complete|sent|done/i.test(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
        ok ? "bg-emerald-500/12 text-emerald-700" : "bg-muted text-muted-foreground"
      }`}
    >
      {ok && <CheckCircle2 size={12} />}
      {status || "recorded"}
    </span>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-background/60 p-6 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{detail}</p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-muted" />
      ))}
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const mins = Math.max(0, Math.round(diff / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
