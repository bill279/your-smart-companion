import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Mints an ephemeral OpenAI Realtime client secret. The raw OPENAI_API_KEY
// never leaves the server. The browser gets a short-lived client_secret it
// can use directly against api.openai.com for the WebRTC SDP exchange.

const REALTIME_MODEL = "gpt-realtime";
const REALTIME_VOICE = "alloy";
const DOCUMENT_TOOL_NAME = "generate_document";
// Current OpenAI Realtime ephemeral-secret endpoint. The legacy
// `/v1/realtime/sessions` route now returns 404 for many keys; the
// documented replacement is `/v1/realtime/client_secrets`, which returns
// `{ value, expires_at }` and accepts the session config nested under
// `session`.
const REALTIME_SESSION_URL = "https://api.openai.com/v1/realtime/client_secrets";

function realtimeToolNames() {
  return REALTIME_TOOLS.map((tool) => tool.name);
}

function hasGenerateDocumentTool(tools: readonly { name?: string }[]) {
  return tools.some((tool) => tool.name === DOCUMENT_TOOL_NAME);
}

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

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the live web for current information (news, prices, companies, people, products). Returns titles, urls, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "integer", minimum: 1, maximum: 6 },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "web_scrape",
    description: "Fetch the readable markdown content of a specific URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The absolute URL to fetch" } },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "send_email",
    description:
      "Send an email from the user's connected Outlook/Gmail account. Only call after the user has verbally approved the draft.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Email body in Markdown" },
        cc: { type: "string", description: "Optional Cc email address" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    type: "function",
    name: "generate_document",
    description:
      "Generate a downloadable PDF, DOCX, Markdown, XLSX, CSV, or TXT file and return an artifact with a signed download URL. The chat UI renders a download card automatically. Never read the generated content aloud.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["pdf", "docx", "md", "xlsx", "csv", "txt"] },
        filename: { type: "string", description: "Base filename without extension" },
        title: { type: "string" },
        summary: { type: "string", description: "Optional short executive summary (1-3 sentences)" },
        sources: {
          type: "array",
          description: "Optional citations",
          items: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" } },
            required: ["title", "url"],
          },
        },
        markdown: { type: "string", description: "Full document body in Markdown" },
      },
      required: ["format", "filename", "title", "markdown"],
    },
  },
] as const;

export const Route = createFileRoute("/api/realtime/session")({
  server: {
    handlers: {
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

        if (!hasGenerateDocumentTool(REALTIME_TOOLS)) {
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
        const upstreamPayload = {
          session: {
            type: "realtime",
            model: REALTIME_MODEL,
            instructions,
            audio: {
              input: { turn_detection: { type: "server_vad" } },
              output: { voice: REALTIME_VOICE },
            },
            tools: REALTIME_TOOLS,
            tool_choice: "auto",
          },
        };

        console.log(
          "[realtime session] creating",
          REALTIME_SESSION_URL,
          "model",
          REALTIME_MODEL,
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

        const bodyText = await upstream.text();
        if (!upstream.ok) {
          console.error(
            "[realtime session] openai rejected",
            upstream.status,
            REALTIME_SESSION_URL,
            bodyText,
          );
          const hint =
            upstream.status === 404
              ? "OpenAI Realtime endpoint or model is unavailable for this API key. Confirm OPENAI_API_KEY has Realtime access and that the model 'gpt-realtime' is enabled on the account."
              : upstream.status === 401
                ? "OpenAI rejected the API key. Verify OPENAI_API_KEY in project secrets."
                : upstream.status === 429
                  ? "OpenAI rate limit or quota exceeded on this API key."
                  : `OpenAI Realtime session creation failed (${upstream.status}).`;
          return Response.json(
            {
              error: "openai_session_failed",
              status: upstream.status,
              endpoint: REALTIME_SESSION_URL,
              model: REALTIME_MODEL,
              message: hint,
              openaiBody: bodyText.slice(0, 2000),
            },
            { status: 502 },
          );
        }
        // New endpoint returns { value, expires_at } at top level. The
        // legacy shape nested it under `client_secret`. Accept both.
        const session = JSON.parse(bodyText) as {
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
            { error: "openai_session_invalid", message: "OpenAI did not return an ephemeral key.", openaiBody: bodyText.slice(0, 2000) },
            { status: 502 },
          );
        }
        const echoedTools = session.session?.tools ?? session.tools;
        const registeredToolNames = Array.isArray(echoedTools)
          ? echoedTools.map((t) => t?.name).filter(Boolean)
          : REALTIME_TOOLS.map((t) => t.name);
        console.log(
          "[realtime session] created; tools registered:",
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
          model: REALTIME_MODEL,
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