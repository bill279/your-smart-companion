import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  FlaskConical,
  Loader2,
  MessageSquareText,
  Mic,
  PlayCircle,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { createThread } from "@/lib/jarvis.functions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/quality")({
  ssr: false,
  head: () => ({ meta: [{ title: "Quality Lab — BPA Bot" }] }),
  component: QualityLabPage,
});

type EvalStatus = "untested" | "pass" | "fail";

type EvalScenario = {
  id: string;
  mode: "voice" | "chat" | "both";
  title: string;
  goal: string;
  prompt: string;
  runPrompt?: string;
  expected: string[];
  failureSigns: string[];
};

const SCENARIOS: EvalScenario[] = [
  {
    id: "voice-no-fragments",
    mode: "voice",
    title: "Voice does not answer fragments",
    goal: "Make sure BPA Bot waits while you pause mid-thought instead of blurting out random content.",
    prompt:
      "Start voice and say slowly: “Can you email…” then pause for 2 seconds, then continue: “actually, write a short follow-up email to myself about BP Automation services.”",
    runPrompt:
      "Can you email… actually, write a short follow-up email to myself about BP Automation services.",
    expected: [
      "Does not respond during the 2-second pause.",
      "Understands the full final request.",
      "Prepares one concise email readback/draft instead of rambling.",
    ],
    failureSigns: [
      "Answers the partial phrase “Can you email…” before you finish.",
      "Says unrelated filler or random words.",
      "Asks the same confirmation question repeatedly.",
    ],
  },
  {
    id: "email-approval-once",
    mode: "both",
    title: "Email confirmation happens once",
    goal: "Verify email sending is useful but safe: draft first, then send immediately after approval.",
    prompt:
      "Email me a short professional summary of BP Automation’s services. Keep it under 120 words.",
    expected: [
      "Uses your signed-in email for “me”.",
      "Shows one clear draft/readback and asks for approval once.",
      "After you say “send”, sends the email without asking again.",
    ],
    failureSigns: [
      "Sends without approval.",
      "Asks for the same approval more than once after you already said yes.",
      "Claims email is not connected when it is connected.",
    ],
  },
  {
    id: "pdf-direct",
    mode: "both",
    title: "PDF generation is direct",
    goal: "Make sure the assistant creates the actual file instead of pasting the PDF content into chat.",
    prompt:
      "Make a one-page PDF summary of BP Automation’s services, with a short overview and bullet list of key capabilities.",
    expected: [
      "Generates a downloadable PDF card/link.",
      "Does not say it cannot create PDFs.",
      "Does not paste the full document as a normal chat answer.",
    ],
    failureSigns: [
      "Says it can only provide text.",
      "Asks you to copy/paste content into a PDF yourself.",
      "Repeats “I will generate it now” without producing the file.",
    ],
  },
  {
    id: "comparison-format",
    mode: "chat",
    title: "Comparison answers are structured",
    goal: "Validate the saved comparison preference: table first, then row-by-row explanation, then recap.",
    prompt:
      "Compare ChatGPT, Claude, and Microsoft Copilot for a business owner. Use a table and explain each row.",
    expected: [
      "Starts with a concise direct answer.",
      "Includes a Markdown table.",
      "Explains the rows/features after the table.",
      "Ends with a short practical recap.",
    ],
    failureSigns: [
      "Only gives vague paragraphs.",
      "Refuses to make a table.",
      "Over-explains without a clear recommendation.",
    ],
  },
  {
    id: "web-research",
    mode: "both",
    title: "Current web research is decisive",
    goal: "Check that it searches when current facts matter and gives a useful answer instead of narrating tool use.",
    prompt:
      "Find the latest public information about OpenAI’s realtime voice API and summarize what matters for this assistant.",
    expected: [
      "Searches/scrapes as needed without saying “let me search”.",
      "Gives a concise summary with sources in chat.",
      "Connects the findings back to BPA Bot.",
    ],
    failureSigns: [
      "Answers from stale memory only.",
      "Narrates every search step.",
      "Provides no sources for current claims.",
    ],
  },
  {
    id: "unclear-audio",
    mode: "voice",
    title: "Unclear audio repair is professional",
    goal: "Make sure noisy voice input produces one clean clarification, not hallucinated action.",
    prompt:
      "Start voice and mumble or intentionally say an incomplete request like: “send the thing to… uh… never mind wait.”",
    runPrompt:
      "send the thing to… uh… never mind wait.",
    expected: [
      "Does not invent a recipient or task.",
      "Asks one short clarification or waits quietly.",
      "Does not send anything.",
    ],
    failureSigns: [
      "Makes up a recipient, subject, or action.",
      "Keeps asking the same clarification repeatedly.",
      "Sends or drafts something unrelated.",
    ],
  },
  {
    id: "calendar-safe",
    mode: "both",
    title: "Calendar actions are safe",
    goal: "Verify calendar creation asks for a complete approval preview before creating anything.",
    prompt:
      "Schedule a 30 minute meeting tomorrow at 3 PM called Test Strategy Review.",
    expected: [
      "Asks for missing required details if needed, such as attendees or timezone.",
      "Shows a complete event preview before creating.",
      "Only creates after explicit approval.",
    ],
    failureSigns: [
      "Creates an event immediately without approval.",
      "Asks a long checklist instead of one focused question.",
      "Repeats the same confirmation loop.",
    ],
  },
  {
    id: "concise-professional",
    mode: "voice",
    title: "Voice sounds polished, not chatty",
    goal: "Check tone: useful, concise, professional, and not overly casual.",
    prompt:
      "Ask in voice: “What can you help me with today?”",
    runPrompt: "What can you help me with today?",
    expected: [
      "Answers in 1–2 short sentences.",
      "Mentions practical capabilities: research, email, calendar, documents, comparisons.",
      "Sounds professional and direct.",
    ],
    failureSigns: [
      "Long monologue.",
      "Fake enthusiasm or filler.",
      "Vague answer that does not explain useful capabilities.",
    ],
  },
];

