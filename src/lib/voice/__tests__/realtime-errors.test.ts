/// <reference types="bun" />
import { describe, it, expect } from "bun:test";
import {
  classifyRealtimeFailure,
  shouldTryFallbackModel,
  pickNextRealtimeModel,
  humanRealtimeError,
  extractRequestId,
  REALTIME_PRIMARY_MODEL,
  REALTIME_FALLBACK_MODELS,
} from "../realtime-errors";

describe("classifyRealtimeFailure", () => {
  it("maps 5xx to server_error", () => {
    expect(classifyRealtimeFailure(500, "")).toBe("server_error");
    expect(classifyRealtimeFailure(502, "")).toBe("server_error");
    expect(classifyRealtimeFailure(503, "gateway")).toBe("server_error");
  });
  it("maps 404 to model_unavailable", () => {
    expect(classifyRealtimeFailure(404, "not found")).toBe("model_unavailable");
  });
  it("maps 401 / 429 / 400", () => {
    expect(classifyRealtimeFailure(401, "")).toBe("unauthorized");
    expect(classifyRealtimeFailure(429, "")).toBe("rate_limited");
    expect(classifyRealtimeFailure(400, "invalid field")).toBe("bad_request");
  });
  it("treats 400 with model_not_found body as model_unavailable", () => {
    expect(classifyRealtimeFailure(400, "The model `gpt-realtime` does not exist")).toBe(
      "model_unavailable",
    );
  });
});

describe("shouldTryFallbackModel", () => {
  it("only retries on server_error and model_unavailable", () => {
    expect(shouldTryFallbackModel("server_error")).toBe(true);
    expect(shouldTryFallbackModel("model_unavailable")).toBe(true);
    expect(shouldTryFallbackModel("unauthorized")).toBe(false);
    expect(shouldTryFallbackModel("rate_limited")).toBe(false);
    expect(shouldTryFallbackModel("bad_request")).toBe(false);
    expect(shouldTryFallbackModel("unknown")).toBe(false);
  });
});

describe("pickNextRealtimeModel", () => {
  it("returns primary first", () => {
    expect(pickNextRealtimeModel([])).toBe(REALTIME_PRIMARY_MODEL);
  });
  it("returns documented fallback after primary tried", () => {
    const next = pickNextRealtimeModel([REALTIME_PRIMARY_MODEL]);
    expect(REALTIME_FALLBACK_MODELS).toContain(next as (typeof REALTIME_FALLBACK_MODELS)[number]);
  });
  it("returns null after full chain exhausted", () => {
    expect(pickNextRealtimeModel([REALTIME_PRIMARY_MODEL, ...REALTIME_FALLBACK_MODELS])).toBeNull();
  });
});

describe("humanRealtimeError", () => {
  it("includes request id and model on server error", () => {
    const msg = humanRealtimeError("server_error", 500, "req_abc123", "gpt-realtime");
    expect(msg).toContain("temporary server error");
    expect(msg).toContain("500");
    expect(msg).toContain("gpt-realtime");
    expect(msg).toContain("req_abc123");
  });
  it("does not leak API key wording", () => {
    for (const k of ["server_error", "unauthorized", "rate_limited", "model_unavailable", "bad_request", "unknown"] as const) {
      const msg = humanRealtimeError(k, 500, "req", "gpt-realtime");
      expect(msg.toLowerCase()).not.toContain("sk-");
      expect(msg.toLowerCase()).not.toContain("bearer ");
    }
  });
});

describe("extractRequestId", () => {
  it("reads x-request-id first", () => {
    const h = new Headers({ "x-request-id": "req_1", "openai-request-id": "req_2" });
    expect(extractRequestId(h)).toBe("req_1");
  });
  it("falls back to openai-request-id", () => {
    const h = new Headers({ "openai-request-id": "req_2" });
    expect(extractRequestId(h)).toBe("req_2");
  });
  it("returns null when absent", () => {
    expect(extractRequestId(new Headers())).toBeNull();
  });
});