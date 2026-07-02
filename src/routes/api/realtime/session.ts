import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  REALTIME_TOOLS,
  realtimeToolNames,
  realtimeHasTool,
} from "@/lib/voice/realtime-tools";
import { buildRealtimeSessionPayload } from "@/lib/voice/realtime-session-payload";
import {
  REALTIME_PRIMARY_MODEL,
  REALTIME_FALLBACK_MODELS,
  classifyRealtimeFailure,
  shouldTryFallbackModel,
  humanRealtimeError,
  extractRequestId,
} from "@/lib/voice/realtime-errors";

// Mints an ephemeral OpenAI Realtime client secret. The raw OPENAI_API_KEY
// never leaves the server. The browser gets a short-lived client_secret it
// can use directly against api.openai.com for the WebRTC SDP exchange.

const REALTIME_MODEL = REALTIME_PRIMARY_MODEL;
const REALTIME_VOICE = "alloy";
const DOCUMENT_TOOL_NAME = "generate_document";
// Current OpenAI Realtime ephemeral-secret endpoint. The legacy
// `/v1/realtime/sessions` route now returns 404 for many keys; the
// documented replacement is `/v1/realtime/client_secrets`, which returns
// `{ value, expires_at }` and accepts the session config nested under
// `session`.
const REALTIME_SESSION_URL = "https://api.openai.com/v1/realtime/client_secrets";

function buildInstructions(costMode: string, maxSeconds: number, userEmail: string | null) {
  const brevity =
    costMode === "economy"
      ? "Keep every spoken reply to 1 short sentence unless the user asks for detail."
      : "Keep spoken replies to 1-3 short sentences by default.";
  return [
    "You are BPA Bot, BP Automation's executive assistant. Be professional, concise, and direct.",
    brevity,
    `Never speak longer than about ${maxSeconds} seconds in one turn.`,
    "Do NOT introduce yourself or greet again after the first exchange.",
    "Never read tables, lists, code, or long drafts aloud. If the answer is a table/list/draft, give a one-sentence executive summary and tell the user the details are on screen. Do not speak column headers, pipes, dashes, or row-by-row cell values.",
    "Never think out loud, narrate tool use, or fill silence. If unsure, ask one short clarifying question.",
    "Before any irreversible external action (sending email, creating an event, purchases), present a short draft and wait for explicit user approval.",
    "You have tools: web_search (live web results), web_scrape (fetch a specific URL as markdown), send_email (send from the user's connected Outlook/Gmail account), and generate_document (create a downloadable PDF, DOCX, Markdown, XLSX, CSV, or TXT file). Use web_search and web_scrape silently when needed — never narrate 'let me search'.",
    "DOCUMENT CAPABILITY: You CAN create downloadable files by calling generate_document. Supported formats: PDF, DOCX (Word), Markdown (.md), XLSX (Excel), CSV, and TXT. Never say you cannot create PDFs, Word documents, spreadsheets, downloads, attachments, or other files. Never say you can only provide text, cannot directly create a file, or that the user has to copy/paste anything. Those disclaimers are false in this app. If a request is ambiguous about format, default to PDF.",
    "DOCUMENT PROTOCOL: When the user asks for a file, report, PDF, Word doc, spreadsheet, export, download, attachment, or says things like 'make that a PDF' / 'create a PDF from that summary' / 'send me a doc' / 'create a report', immediately call generate_document with an appropriate title, filename, format, and full Markdown body based on the current conversation context (plus a short summary and citations when available). Do NOT ask for permission first and do NOT refuse. After it succeeds, speak ONE short sentence like 'I generated the PDF — it's on screen.' Never read the document contents aloud. The download card appears in the chat automatically.",
    "HARD RULE — DOCUMENT INTENT: If the user's request implies producing a file (PDF/DOCX/Markdown/XLSX/CSV/TXT/report/download/attachment), you MUST call generate_document. You are FORBIDDEN from replying with the document body as your spoken/text answer. You are FORBIDDEN from saying you cannot create files, cannot attach, or that the user must copy/paste. The ONLY acceptable final response after a document request is: (a) a generate_document tool call, followed by (b) one short spoken sentence like 'I generated the PDF — it's on screen.' If you catch yourself about to output the document body as an answer, stop and call generate_document instead.",
    "EMAIL CONFIRMATION PROTOCOL (mandatory, no exceptions): (1) Never call send_email on the first request. (2) Speak an interactive readback aloud in this exact order and phrasing: 'Please confirm this email. Recipient: <full email address, spelled out with \"at\" and \"dot\">. Subject: <subject>. First line: <verbatim first line or first sentence of the body>. Say \"confirm\" to send, \"cancel\" to discard, or tell me what to change.' (3) Wait for the user's spoken reply and classify it into exactly one of: CONFIRM, CANCEL, REVISE, or UNCLEAR. (4) CONFIRM — only the word 'confirm' (or unambiguous equivalents 'confirmed', 'yes confirm', 'send it confirmed'). Plain 'yes'/'ok'/'sure' are NOT sufficient; re-prompt with 'Please say the word confirm to send.' Then call send_email. (5) CANCEL — 'cancel', 'discard', 'nevermind', 'don't send', 'scrap it'. Do NOT call send_email. Reply briefly: 'Cancelled. The email was not sent.' and drop the draft. (6) REVISE — any instruction to change recipient, subject, body, tone, length, add/remove CC, fix typos, etc. Apply the edit, then repeat the FULL readback from step 2 with the updated fields and re-ask for 'confirm'. Never send a revised draft without a fresh confirm. (7) UNCLEAR — silence, a question, or garbled audio. Re-prompt: 'Should I send, cancel, or revise this email?' and wait. (8) If the user gives multiple edits in one turn, apply them all before the next readback rather than confirming one at a time.",
    userEmail
      ? `The signed-in user's email is ${userEmail}. When they say "email me", use exactly this address.`
      : "You do not know the signed-in user's email. If they say 'email me', ask for the address.",
  ].join(" ");
}

