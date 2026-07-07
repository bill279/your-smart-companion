import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { listInboxMessages, triageInboxMessage, type InboxMessage } from "@/lib/inbox.functions";
import { ArrowLeft, Mail, MailOpen, Sparkles, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [{ title: "Inbox triage — BPA Bot" }],
  }),
  component: InboxPage,
  errorComponent: ({ error }) => (
    <div className="p-8 text-sm text-destructive">Inbox failed to load: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-8">Not found</div>,
});

function InboxPage() {
  const listFn = useServerFn(listInboxMessages);
  const triageFn = useServerFn(triageInboxMessage);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => listFn(),
  });

  const [openId, setOpenId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState<string | null>(null);

  const triage = useMutation({
    mutationFn: (vars: { messageId: string; instruction: string }) =>
      triageFn({ data: vars }),
    onSuccess: (res) => {
      toast.success(res.result);
      if (res.draft) setDraft(res.draft);
      else {
        setOpenId(null);
        setInstruction("");
        void refetch();
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Triage failed"),
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center gap-4">
        <Link
          to="/chat/$threadId"
          params={{ threadId: "new" }}
          className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm"
        >
          <ArrowLeft size={16} /> Back to chat
        </Link>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Mail size={18} /> Inbox triage
        </h1>
        <button
          onClick={() => void refetch()}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Refresh
        </button>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 size={14} className="animate-spin" /> Loading your inbox…
          </div>
        )}
        {!isLoading && data && !data.connected && (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            Connect Outlook in Settings to see your inbox here.
          </div>
        )}
        {!isLoading && data?.connected && data.messages.length === 0 && (
          <div className="text-sm text-muted-foreground">Inbox is empty.</div>
        )}
        <ul className="flex flex-col gap-2">
          {data?.messages?.map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              open={openId === m.id}
              instruction={openId === m.id ? instruction : ""}
              draft={openId === m.id ? draft : null}
              busy={triage.isPending && openId === m.id}
              onOpen={() => {
                setOpenId(m.id);
                setInstruction("");
                setDraft(null);
              }}
              onClose={() => {
                setOpenId(null);
                setInstruction("");
                setDraft(null);
              }}
              onInstruction={setInstruction}
              onSubmit={() =>
                triage.mutate({ messageId: m.id, instruction: instruction.trim() })
              }
            />
          ))}
        </ul>
      </main>
    </div>
  );
}

function MessageRow({
  msg,
  open,
  instruction,
  draft,
  busy,
  onOpen,
  onClose,
  onInstruction,
  onSubmit,
}: {
  msg: InboxMessage;
  open: boolean;
  instruction: string;
  draft: string | null;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onInstruction: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <li className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        onClick={open ? onClose : onOpen}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-secondary/40"
      >
        {msg.isRead ? (
          <MailOpen size={14} className="mt-1 text-muted-foreground shrink-0" />
        ) : (
          <Mail size={14} className="mt-1 text-primary shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm truncate ${msg.isRead ? "" : "font-semibold"}`}>
              {msg.from.name || msg.from.email}
            </span>
            <span className="text-xs text-muted-foreground ml-auto shrink-0">
              {new Date(msg.receivedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
          <div className={`text-sm truncate ${msg.isRead ? "text-muted-foreground" : ""}`}>
            {msg.subject}
          </div>
          <div className="text-xs text-muted-foreground truncate">{msg.preview}</div>
        </div>
      </button>
      {open && (
        <div className="border-t border-border bg-secondary/20 p-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            Tell me what to do:{" "}
            <span className="italic">
              "draft a polite decline", "archive", "delete", "mark as read", "reply saying I'm out
              until Monday"…
            </span>
          </div>
          <div className="flex gap-2">
            <input
              autoFocus
              value={instruction}
              onChange={(e) => onInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && instruction.trim() && !busy) onSubmit();
              }}
              placeholder="What should I do with this?"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              onClick={onSubmit}
              disabled={!instruction.trim() || busy}
              className="rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium disabled:opacity-50 flex items-center gap-1"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Go
            </button>
            {msg.webLink && (
              <a
                href={msg.webLink}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <ExternalLink size={14} /> Open
              </a>
            )}
          </div>
          {draft && (
            <div className="rounded-md border border-border bg-background p-3 text-sm whitespace-pre-wrap">
              <div className="text-xs text-muted-foreground mb-2 font-medium">Draft reply:</div>
              {draft}
              <div className="text-xs text-muted-foreground mt-3">
                Copy this into the chat and say "send it" to have BPA Bot deliver it.
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}