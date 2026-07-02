import { describe, expect, it } from "bun:test";
import {
  applyTranscriptEvent,
  EMPTY_VOICE_TRANSCRIPT,
} from "../transcript-state";

describe("applyTranscriptEvent", () => {
  it("buffers interim assistant text", () => {
    const s1 = applyTranscriptEvent(EMPTY_VOICE_TRANSCRIPT, "assistant", "Hello", false);
    const s2 = applyTranscriptEvent(s1, "assistant", "Hello world", false);
    expect(s2.interimAssistant).toBe("Hello world");
    expect(s2.interimUser).toBe("");
  });

  it("clears both buffers when assistant turn completes", () => {
    const s1 = { interimUser: "you're saying", interimAssistant: "hi" };
    const s2 = applyTranscriptEvent(s1, "assistant", "hi there", true);
    expect(s2).toEqual(EMPTY_VOICE_TRANSCRIPT);
  });

  it("buffers interim user speech and clears on final", () => {
    const s1 = applyTranscriptEvent(EMPTY_VOICE_TRANSCRIPT, "user", "make me", false);
    const s2 = applyTranscriptEvent(s1, "user", "make me a pdf", false);
    expect(s2.interimUser).toBe("make me a pdf");
    const s3 = applyTranscriptEvent(s2, "user", "make me a pdf.", true);
    expect(s3.interimUser).toBe("");
  });

  it("does not touch assistant interim while user is speaking", () => {
    const s1 = { interimUser: "", interimAssistant: "half of a reply" };
    const s2 = applyTranscriptEvent(s1, "user", "wait", false);
    expect(s2.interimAssistant).toBe("half of a reply");
    expect(s2.interimUser).toBe("wait");
  });
});