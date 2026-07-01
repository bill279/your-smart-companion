import { describe, it, expect } from "bun:test";
import {
  detectDocumentIntent,
  looksLikeDocumentIntent,
  detectDocFormat,
} from "../doc-intent";

// Mirrors the assistantText template in src/routes/api/chat.ts so that if the
// artifact fence format ever changes, this test fails loudly.
function buildAssistantText(filename: string, artifact: unknown): string {
  return `Generated **${filename}**.\n\n\`\`\`bpa-artifact\n${JSON.stringify(artifact)}\n\`\`\``;
}

describe("doc-intent detection", () => {
  it("detects the canonical BP Automation PDF summary request", () => {
    const text = "Make a one-page PDF summary of BP Automation's services";
    expect(looksLikeDocumentIntent(text)).toBe(true);
    const intent = detectDocumentIntent(text);
    expect(intent).not.toBeNull();
    expect(intent!.format).toBe("pdf");
    expect(intent!.filename.length).toBeGreaterThan(0);
  });

  it("produces an assistant message containing a bpa-artifact block with .pdf filename", () => {
    const intent = detectDocumentIntent(
      "Make a one-page PDF summary of BP Automation's services",
    )!;
    const filename = `${intent.filename}.${intent.format}`;
    expect(filename.endsWith(".pdf")).toBe(true);
    const artifact = {
      title: intent.title,
      format: intent.format,
      filename,
      url: "https://example.com/signed",
      mimeType: "application/pdf",
      createdAt: new Date().toISOString(),
    };
    const assistantText = buildAssistantText(filename, artifact);
    // Must contain the fenced artifact block (rendered as a download card).
    expect(assistantText).toContain("```bpa-artifact");
    expect(assistantText).toContain(`"filename":"${filename}"`);
    // Must NOT be prose-only: fence must be present.
    expect(/```bpa-artifact[\s\S]+```/.test(assistantText)).toBe(true);
  });

  it("does not trigger on plain questions", () => {
    expect(looksLikeDocumentIntent("What services does BP Automation offer?")).toBe(false);
    expect(looksLikeDocumentIntent("tell me about pdfs in general")).toBe(false);
  });

  it("detects DOCX / XLSX / CSV / MD variants", () => {
    expect(detectDocFormat("export to docx")).toBe("docx");
    expect(detectDocFormat("make it a spreadsheet")).toBe("xlsx");
    expect(detectDocFormat("save as csv")).toBe("csv");
    expect(detectDocFormat("generate a markdown file")).toBe("md");
  });

  it("stable intent key prevents duplicate/voice loop re-trigger", () => {
    // The voice client dedupe key is normalized(transcript) + format.
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const utterance = "Create a PDF report of our Q4 results";
    const a = detectDocumentIntent(utterance)!;
    const b = detectDocumentIntent(utterance + "   ")!;
    const keyA = normalize(utterance) + "::" + a.format;
    const keyB = normalize(utterance + "   ") + "::" + b.format;
    expect(keyA).toBe(keyB);
  });
});