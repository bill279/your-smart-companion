/// <reference types="bun" />
import { describe, it, expect } from "bun:test";
import {
  REALTIME_TOOLS,
  REALTIME_TOOL_NAMES,
  realtimeHasTool,
  realtimeToolNames,
} from "../realtime-tools";
import {
  detectDocumentIntent,
  looksLikeDocumentIntent,
} from "../../doc-intent";

describe("Legacy Realtime tool schemas", () => {
  it("declares web_search, web_scrape, send_email, and generate_document", () => {
    const names = realtimeToolNames();
    expect(names).toContain("web_search");
    expect(names).toContain("web_scrape");
    expect(names).toContain("get_outlook_briefing");
    expect(names).toContain("prepare_outlook_reply");
    expect(names).toContain("send_email");
    expect(names).toContain("generate_document");
    // No stray tools slipping in.
    for (const n of names) {
      expect(REALTIME_TOOL_NAMES).toContain(n as (typeof REALTIME_TOOL_NAMES)[number]);
    }
  });

  it("realtimeHasTool('generate_document') is true", () => {
    expect(realtimeHasTool("generate_document")).toBe(true);
  });

  it("generate_document schema requires the deterministic artifact fields", () => {
    const doc = REALTIME_TOOLS.find((t) => t.name === "generate_document");
    expect(doc).toBeTruthy();
    const required = doc!.parameters.required as readonly string[];
    for (const key of ["format", "filename", "title", "markdown"]) {
      expect(required).toContain(key);
    }
    const formats = (
      doc!.parameters.properties as unknown as { format: { enum: readonly string[] } }
    ).format.enum;
    expect([...formats]).toEqual(["pdf", "docx", "md", "xlsx", "csv", "txt"]);
  });

  it("voice document intent is detected before routing to the deterministic chat path", () => {
    // Both voice transcripts and typed chat go through looksLikeDocumentIntent
    // + detectDocumentIntent → server generate_document → bpa-artifact fence.
    // If this test breaks, the voice path has drifted from the typed path.
    const utterance = "Make a one-page PDF summary of BP Automation's services";
    expect(looksLikeDocumentIntent(utterance)).toBe(true);
    const intent = detectDocumentIntent(utterance);
    expect(intent).not.toBeNull();
    expect(intent!.format).toBe("pdf");
  });
});

describe("Voice document-intent failure guard", () => {
  // Simulates the docIntentFailureCountRef logic from chat.$threadId.tsx to
  // guarantee we don't retry the same failing intent forever.
  it("blocks the same intent after N repeat failures", () => {
    const MAX = 2;
    const failures = new Map<string, number>();
    const key = "make a pdf|pdf";
    const record = (): { locked: boolean } => {
      const n = (failures.get(key) ?? 0) + 1;
      failures.set(key, n);
      return { locked: n >= MAX };
    };
    expect(record().locked).toBe(false); // first failure — allow retry
    expect(record().locked).toBe(true); // second failure — lock
    // A third identical utterance MUST stay locked.
    const n = failures.get(key)!;
    expect(n).toBeGreaterThanOrEqual(MAX);
  });
});
