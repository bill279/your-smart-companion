import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export type AttachmentInput = {
  filename: string;
  type: "pdf" | "xlsx" | "docx";
  /** Markdown source. The renderer converts headings, paragraphs, lists, and pipe tables. */
  content: string;
  /** Optional document title used as the PDF heading / docx title. Defaults to filename. */
  title?: string;
};

export type BuiltAttachment = {
  filename: string;
  mimeType: string;
  base64: string;
};

const MIME: Record<AttachmentInput["type"], string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function ensureExt(name: string, ext: string) {
  return name.toLowerCase().endsWith("." + ext) ? name : `${name}.${ext}`;
}

/* ---------------- Markdown → blocks ---------------- */

type Block =
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

function stripInline(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Heading
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1].length as 1 | 2 | 3, text: stripInline(h[2]) });
      i++; continue;
    }

    // Pipe table: header | --- | rows
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const splitRow = (r: string) =>
        r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => stripInline(c));
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(stripInline(lines[i].replace(/^\s*[-*+]\s+/, "")));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(stripInline(lines[i].replace(/^\s*\d+\.\s+/, "")));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph: gather contiguous non-blank, non-block lines
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|[-*+]\s|\d+\.\s|\|)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push({ kind: "p", text: stripInline(para.join(" ")) });
  }
  return blocks;
}

/* ---------------- PDF ---------------- */

function bytesToBase64(bytes: Uint8Array): string {
  // Worker-safe base64
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in workers
  return btoa(bin);
}

function buildPdf({ content, title }: AttachmentInput): string {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 56;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  const ensure = (h: number) => {
    if (y + h > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  if (title) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(11, 37, 69);
    const t = doc.splitTextToSize(title, maxWidth);
    ensure(t.length * 22);
    doc.text(t, margin, y);
    y += t.length * 22 + 8;
    doc.setDrawColor(11, 110, 63);
    doc.setLineWidth(1.2);
    doc.line(margin, y, pageWidth - margin, y);
    y += 18;
  }

  const blocks = parseMarkdown(content);
  for (const b of blocks) {
    doc.setTextColor(15, 23, 42);
    if (b.kind === "h") {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(b.level === 1 ? 16 : b.level === 2 ? 14 : 12);
      doc.setTextColor(11, 37, 69);
      const lines = doc.splitTextToSize(b.text, maxWidth);
      ensure(lines.length * 18 + 6);
      doc.text(lines, margin, y);
      y += lines.length * 18 + 6;
    } else if (b.kind === "p") {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(b.text, maxWidth);
      ensure(lines.length * 15 + 8);
      doc.text(lines, margin, y);
      y += lines.length * 15 + 8;
    } else if (b.kind === "ul" || b.kind === "ol") {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      b.items.forEach((it, idx) => {
        const bullet = b.kind === "ul" ? "•" : `${idx + 1}.`;
        const lines = doc.splitTextToSize(it, maxWidth - 20);
        ensure(lines.length * 15 + 4);
        doc.text(bullet, margin, y);
        doc.text(lines, margin + 18, y);
        y += lines.length * 15 + 4;
      });
      y += 6;
    } else if (b.kind === "table") {
      ensure(40);
      autoTable(doc, {
        startY: y,
        head: [b.head],
        body: b.rows,
        margin: { left: margin, right: margin },
        styles: { fontSize: 10, cellPadding: 6, textColor: [15, 23, 42] },
        headStyles: { fillColor: [11, 37, 69], textColor: [255, 255, 255], fontStyle: "bold" },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        theme: "grid",
      });
      // @ts-expect-error lastAutoTable injected by plugin
      y = (doc.lastAutoTable?.finalY ?? y) + 12;
    }
  }

  // Footer page numbers
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 24, { align: "right" });
  }

  const ab = doc.output("arraybuffer") as ArrayBuffer;
  return bytesToBase64(new Uint8Array(ab));
}

/* ---------------- XLSX (table-only) ---------------- */

async function buildXlsx({ content, title }: AttachmentInput): Promise<string> {
  const XLSX = await import("xlsx");
  const blocks = parseMarkdown(content);
  const wb = XLSX.utils.book_new();
  const tables = blocks.filter((b): b is Extract<Block, { kind: "table" }> => b.kind === "table");
  if (tables.length === 0) {
    // Fall back: single column of text lines
    const rows = blocks.map((b) =>
      b.kind === "ul" || b.kind === "ol"
        ? b.items.join("; ")
        : b.kind === "h" || b.kind === "p"
          ? b.text
          : "",
    );
    const ws = XLSX.utils.aoa_to_sheet([[title ?? "Content"], ...rows.map((r) => [r])]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  } else {
    tables.forEach((t, idx) => {
      const ws = XLSX.utils.aoa_to_sheet([t.head, ...t.rows]);
      XLSX.utils.book_append_sheet(wb, ws, `Table ${idx + 1}`.slice(0, 31));
    });
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return bytesToBase64(new Uint8Array(out));
}

/* ---------------- DOCX ---------------- */

async function buildDocx({ content, title }: AttachmentInput): Promise<string> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } = docx;
  const blocks = parseMarkdown(content);
  const children: InstanceType<typeof Paragraph | typeof Table>[] = [];
  if (title) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, bold: true })] }));
  }
  for (const b of blocks) {
    if (b.kind === "h") {
      const level = b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: level, children: [new TextRun({ text: b.text, bold: true })] }));
    } else if (b.kind === "p") {
      children.push(new Paragraph({ children: [new TextRun(b.text)] }));
    } else if (b.kind === "ul" || b.kind === "ol") {
      b.items.forEach((it) =>
        children.push(new Paragraph({ text: it, bullet: b.kind === "ul" ? { level: 0 } : undefined, numbering: b.kind === "ol" ? { reference: "default-num", level: 0 } : undefined })),
      );
    } else if (b.kind === "table") {
      const rows = [
        new TableRow({ children: b.head.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })] })) }),
        ...b.rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) })),
      ];
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph(""));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  return bytesToBase64(new Uint8Array(buf));
}

export async function buildAttachment(input: AttachmentInput): Promise<BuiltAttachment> {
  const filename = ensureExt(input.filename, input.type);
  let base64: string;
  if (input.type === "pdf") base64 = buildPdf(input);
  else if (input.type === "xlsx") base64 = await buildXlsx(input);
  else base64 = await buildDocx(input);
  return { filename, mimeType: MIME[input.type], base64 };
}