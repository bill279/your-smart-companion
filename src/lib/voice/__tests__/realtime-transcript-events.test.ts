import { describe, expect, it } from "bun:test";
import { transcriptEventFromRealtime } from "../realtime-transcript-events";

describe("transcriptEventFromRealtime", () => {
  it("streams assistant output audio transcript deltas into chat", () => {
    const first = transcriptEventFromRealtime(
      { type: "response.output_audio_transcript.delta", delta: "I generated" },
      { assistant: "", user: "" },
    );
    expect(first.transcript).toEqual({
      role: "assistant",
      text: "I generated",
      done: false,
    });

    const second = transcriptEventFromRealtime(
      { type: "response.output_audio_transcript.delta", delta: " the PDF." },
      first.next,
    );
    expect(second.transcript).toEqual({
      role: "assistant",
      text: "I generated the PDF.",
      done: false,
    });
  });

  it("commits assistant text from output item done when no transcript delta arrived", () => {
    const parsed = transcriptEventFromRealtime(
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The summary is on screen." }],
        },
      },
      { assistant: "", user: "" },
    );
    expect(parsed.transcript).toEqual({
      role: "assistant",
      text: "The summary is on screen.",
      done: true,
    });
  });

  it("commits completed user audio transcription from the buffered interim text", () => {
    const interim = transcriptEventFromRealtime(
      { type: "conversation.item.input_audio_transcription.delta", delta: "make a pdf" },
      { assistant: "", user: "" },
    );
    expect(interim.transcript).toEqual({
      role: "user",
      text: "make a pdf",
      done: false,
    });

    const done = transcriptEventFromRealtime(
      { type: "conversation.item.input_audio_transcription.completed" },
      interim.next,
    );
    expect(done.transcript).toEqual({
      role: "user",
      text: "make a pdf",
      done: true,
    });
    expect(done.next.user).toBe("");
  });
});
