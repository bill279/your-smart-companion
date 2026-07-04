export type RealtimeTranscriptRole = "user" | "assistant";

export type RealtimeTranscriptEvent = {
  role: RealtimeTranscriptRole;
  text: string;
  done: boolean;
};

type ContentPart = {
  type?: string;
  text?: string;
  transcript?: string;
};

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  item?: {
    type?: string;
    role?: string;
    content?: ContentPart[];
  };
  response?: {
    output?: Array<{
      type?: string;
      role?: string;
      content?: ContentPart[];
    }>;
  };
};

function textFromParts(parts: ContentPart[] | undefined): string {
  return (parts ?? [])
    .map((part) => part.transcript ?? part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function firstText(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
}

export function extractAssistantText(event: RealtimeServerEvent): string {
  return firstText(
    event.transcript,
    event.text,
    textFromParts(event.response?.output?.flatMap((item) => item.content ?? [])),
    textFromParts(event.item?.content),
  );
}

export function extractUserText(event: RealtimeServerEvent, fallback = ""): string {
  return firstText(event.transcript, event.text, textFromParts(event.item?.content), fallback);
}

export function transcriptEventFromRealtime(
  event: RealtimeServerEvent,
  buffers: { assistant: string; user: string },
): { transcript?: RealtimeTranscriptEvent; next: { assistant: string; user: string } } {
  const next = { ...buffers };
  switch (event.type) {
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta":
    case "response.text.delta":
    case "response.output_text.delta": {
      next.assistant += event.delta ?? "";
      return {
        transcript: next.assistant.trim()
          ? { role: "assistant", text: next.assistant, done: false }
          : undefined,
        next,
      };
    }
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done":
    case "response.text.done":
    case "response.output_text.done": {
      const text = extractAssistantText(event) || next.assistant.trim();
      next.assistant = "";
      return {
        transcript: text ? { role: "assistant", text, done: true } : undefined,
        next,
      };
    }
    case "response.output_item.done":
    case "conversation.item.created":
    case "conversation.item.completed": {
      if (event.item?.type === "function_call") return { next };
      const role = event.item?.role === "user" ? "user" : event.item?.role === "assistant" ? "assistant" : null;
      const text = role === "user" ? extractUserText(event, next.user) : extractAssistantText(event);
      if (!role || !text) return { next };
      if (role === "user") next.user = "";
      if (role === "assistant") next.assistant = "";
      return { transcript: { role, text, done: true }, next };
    }
    case "response.done": {
      const text = extractAssistantText(event);
      if (!text) return { next };
      next.assistant = "";
      return { transcript: { role: "assistant", text, done: true }, next };
    }
    case "conversation.item.input_audio_transcription.completed":
    case "input_audio_transcription.completed":
    case "conversation.item.input_audio_transcription.done": {
      const text = extractUserText(event, next.user);
      next.user = "";
      return {
        transcript: text ? { role: "user", text, done: true } : undefined,
        next,
      };
    }
    case "conversation.item.input_audio_transcription.delta":
    case "input_audio_transcription.delta": {
      next.user += event.delta ?? "";
      return {
        transcript: next.user.trim()
          ? { role: "user", text: next.user, done: false }
          : undefined,
        next,
      };
    }
    default:
      return { next };
  }
}
