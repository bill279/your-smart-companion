export const TRANSCRIPTION_PROMPT =
  "Business assistant voice commands. Common phrases: send it, email it to me, email that to, attach the PDF, convert to Word, convert to PDF, generate a report, add to calendar, book a meeting, cancel the meeting, reply to, follow up with, find, search for, look up. Common names include Bill, Randy, Jane, Mike, Sarah, John.";

type RealtimeToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function realtimeModelName() {
  return "gpt-realtime-2.1";
}

export function realtimeSessionConfig(input?: {
  instructions?: string;
  tools?: RealtimeToolDef[];
}) {
  const tools = input?.tools ?? [];
  return {
    type: "realtime",
    model: realtimeModelName(),
    output_modalities: ["audio"],
    instructions: input?.instructions ?? "",
    audio: {
      input: {
        transcription: {
          model: "gpt-realtime-whisper",
          language: "en",
          prompt: TRANSCRIPTION_PROMPT,
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: false,
          interrupt_response: true,
        },
      },
      output: { voice: "marin" },
    },
    tools,
    tool_choice: tools.length > 0 ? "auto" : "none",
  } satisfies Record<string, unknown>;
}