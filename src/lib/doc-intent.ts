// Shared document-generation intent detection used by both the text chat
// server route and the voice client. Keep this file dependency-free so it
// stays safe to import from both the client bundle and the server route.

export type DocFormat = "pdf" | "docx" | "xlsx" | "csv" | "md" | "txt";

// Trigger verbs / phrasing that clearly signal the user wants a downloadable file.
const DOCUMENT_INTENT_REGEX =
  /\b(?:(?:create|generate|make|build|export|send|give|produce|prepare|draft|save|download|attach|turn (?:it|that|this) into)\s+(?:me\s+)?(?:a|an|the)?\s*(?:pdf|word\s*doc(?:ument)?|docx|doc|excel|xlsx|spreadsheet|csv|markdown|md\s*file|report|summary\s*file|attachment|download(?:able)?\s*(?:file|document)?|file\s+(?:of|from|with)))|\b(?:as|to|into)\s+(?:a\s+)?(?:pdf|word\s*doc(?:ument)?|docx|excel|xlsx|spreadsheet|csv|markdown)\b|\bmake\s+(?:it|that|this)\s+(?:a\s+)?(?:pdf|word|docx|excel|xlsx|spreadsheet|csv|markdown|report|document)\b/i;

export function looksLikeDocumentIntent(text: string): boolean {
  if (!text) return false;
  return DOCUMENT_INTENT_REGEX.test(text);
}

export function detectDocFormat(text: string): DocFormat {
  const s = (text || "").toLowerCase();
  if (/\bpdf\b/.test(s)) return "pdf";
  if (/\b(?:docx|word\s*doc(?:ument)?|word\s+file|\.docx)\b/.test(s)) return "docx";
  if (/\b(?:xlsx|excel|spreadsheet|workbook)\b/.test(s)) return "xlsx";
  if (/\bcsv\b/.test(s)) return "csv";
  if (/\b(?:markdown|\.md|md\s+file)\b/.test(s)) return "md";
  if (/\b(?:txt|text\s+file|plain\s+text)\b/.test(s)) return "txt";
  // Sensible default for "make a report" / "summary file" / "document"
  return "pdf";
}

export function deriveDocTitle(text: string): string {
  const cleaned = (text || "")
    .replace(/^\s*(please|could you|can you|hey|hi|ok|okay)[,: ]+/i, "")
    .replace(/[\s]+/g, " ")
    .trim();
  // Strip leading trigger verb + article ("make a one-page PDF summary of X" -> "one-page PDF summary of X")
  const stripped = cleaned.replace(
    /^(?:create|generate|make|build|export|send|give|produce|prepare|draft|save|download|attach)\s+(?:me\s+)?(?:a|an|the)\s+/i,
    "",
  );
  const base = stripped.length ? stripped : cleaned;
  const capped = base.length > 90 ? base.slice(0, 87).trimEnd() + "…" : base;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

export function deriveDocFilename(title: string): string {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return safe || "document";
}

export interface DocIntent {
  format: DocFormat;
  title: string;
  filename: string;
}

export function detectDocumentIntent(text: string): DocIntent | null {
  if (!looksLikeDocumentIntent(text)) return null;
  const format = detectDocFormat(text);
  const title = deriveDocTitle(text);
  const filename = deriveDocFilename(title);
  return { format, title, filename };
}