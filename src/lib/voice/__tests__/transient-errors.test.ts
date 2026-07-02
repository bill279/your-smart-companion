import { describe, expect, it } from "bun:test";
import {
  filterOutTransientVoiceErrors,
  isTransientVoiceErrorMessage,
} from "../transient-errors";

describe("isTransientVoiceErrorMessage", () => {
  it.each([
    "Missing required parameter: session.type",
    "OpenAI Realtime session creation failed (500)",
    "Voice failed to connect. Tap the mic once to try again",
    "Voice setup failed (400).",
    "Voice is still closing another session. Wait a few seconds, then tap the mic once.",
    "OpenAI Realtime SDP exchange failed (401) at https://api.openai.com/v1/realtime/calls",
    "OpenAI Realtime preflight failed",
    "OpenAI Realtime model gpt-realtime is not available for this key",
    "OpenAI returned a temporary server error (500) for gpt-realtime.",
    "Microphone permission denied. Enable mic access for this site and tap the mic again.",
    "Finishing the previous voice session… reconnecting automatically",
    "Voice session is missing the document tool — PDF/DOCX generation unavailable until you restart the mic.",
  ])("flags transient message %#", (msg) => {
    expect(isTransientVoiceErrorMessage(msg)).toBe(true);
  });

  it("does not flag normal assistant answers", () => {
    expect(isTransientVoiceErrorMessage("Sure — here is the comparison table:")).toBe(false);
    expect(isTransientVoiceErrorMessage("")).toBe(false);
    expect(isTransientVoiceErrorMessage(null)).toBe(false);
  });

  it("does not flag long answers that merely quote the phrase", () => {
    const long =
      "Earlier we saw the error 'Missing required parameter: session.type'. " +
      "That's now fixed by the shared payload builder. " +
      "Here is a detailed explanation of what changed... ".repeat(20);
    expect(isTransientVoiceErrorMessage(long)).toBe(false);
  });
});

describe("filterOutTransientVoiceErrors", () => {
  it("drops assistant messages whose content matches a transient error", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Missing required parameter: session.type" },
      { role: "assistant", content: "Here is your PDF summary." },
      { role: "user", content: "Missing required parameter: session.type" },
    ];
    const out = filterOutTransientVoiceErrors(messages);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.content)).toEqual([
      "hi",
      "Here is your PDF summary.",
      "Missing required parameter: session.type", // user content is left untouched
    ]);
  });
});