// Pure predicates for filtering transient OpenAI Realtime voice/session
// errors out of persisted chat history. These strings used to be surfaced
// (in some cases persisted) as ordinary assistant messages by older code
// paths — they are useless to end users on re-render and should be hidden.
//
// Kept dependency-free so the chat page and unit tests can share it.

const TRANSIENT_VOICE_ERROR_PATTERNS: RegExp[] = [
  /missing required parameter:\s*session\.type/i,
  /voice failed to connect/i,
  /voice setup failed\s*\(\d+\)/i,
  /voice is still closing another session/i,
  /openai realtime session creation failed/i,
  /openai realtime sdp exchange failed/i,
  /openai realtime preflight failed/i,
  /openai realtime rejected the session/i,
  /openai realtime model .+ is not available/i,
  /openai returned a temporary server error/i,
  /openai rejected the session request/i,
  /voice preflight failed/i,
  /voice session is missing (the )?(generate_document|document tool)/i,
  /microphone permission denied/i,
  /microphone unavailable/i,
  /finishing the previous voice session/i,
  /openai rejected the api key/i,
];

export function isTransientVoiceErrorMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.trim();
  if (!s) return false;
  // Only treat *short* single-line messages as transient errors — a long
  // assistant reply that merely quotes one of these strings inside a wider
  // answer should still render.
  if (s.length > 400) return false;
  if (s.split("\n").length > 3) return false;
  return TRANSIENT_VOICE_ERROR_PATTERNS.some((re) => re.test(s));
}

export function filterOutTransientVoiceErrors<T extends { role: string; content: string }>(
  messages: readonly T[],
): T[] {
  return messages.filter(
    (m) => !(m.role === "assistant" && isTransientVoiceErrorMessage(m.content)),
  );
}