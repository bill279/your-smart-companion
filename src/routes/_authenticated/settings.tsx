import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Save, Unplug } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  getAssistantSettings,
  updateAssistantSettings,
} from "@/lib/assistant/settings.functions";
import {
  DEFAULT_ASSISTANT_SETTINGS,
  type AssistantSettings,
  type CostMode,
  type InteractionMode,
  type VoiceProvider,
} from "@/lib/assistant/types";

export const Route = createFileRoute("/_authenticated/settings")({
  ssr: false,
  head: () => ({ meta: [{ title: "Assistant settings — BPA Bot" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const getFn = useServerFn(getAssistantSettings);
  const saveFn = useServerFn(updateAssistantSettings);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["assistant-settings"],
    queryFn: () => getFn({}),
  });

  const [form, setForm] = useState<AssistantSettings>(DEFAULT_ASSISTANT_SETTINGS);
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
  });
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("microsoft") !== "complete") return;
    const code = params.get("microsoft_code");
    const state = params.get("microsoft_state");
    if (!code || !state) return;

    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Sign in again");
        const res = await fetch("/api/integrations/microsoft/complete", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code, state }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Microsoft connection failed");
        if (!cancelled) {
          toast.success("Microsoft connected");
          qc.invalidateQueries({ queryKey: ["microsoft-integration-status"] });
          window.history.replaceState({}, "", "/settings?microsoft=connected");
        }
      } catch (error) {
        if (!cancelled) {
          toast.error((error as Error).message);
          window.history.replaceState({}, "", "/settings?microsoft=error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [qc]);

  const save = useMutation({
    mutationFn: async (payload: AssistantSettings) => saveFn({ data: payload }),
    onSuccess: (row) => {
      qc.setQueryData(["assistant-settings"], row);
      toast.success("Settings saved");
    },
    onError: (e) => toast.error((e as Error).message || "Save failed"),
  });

  const update = <K extends keyof AssistantSettings>(k: K, v: AssistantSettings[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const connectMicrosoft = async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return toast.error("Sign in again");
    const res = await fetch("/api/integrations/microsoft/connect", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!res.ok) return toast.error(json.error || "Microsoft connect failed");
    window.location.href = json.url;
  };

  const disconnectMicrosoft = async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return toast.error("Sign in again");
    const res = await fetch("/api/integrations/microsoft/disconnect", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(json.error || "Disconnect failed");
    toast.success("Microsoft disconnected");
    qc.invalidateQueries({ queryKey: ["microsoft-integration-status"] });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            to="/chat"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={16} /> Back to chat
          </Link>
          <h1 className="ml-auto text-lg font-semibold">Assistant settings</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <Section
          title="Interaction mode"
          description="How you talk to BPA Bot by default."
        >
          <RadioGroup
            value={form.interaction_mode}
            onChange={(v) => update("interaction_mode", v as InteractionMode)}
            options={[
              { value: "text", label: "Text", hint: "Type; no microphone." },
              {
                value: "push_to_talk",
                label: "Push-to-talk",
                hint: "Hold or tap the mic to speak.",
              },
              {
                value: "continuous",
                label: "Continuous voice",
                hint: "Mic stays open until you stop it.",
              },
            ]}
          />
        </Section>

        <Section
          title="Voice provider"
          description="Which service speaks the assistant's replies."
        >
          <RadioGroup
            value={form.voice_provider}
            onChange={(v) => update("voice_provider", v as VoiceProvider)}
            options={[
              {
                value: "openai_realtime",
                label: "OpenAI Realtime (default)",
                hint: "Low-latency OpenAI voice. Billed to OpenAI.",
              },
              {
                value: "none",
                label: "Text only",
                hint: "Never speak replies aloud.",
              },
            ]}
          />
        </Section>

        <Section
          title="Cost mode"
          description="Trade off speed and cost against reasoning quality."
        >
          <RadioGroup
            value={form.cost_mode}
            onChange={(v) => update("cost_mode", v as CostMode)}
            options={[
              {
                value: "economy",
                label: "Economy",
                hint: "Fastest and cheapest — GPT-5 nano.",
              },
              {
                value: "balanced",
                label: "Balanced (default)",
                hint: "Good reasoning, moderate cost — GPT-5 mini.",
              },
              {
                value: "premium",
                label: "Premium",
                hint: "Strongest reasoning — full GPT-5. Costs more.",
              },
            ]}
          />
        </Section>

        <Section
          title="Voice response length"
          description="Approximate cap on how long BPA Bot speaks in one turn."
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5}
              max={180}
              step={5}
              value={form.max_voice_seconds}
              onChange={(e) => update("max_voice_seconds", Number(e.target.value))}
              className="flex-1 accent-primary"
            />
            <div className="w-24 text-right text-sm text-muted-foreground">
              ~{form.max_voice_seconds}s
            </div>
          </div>
        </Section>

        <Section title="Safety & sourcing">
          <Toggle
            label="Require approval before external actions"
            hint="Sending emails, creating events, purchases — always ask before doing."
            checked={form.require_approval}
            onChange={(v) => update("require_approval", v)}
          />
          <Toggle
            label="Require citations for web research"
            hint="Always cite sources for facts from the web."
            checked={form.require_citations}
            onChange={(v) => update("require_citations", v)}
          />
        </Section>

        <Section
          title="Microsoft Outlook & Calendar"
          description="Connect your Microsoft account once so BPA Bot can send approved emails and manage your Outlook calendar."
        >
          <div className="rounded-md border border-border bg-background p-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">
                {microsoftQ.isLoading
                  ? "Checking Microsoft connection…"
                  : microsoftQ.data?.connected
                    ? "Microsoft connected"
                    : "Microsoft not connected"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {microsoftQ.data?.connected
                  ? `Connected as ${microsoftQ.data.email ?? "Microsoft account"}`
                  : "Required for real Outlook email sending and calendar actions."}
              </div>
            </div>
            {microsoftQ.data?.connected ? (
              <button
                type="button"
                onClick={disconnectMicrosoft}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border text-sm hover:bg-secondary"
              >
                <Unplug size={14} />
                Disconnect
              </button>
            ) : (
              <button
                type="button"
                onClick={connectMicrosoft}
                className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
              >
                Connect Microsoft
              </button>
            )}
          </div>
        </Section>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => query.data && setForm(query.data)}
            className="px-4 py-2 rounded-md border border-border text-sm hover:bg-secondary"
            disabled={save.isPending}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => save.mutate(form)}
            disabled={save.isPending || query.isLoading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-60"
          >
            <Save size={14} />
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>

        <p className="text-xs text-muted-foreground pt-4 border-t border-border">
          Voice uses OpenAI Realtime and is billed to your OpenAI API usage.
          ElevenLabs is no longer supported. If OpenAI Realtime fails to
          start you'll see an inline error — text chat keeps working either
          way.
        </p>
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function RadioGroup({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; hint?: string }>;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={
              "text-left rounded-md border p-3 transition " +
              (active
                ? "border-primary bg-primary/10"
                : "border-border bg-background hover:bg-secondary/60")
            }
          >
            <div className="text-sm font-medium text-foreground">{o.label}</div>
            {o.hint && (
              <div className="text-xs text-muted-foreground mt-0.5">{o.hint}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-primary"
      />
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
    </label>
  );
}
