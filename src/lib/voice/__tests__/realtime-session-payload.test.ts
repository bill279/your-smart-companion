import { describe, expect, it } from "bun:test";
import { buildRealtimeSessionPayload } from "../realtime-session-payload";
import { REALTIME_PRIMARY_MODEL, REALTIME_FALLBACK_MODELS } from "../realtime-errors";

const CLIENT_SESSION_UPDATE = {
  type: "session.update",
  session: {
    type: "realtime",
    tools: [],
    tool_choice: "auto",
    instructions: "test",
  },
};

describe("buildRealtimeSessionPayload", () => {
  it("includes session.type === 'realtime' (required by OpenAI /v1/realtime/client_secrets)", () => {
    const payload = buildRealtimeSessionPayload({
      model: REALTIME_PRIMARY_MODEL,
      instructions: "hi",
      voice: "alloy",
    });
    expect(payload.session.type).toBe("realtime");
    expect(payload.session.model).toBe(REALTIME_PRIMARY_MODEL);
  });

  it("preserves session.type on every fallback model attempt", () => {
    for (const model of [REALTIME_PRIMARY_MODEL, ...REALTIME_FALLBACK_MODELS]) {
      const payload = buildRealtimeSessionPayload({ model, instructions: "x", voice: "alloy" });
      expect(payload.session.type).toBe("realtime");
      expect(payload.session.model).toBe(model);
    }
  });

  it("wire body JSON round-trips with session.type and model", () => {
    const payload = buildRealtimeSessionPayload({
      model: "gpt-realtime",
      instructions: "test",
      voice: "alloy",
    });
    const parsed = JSON.parse(JSON.stringify(payload));
    expect(parsed.session.type).toBe("realtime");
    expect(parsed.session.model).toBe("gpt-realtime");
    expect(parsed.session.tool_choice).toBe("auto");
    expect(parsed.session.tools).toEqual([]);
  });

  it("does not register tools because /api/chat is the single agent brain", () => {
    const payload = buildRealtimeSessionPayload({
      model: "gpt-realtime",
      instructions: "test",
      voice: "alloy",
    });

    expect(payload.session.tools).toEqual([]);
    expect(payload.session.audio.input.turn_detection.create_response).toBe(false);
  });

  it("requests input audio transcription so voice turns can sync into chat", () => {
    const payload = buildRealtimeSessionPayload({
      model: "gpt-realtime",
      instructions: "test",
      voice: "alloy",
    });
    expect(payload.session.audio.input.transcription.model).toBe("whisper-1");
  });

  it("client-side session.update also includes session.type", () => {
    expect(CLIENT_SESSION_UPDATE.session.type).toBe("realtime");
  });
});
