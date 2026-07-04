// Pure builder for the OpenAI Realtime `/v1/realtime/client_secrets`
// request body. Extracted so the exact wire shape (including the
// mandatory `session.type: "realtime"` discriminator) can be unit-tested
// without hitting the network. Do NOT inline this back into the route
// handler — the regression test guards against dropping `session.type`.

import { REALTIME_TOOLS } from "./realtime-tools";

export interface BuildRealtimeSessionPayloadInput {
  model: string;
  instructions: string;
  voice: string;
}

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
            // waits through "umm..." / mid-thought pauses and is less likely
            // to cut the user off than raw silence thresholds.
            type: "semantic_vad" as const,
            eagerness: "low" as const,
            create_response: true,
            interrupt_response: true,
          },
          transcription: { model: "whisper-1" as const },
        },
        output: { voice },
      },
      tools: REALTIME_TOOLS,
      tool_choice: "auto" as const,
    },
  };
}
