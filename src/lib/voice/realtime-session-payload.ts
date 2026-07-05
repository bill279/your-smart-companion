// Pure builder for the OpenAI Realtime `/v1/realtime/client_secrets`
// request body. Extracted so the exact wire shape (including the
// mandatory `session.type: "realtime"` discriminator) can be unit-tested
// without hitting the network. Do NOT inline this back into the route
// handler — the regression test guards against dropping `session.type`.

export interface BuildRealtimeSessionPayloadInput {
  model: string;
  instructions: string;
  voice: string;
  tools?: readonly unknown[];
}

export const REALTIME_TRANSCRIPTION_MODEL = "whisper-1" as const;
export const REALTIME_TRANSCRIPTION_PROMPT =
  "BPA Bot voice assistant. Common terms: BP Automation, BPA, Outlook, Microsoft, Vercel, Supabase, OpenAI, Realtime, ChatGPT, Claude, Codex, PDF, DOCX, XLSX, CSV, PLC, SCADA, robotics, automation, 3D printing, stereoscopic cameras, mining, underground drilling.";

export function buildRealtimeSessionPayload({
  model,
  instructions,
  voice,
  tools = [],
}: BuildRealtimeSessionPayloadInput) {
  return {
    session: {
      // REQUIRED by OpenAI: without `type: "realtime"` the API responds
      // with 400 "Missing required parameter: session.type".
      type: "realtime" as const,
      model,
      instructions,
      audio: {
        input: {
          turn_detection: {
            // Semantic VAD is closer to ChatGPT-style voice behavior: it
            // waits through "umm..." / mid-thought pauses better than raw
            // silence thresholds. High gives the snappiest mobile feel; the
            // heavier chat-brain route still handles longer/tool requests
            // after the final transcript lands.
            type: "semantic_vad" as const,
            eagerness: "high" as const,
            // Native voice-agent mode. Let Realtime respond immediately after
            // VAD commits the user's turn; tools are handled by a server-side
            // dispatcher. This is closer to ChatGPT/Claude voice behavior
            // than a transcribe-then-chat-then-speak pipeline.
            create_response: true,
            interrupt_response: true,
          },
          transcription: {
            model: REALTIME_TRANSCRIPTION_MODEL,
            language: "en" as const,
            prompt: REALTIME_TRANSCRIPTION_PROMPT,
          },
        },
        output: { voice },
      },
      tools,
      tool_choice: "auto" as const,
    },
  };
}