function QualityLabPage() {
  const create = useServerFn(createThread);
  const [results, setResults] = useState<Record<string, EvalStatus>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runningAll, setRunningAll] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("bpa-quality-lab");
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        results?: Record<string, EvalStatus>;
        notes?: Record<string, string>;
        responses?: Record<string, string>;
      };
      setResults(parsed.results ?? {});
      setNotes(parsed.notes ?? {});
      setResponses(parsed.responses ?? {});
    } catch {
      /* ignore invalid saved state */
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("bpa-quality-lab", JSON.stringify({ results, notes, responses }));
  }, [results, notes, responses]);

  const score = useMemo(() => {
    const tested = SCENARIOS.filter((s) => results[s.id] && results[s.id] !== "untested");
    const passed = tested.filter((s) => results[s.id] === "pass");
    return { tested: tested.length, passed: passed.length };
  }, [results]);

  const setStatus = (id: string, status: EvalStatus) => {
    setResults((r) => ({ ...r, [id]: status }));
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied test prompt");
  };

  const copyReport = async () => {
    const report = {
      createdAt: new Date().toISOString(),
      score,
      scenarios: SCENARIOS.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        mode: scenario.mode,
        status: results[scenario.id] ?? "untested",
        note: notes[scenario.id] ?? "",
        response: responses[scenario.id] ?? "",
      })),
    };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    toast.success("Copied Quality Lab report");
  };

  const reset = () => {
    if (!confirm("Reset all Quality Lab results?")) return;
    setResults({});
    setNotes({});
    setResponses({});
    toast.success("Quality Lab reset");
  };

  const runScenario = async (scenario: EvalScenario) => {
    setRunning((r) => ({ ...r, [scenario.id]: true }));
    setResponses((r) => ({ ...r, [scenario.id]: "" }));
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in again, then rerun the test.");

      const thread = await create({
        data: { title: `Quality Lab — ${scenario.title}` },
      });
      const prompt = buildAutomatedPrompt(scenario);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: thread.id, content: prompt }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `Test failed (${res.status})`);
      const cleaned = text.trim();
      setResponses((r) => ({ ...r, [scenario.id]: cleaned }));
      const verdict = autoGradeScenario(scenario, cleaned);
      setStatus(scenario.id, verdict.status);
      setNotes((n) => ({
        ...n,
        [scenario.id]: verdict.note,
      }));
      toast.success(verdict.status === "pass" ? "Auto-check passed" : "Auto-check flagged an issue");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Test run failed";
      setStatus(scenario.id, "fail");
      setNotes((n) => ({ ...n, [scenario.id]: `Runner error: ${message}` }));
      toast.error(message);
    } finally {
      setRunning((r) => ({ ...r, [scenario.id]: false }));
    }
  };

  const runAllScenarios = async () => {
    setRunningAll(true);
    try {
      for (const scenario of SCENARIOS) {
        // Run sequentially so tool-heavy tests do not pile onto the same
        // account/API limits and make results noisy.
        // eslint-disable-next-line no-await-in-loop
        await runScenario(scenario);
      }
    } finally {
      setRunningAll(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 sticky top-0 bg-card/95 backdrop-blur z-10">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <Link to="/chat" className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm">
            <ArrowLeft size={16} /> Back
          </Link>
          <h1 className="text-base font-semibold flex items-center gap-2">
            <FlaskConical size={17} /> Quality Lab
          </h1>
          <button
            onClick={reset}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <RotateCcw size={13} /> Reset
          </button>
          <button
            onClick={copyReport}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <Clipboard size={13} /> Copy report
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <div className="flex-1">
              <div className="text-xs uppercase tracking-wide text-primary font-semibold mb-1">
                Assistant eval suite
              </div>
              <h2 className="text-2xl font-semibold">Make BPA Bot smarter by testing behavior, not vibes.</h2>
              <p className="mt-2 text-sm text-muted-foreground max-w-3xl">
                Run these scenarios after every prompt/voice update. Mark pass/fail and write a quick note when something feels off.
                The goal is a professional assistant that waits, understands, acts, and confirms only when needed.
              </p>
              <button
                onClick={runAllScenarios}
                disabled={runningAll}
                className="mt-4 inline-flex items-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {runningAll ? <Loader2 size={15} className="animate-spin" /> : <PlayCircle size={15} />}
                Run all tests
              </button>
            </div>
            <div className="rounded-lg border border-border bg-background px-4 py-3 min-w-40">
              <div className="text-xs text-muted-foreground">Score</div>
              <div className="text-2xl font-semibold mt-1">
                {score.passed}/{SCENARIOS.length}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {score.tested} tested · {SCENARIOS.length - score.tested} remaining
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-4">
          {SCENARIOS.map((scenario, idx) => {
            const status = results[scenario.id] ?? "untested";
            return (
              <article key={scenario.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start">
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-muted-foreground">#{idx + 1}</span>
                      <ModeBadge mode={scenario.mode} />
                      <StatusBadge status={status} />
                    </div>
                    <h3 className="mt-2 text-lg font-semibold">{scenario.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{scenario.goal}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copy(scenario.prompt)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-secondary"
                    >
                      <Clipboard size={13} /> Copy prompt
                    </button>
                    <button
                      onClick={() => runScenario(scenario)}
                      disabled={Boolean(running[scenario.id])}
                      className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-2 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                    >
                      {running[scenario.id] ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <PlayCircle size={13} />
                      )}
                      Run test
                    </button>
                    <button
                      onClick={() => setStatus(scenario.id, "pass")}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs ${
                        status === "pass"
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background hover:bg-secondary"
                      }`}
                    >
                      <CheckCircle2 size={13} /> Pass
                    </button>
                    <button
                      onClick={() => setStatus(scenario.id, "fail")}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs ${
                        status === "fail"
                          ? "border-destructive bg-destructive text-destructive-foreground"
                          : "border-border bg-background hover:bg-secondary"
                      }`}
                    >
                      <XCircle size={13} /> Fail
                    </button>
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-border bg-background p-3">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                    Say / type this
                  </div>
                  <p className="text-sm leading-relaxed">{scenario.prompt}</p>
                  {scenario.runPrompt && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Automated runner uses transcript simulation: {scenario.runPrompt}
                    </p>
                  )}
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <Checklist title="Good result" items={scenario.expected} tone="good" />
                  <Checklist title="Fail signs" items={scenario.failureSigns} tone="bad" />
                </div>

                <label className="mt-4 block">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                    Notes
                  </span>
                  <textarea
                    value={notes[scenario.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [scenario.id]: e.target.value }))}
                    placeholder="What happened? Any weird wording, delay, repeated confirmation, or wrong tool behavior?"
                    className="mt-1 min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
                {responses[scenario.id] && (
                  <div className="mt-4 rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                      Last automated response
                    </div>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
                      {responses[scenario.id]}
                    </pre>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function buildAutomatedPrompt(scenario: EvalScenario) {
  return scenario.runPrompt ?? scenario.prompt;
}

function autoGradeScenario(scenario: EvalScenario, response: string): { status: EvalStatus; note: string } {
  const s = response.toLowerCase();
  const failPatterns = [
    /cannot (?:directly )?(?:create|generate|attach|send).*pdf/i,
    /can't (?:directly )?(?:create|generate|attach|send).*pdf/i,
    /unable to (?:create|generate|attach|send).*pdf/i,
    /copy and paste/i,
    /as a text-based ai/i,
    /i will generate/i,
    /let me (?:search|look|check|gather)/i,
    /would you like me to try/i,
  ];
  if (failPatterns.some((p) => p.test(response))) {
    return { status: "fail", note: "Auto-check: flagged a forbidden/refusal/filler phrase." };
  }

  if (scenario.id === "pdf-direct") {
    const hasArtifact = /```bpa-artifact|https?:\/\/.*\.pdf|generated \*\*.*\.pdf/i.test(response);
    return hasArtifact
      ? { status: "pass", note: "Auto-check: detected generated PDF artifact/link." }
      : { status: "fail", note: "Auto-check: did not detect a generated PDF artifact/link." };
  }

  if (scenario.id === "comparison-format") {
    const hasTable = /\|.+\|[\r\n]+\|[\s:-]+\|/m.test(response);
    const hasRecap = /recap|bottom line|best fit|recommend/i.test(response);
    return hasTable && hasRecap
      ? { status: "pass", note: "Auto-check: detected table plus recap/recommendation language." }
      : { status: "fail", note: "Auto-check: comparison did not clearly include both a table and recap." };
  }

  if (scenario.id === "email-approval-once") {
    const asksApproval = /reply|say|confirm|approve|send/i.test(response);
    const looksDraft = /subject|recipient|to:|draft/i.test(response);
    const sent = /(?<!not )\bsent\b|email has been sent/i.test(response);
    const onlyRecipientConfirm = /^just to confirm\s*[—-]\s*send to/i.test(response.trim());
    if (onlyRecipientConfirm) {
      return { status: "fail", note: "Auto-check: assistant reconfirmed the signed-in user's own email instead of drafting." };
    }
    return asksApproval && looksDraft && !sent
      ? { status: "pass", note: "Auto-check: detected draft/readback and approval request; did not detect premature send." }
      : { status: "fail", note: "Auto-check: email flow did not clearly draft-and-wait." };
  }

  if (scenario.id === "calendar-safe") {
    const previewOrQuestion = /confirm|approve|attendee|timezone|preview|schedule it|create/i.test(response);
    const created = /created|scheduled|calendar event has been/i.test(response);
    return previewOrQuestion && !created
      ? { status: "pass", note: "Auto-check: detected safe calendar preview/clarification without creation." }
      : { status: "fail", note: "Auto-check: calendar response may have skipped safe confirmation." };
  }

  if (scenario.id === "unclear-audio") {
    const safeClarify = /caught part|clarify|what should|who should|not sent|cancel|wait/i.test(s);
    const unsafe = /@|(?<!not )\bsent\b|recipient:|subject:/i.test(response);
    return safeClarify && !unsafe
      ? { status: "pass", note: "Auto-check: unclear transcript handled without inventing/sending." }
      : { status: "fail", note: "Auto-check: unclear transcript did not produce a clean repair response." };
  }

  if (scenario.id === "concise-professional") {
    const words = response.trim().split(/\s+/).filter(Boolean).length;
    const hasCapabilities = /research|email|calendar|document|pdf|compare|comparison|web/i.test(response);
    return words <= 70 && hasCapabilities
      ? { status: "pass", note: "Auto-check: concise and capability-focused." }
      : { status: "fail", note: "Auto-check: response may be too long or too vague." };
  }

  if (scenario.id === "web-research") {
    const hasSource = /\[[^\]]+\]\(https?:\/\//.test(response) || /https?:\/\//.test(response);
    return hasSource
      ? { status: "pass", note: "Auto-check: detected source links for current web-research answer." }
      : { status: "fail", note: "Auto-check: did not detect source links for current web-research answer." };
  }

  if (scenario.id === "voice-no-fragments") {
    const looksEmailDraft = /email|draft|subject|confirm|approve|send/i.test(response);
    return looksEmailDraft
      ? { status: "pass", note: "Auto-check: transcript simulation produced an email draft/approval flow." }
      : { status: "fail", note: "Auto-check: transcript simulation did not land on the intended task." };
  }

  return { status: "untested", note: "Auto-check: no automated rule for this scenario." };
}

function ModeBadge({ mode }: { mode: EvalScenario["mode"] }) {
  const Icon = mode === "voice" ? Mic : mode === "chat" ? MessageSquareText : FlaskConical;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Icon size={11} /> {mode === "both" ? "chat + voice" : mode}
    </span>
  );
}

function StatusBadge({ status }: { status: EvalStatus }) {
  const classes =
    status === "pass"
      ? "bg-primary/15 text-primary"
      : status === "fail"
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${classes}`}>
      {status === "untested" ? "untested" : status}
    </span>
  );
}

function Checklist({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "good" | "bad";
}) {
  const Icon = tone === "good" ? CheckCircle2 : XCircle;
  const color = tone === "good" ? "text-primary" : "text-destructive";
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">
        {title}
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm">
            <Icon size={14} className={`mt-0.5 shrink-0 ${color}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
