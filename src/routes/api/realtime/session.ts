import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Mints an ephemeral OpenAI Realtime client secret. The raw OPENAI_API_KEY
// never leaves the server. The browser gets a short-lived client_secret it
// can use directly against api.openai.com for the WebRTC SDP exchange.

const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";
const REALTIME_VOICE = "alloy";

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
    "You have tools: web_search (live web results), web_scrape (fetch a specific URL as markdown), and send_email (send from the user's connected Outlook/Gmail account). Use them silently when needed — never narrate 'let me search'. For send_email you MUST first speak a brief draft (recipient, subject, one-line body summary) and wait for explicit approval ('send it', 'yes') before calling the tool.",
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

        const upstream = await fetch("https://api.openai.com/v1/realtime/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: REALTIME_MODEL,
            voice: REALTIME_VOICE,
            modalities: ["audio", "text"],
            instructions: buildInstructions(costMode, maxSeconds, userEmail),
            turn_detection: { type: "server_vad" },
            tools: REALTIME_TOOLS,
            tool_choice: "auto",
          }),
        });

        const bodyText = await upstream.text();
        if (!upstream.ok) {
          console.error("openai realtime session failed", upstream.status, bodyText);
          return Response.json(
            {
              error: "openai_session_failed",
              message: `OpenAI Realtime rejected the session (${upstream.status}). Try again shortly.`,
            },
            { status: 502 },
          );
        }
        const session = JSON.parse(bodyText) as {
          client_secret?: { value?: string; expires_at?: number };
        };
        if (!session.client_secret?.value) {
          return Response.json(
            { error: "openai_session_invalid", message: "OpenAI did not return an ephemeral key." },
            { status: 502 },
          );
        }
        return Response.json({
          clientSecret: session.client_secret.value,
          expiresAt: session.client_secret.expires_at ?? null,
          model: REALTIME_MODEL,
          voice: REALTIME_VOICE,
        });
      },
    },
  },
});