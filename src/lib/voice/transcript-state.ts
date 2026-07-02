// Pure reducer helpers for the live voice transcript panel. Kept out of
// the React component so we can unit-test the state transitions without
// mounting the chat page.

export type VoiceTranscriptState = {
  interimUser: string;
  interimAssistant: string;
};

export const EMPTY_VOICE_TRANSCRIPT: VoiceTranscriptState = {
  interimUser: "",
  interimAssistant: "",
};

export function applyTranscriptEvent(
  prev: VoiceTranscriptState,
  role: "user" | "assistant",
  text: string,
  done: boolean,
): VoiceTranscriptState {
  if (role === "assistant") {
    if (done) {
      // Assistant turn finished — clear both interim buffers so the next
      // user utterance starts from a clean slate.
      return EMPTY_VOICE_TRANSCRIPT;
    }
    return { ...prev, interimAssistant: text };
  }
  // role === "user"
  if (done) {
    // Final user transcript is about to be persisted as a real message —
    // drop the interim placeholder.
    return { ...prev, interimUser: "" };
  }
  return { ...prev, interimUser: text };
}