export const Route = createFileRoute("/api/realtime/session")({
  server: {
    handlers: {
      // Preflight health check. GET returns whether the server is capable of
      // minting an OpenAI Realtime session (API key present, required tools
      // registered) WITHOUT calling OpenAI or asking for the microphone. The
      // client hits this before requesting mic permissions so we can fail
      // fast with an actionable error instead of a mysterious mic prompt.
      GET: async () => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return Response.json(
            {
              ok: false,
              error: "openai_not_configured",
              message:
                "OpenAI Realtime voice is not configured. Ask an administrator to add OPENAI_API_KEY to project secrets.",
            },
            { status: 501 },
          );
        }
        if (!realtimeHasTool("generate_document")) {
          return Response.json(
            {
              ok: false,
              error: "realtime_document_tool_missing",
              message:
                "Voice document generation is not registered on the server. Redeploy required.",
              tools: realtimeToolNames(),
            },
            { status: 500 },
          );
        }
        return Response.json({
          ok: true,
          model: REALTIME_MODEL,
          fallbackModels: REALTIME_FALLBACK_MODELS,
          endpoint: REALTIME_SESSION_URL,
          tools: realtimeToolNames(),
          documentToolRegistered: true,
        });
      },
      POST: async ({ request }) => {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return Response.json(
            {
              error: "openai_not_configured",
              message:
                "OpenAI Realtime voice is not configured. Ask an administrator to add OPENAI_API_KEY to project secrets.",
            },
            { status: 501 },
          );
        }

        // Authenticate via the caller's Supabase bearer token.
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
        if (!token) return new Response("Unauthorized", { status: 401 });

        const supabase = createClient<Database>(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          },
        );
        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr || !userData.user) return new Response("Unauthorized", { status: 401 });

        const userEmail = userData.user.email ?? null;
        const { data: settings } = await supabase
          .from("assistant_settings")
          .select("cost_mode,max_voice_seconds")
          .eq("user_id", userData.user.id)
          .maybeSingle();
        const costMode = (settings?.cost_mode ?? "balanced") as string;
        const maxSeconds = settings?.max_voice_seconds ?? 45;

        if (!realtimeHasTool("generate_document")) {
          console.error("[realtime session] generate_document missing from local Realtime tools payload", {
            tools: realtimeToolNames(),
          });
          return Response.json(
            {
              error: "realtime_document_tool_missing",
              message: "Voice document generation is not registered. Restart voice and try again.",
            },
            { status: 500 },
          );
        }

        const instructions = buildInstructions(costMode, maxSeconds, userEmail);
        // Try primary model, then a documented fallback for 5xx / model-not-available.
        // Tools + instructions are baked into the ephemeral client_secret when the
        // endpoint accepts them; the client also re-registers via session.update
        // after the data channel opens, so this is a defense-in-depth setup.
        const modelChain = [REALTIME_MODEL, ...REALTIME_FALLBACK_MODELS];
        const attempts: Array<{ model: string; status: number; requestId: string | null; bodySnippet: string; kind: string }> = [];
        let successModel: string | null = null;
        let successBodyText: string | null = null;
        for (const candidateModel of modelChain) {
          const upstreamPayload = buildRealtimeSessionPayload({
            model: candidateModel,
            instructions,
            voice: REALTIME_VOICE,
          });
          console.log(
            "[realtime session] creating",
            REALTIME_SESSION_URL,
            "model",
            candidateModel,
            "tools",
            realtimeToolNames().join(", "),
          );
          const upstream = await fetch(REALTIME_SESSION_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(upstreamPayload),
          });
          const requestId = extractRequestId(upstream.headers);
          const bodyText = await upstream.text();
          if (upstream.ok) {
            successModel = candidateModel;
            successBodyText = bodyText;
            break;
          }
          const kind = classifyRealtimeFailure(upstream.status, bodyText);
          console.error("[realtime session] openai rejected", {
            status: upstream.status,
            model: candidateModel,
            requestId,
            kind,
            body: bodyText.slice(0, 500),
          });
          attempts.push({
            model: candidateModel,
            status: upstream.status,
            requestId,
            bodySnippet: bodyText.slice(0, 1200),
            kind,
          });
          if (!shouldTryFallbackModel(kind)) break;
        }
        if (!successModel || !successBodyText) {
          const last = attempts[attempts.length - 1];
          const message = last
            ? humanRealtimeError(
                last.kind as ReturnType<typeof classifyRealtimeFailure>,
                last.status,
                last.requestId,
                last.model,
              )
            : "OpenAI Realtime session creation failed.";
          return Response.json(
            {
              error: "openai_session_failed",
              status: last?.status ?? 502,
              endpoint: REALTIME_SESSION_URL,
              model: last?.model ?? REALTIME_MODEL,
              requestId: last?.requestId ?? null,
              kind: last?.kind ?? "unknown",
              message,
              attempts: attempts.map((a) => ({
                model: a.model,
                status: a.status,
                requestId: a.requestId,
                kind: a.kind,
                bodySnippet: a.bodySnippet,
              })),
              retryable: last?.kind === "server_error" || last?.kind === "rate_limited",
            },
            { status: 502 },
          );
        }
        const session = JSON.parse(successBodyText) as {
          value?: string;
          expires_at?: number;
          client_secret?: { value?: string; expires_at?: number };
          session?: { tools?: Array<{ name?: string }> };
          tools?: Array<{ name?: string }>;
        };
        const clientSecretValue = session.value ?? session.client_secret?.value;
        const clientSecretExpiresAt = session.expires_at ?? session.client_secret?.expires_at ?? null;
        if (!clientSecretValue) {
          return Response.json(
            { error: "openai_session_invalid", message: "OpenAI did not return an ephemeral key.", openaiBody: successBodyText.slice(0, 2000) },
            { status: 502 },
          );
        }
        const echoedTools = session.session?.tools ?? session.tools;
        const registeredToolNames = Array.isArray(echoedTools)
          ? echoedTools.map((t) => t?.name).filter(Boolean)
          : REALTIME_TOOLS.map((t) => t.name);
        console.log(
          `[realtime session] created (model ${successModel}); tools registered:`,
          registeredToolNames.join(", ") || "(none)",
        );
        if (!registeredToolNames.includes("generate_document")) {
          console.warn(
            "[realtime session] generate_document missing from OpenAI-echoed tools; client will re-register via session.update",
          );
        }
        return Response.json({
          clientSecret: clientSecretValue,
          expiresAt: clientSecretExpiresAt,
          model: successModel,
          modelChainTried: attempts.map((a) => a.model),
          voice: REALTIME_VOICE,
          instructions,
          tools: REALTIME_TOOLS,
          registeredToolNames,
          documentToolRegistered: registeredToolNames.includes(DOCUMENT_TOOL_NAME),
        });
      },
    },
  },
});