import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildRealtimeSessionPayload } from "@/lib/voice/realtime-session-payload";
import {
  REALTIME_PRIMARY_MODEL,
  REALTIME_FALLBACK_MODELS,
  classifyRealtimeFailure,
  shouldTryFallbackModel,
  humanRealtimeError,
  extractRequestId,
} from "@/lib/voice/realtime-errors";
import { REALTIME_TOOLS, realtimeToolNames } from "@/lib/voice/realtime-tools";

// Mints an ephemeral OpenAI Realtime client secret. The raw OPENAI_API_KEY
// never leaves the server. The browser gets a short-lived client_secret it
// can use directly against api.openai.com for the WebRTC SDP exchange.

const REALTIME_MODEL = REALTIME_PRIMARY_MODEL;
const REALTIME_VOICE = "shimmer";
// Current OpenAI Realtime ephemeral-secret endpoint. The legacy
// `/v1/realtime/sessions` route now returns 404 for many keys; the
// documented replacement is `/v1/realtime/client_secrets`, which returns
// `{ value, expires_at }` and accepts the session config nested under
// `session`.
const REALTIME_SESSION_URL = "https://api.openai.com/v1/realtime/client_secrets";

function buildInstructions() {
  return [
    "You are BPA Bot, BP Automation's voice assistant. You are fast, polished, concise, accurate, and useful.",
    "For simple conversational turns, answer directly and immediately.",
    "You have tools for live web research, Outlook email, briefings, replies, sending approved emails, and generating downloadable documents. Use them when needed instead of saying you cannot.",
    "Default to 1 short sentence. Use 2 sentences only when needed. Never monologue.",
    "Do not greet or introduce yourself again after the first exchange.",
    "Avoid filler like 'sure thing', 'absolutely', 'let me', 'I can help with that', apologies loops, jokes, and rambling.",
    "If audio is unclear, partial, or mid-thought, ask one short repair question. If the user says wait/cancel/never mind, say 'Okay — I’ll wait.'",
    "If the user asks what you can help with / what can you do, answer exactly one short sentence: 'I can help with research, email, calendar, PDFs/documents, comparisons, and BP Automation knowledge.' Do not list examples unless asked.",
    "Never read tables, lists, code, or long drafts aloud. If the answer requires a table/list/links/draft, give a one-sentence executive summary only. Do not claim links, details, or a table are on screen unless they have actually been inserted into chat. Do not speak column headers, pipes, dashes, or row-by-row cell values.",
    "For research, use web_search and include source URLs in the chat-visible text response.",
    "For PDFs/documents, call generate_document and then say one short sentence that it is ready in chat.",
    "Email safety: never send email on the first request. Present a concise draft/readback and wait for explicit approval. Only call send_email with approved:true after the user's latest reply clearly approves the immediately previous draft.",
    "Do not repeat yourself across turns. If you already asked for confirmation, wait for yes/no/edits. If the user approves, act immediately. If the user is silent, stay quiet.",
    "Never think out loud, narrate internal steps, or fill silence.",
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
        return Response.json({
          ok: true,
          model: REALTIME_MODEL,
          fallbackModels: REALTIME_FALLBACK_MODELS,
          endpoint: REALTIME_SESSION_URL,
          tools: realtimeToolNames(),
          documentToolRegistered: true,
          architecture: "native_realtime_with_tools",
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

        const instructions = buildInstructions();
        // Try primary model, then a documented fallback for 5xx / model-not-available.
        const modelChain = [REALTIME_MODEL, ...REALTIME_FALLBACK_MODELS];
        const attempts: Array<{ model: string; status: number; requestId: string | null; bodySnippet: string; kind: string }> = [];
        let successModel: string | null = null;
        let successBodyText: string | null = null;
        for (const candidateModel of modelChain) {
          const upstreamPayload = buildRealtimeSessionPayload({
            model: candidateModel,
            instructions,
            voice: REALTIME_VOICE,
            tools: REALTIME_TOOLS,
          });
          console.log(
            "[realtime session] creating",
            REALTIME_SESSION_URL,
            "model",
            candidateModel,
            "native_tools",
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
          : [];
        console.log(
          `[realtime session] created (model ${successModel}); tools registered:`,
          registeredToolNames.join(", ") || "(none)",
        );
        return Response.json({
          clientSecret: clientSecretValue,
          expiresAt: clientSecretExpiresAt,
          model: successModel,
          modelChainTried: attempts.map((a) => a.model),
          voice: REALTIME_VOICE,
          instructions,
          tools: REALTIME_TOOLS,
          registeredToolNames,
          documentToolRegistered: true,
          architecture: "native_realtime_with_tools",
        });
      },
    },
  },
});
