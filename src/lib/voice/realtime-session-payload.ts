// Pure builder for the OpenAI Realtime `/v1/realtime/client_secrets`
// request body. Extracted so the exact wire shape (including the
// mandatory `session.type: "realtime"` discriminator) can be unit-tested
// without hitting the network. Do NOT inline this back into the route
// handler — the regression test guards against dropping `session.type`.

export interface BuildRealtimeSessionPayloadInput {
  model: string;
  instructions: string;
  voice: string;
}

export const REALTIME_TRANSCRIPTION_MODEL = "whisper-1" as const;
export const REALTIME_TRANSCRIPTION_PROMPT =
  "BPA Bot voice assistant. Common terms: BP Automation, BPA, Outlook, Microsoft, Vercel, Supabase, OpenAI, Realtime, ChatGPT, Claude, Codex, PDF, DOCX, XLSX, CSV, PLC, SCADA, robotics, automation, 3D printing, stereoscopic cameras, mining, underground drilling.";

export function buildRealtimeSessionPayload({
  model,
  instructions,
  voice,
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
            // silence thresholds. Medium is the best current tradeoff here:
            // low felt too slow in mobile testing, while high risks cutting
            // off longer business requests.
            type: "semantic_vad" as const,
            eagerness: "medium" as const,
            // create_response is deliberately false: Realtime is transport
            // only. Finished user turns are delegated to /api/chat, the
            // single source of truth for reasoning, tools, persistence,
            // approvals, files, research, and visual answers. Realtime only
            // transcribes the user and speaks a short summary after the chat
            // answer exists.
            create_response: false,
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
      // Final-product architecture: no tools are registered in Realtime.
      // Tool execution belongs to /api/chat so voice and text share the same
      // agent brain and cannot race each other.
      tools: [],
      tool_choice: "auto" as const,
    },
  };
}
