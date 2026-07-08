import jsPDF from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  PageOrientation,
  LevelFormat,
  AlignmentType,
} from "docx";
import * as XLSX from "xlsx";

export type DocFormat = "pdf" | "docx" | "xlsx" | "csv" | "txt";

function parseMarkdownTables(md: string): string[][][] {
  const tables: string[][][] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (header && sep && /\|/.test(header) && /^\s*\|?\s*:?-{2,}/.test(sep.trim())) {
      const rows: string[][] = [splitRow(header)];
      let j = i + 2;
      while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]));
        j++;
      }
      tables.push(rows);
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// Turn a possibly filename-like title ("stereoscopic_cameras_for_mining.pdf")
// into a clean human title ("Stereoscopic Cameras For Mining").
function humanizeTitle(raw: string): string {
  let t = (raw ?? "").trim();
  // strip trailing extension if user passed one
  t = t.replace(/\.(pdf|docx|xlsx|csv|txt)$/i, "");
  // replace separators with spaces
  t = t.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "Document";
  // if it's all lowercase, title-case it
  if (t === t.toLowerCase()) {
    t = t
      .split(" ")
      .map((w, i) =>
        i === 0 || w.length > 3 ? w.charAt(0).toUpperCase() + w.slice(1) : w,
      )
      .join(" ");
  }
  return t;
}

function looksLikeConversationalNoise(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (t.length > 90) return true;
  if (/^(?:no|nah|yeah|yes|yep|okay|ok|sure|fine|cool|great|perfect|thanks?|thank you|that'?s fine|go ahead|send it|do it)\b/i.test(t)) return true;
  if (/\b(?:i want you to|go with|probably|that'?s fine|no,? that'?s fine|use of a camera)\b/i.test(t)) return true;
  return false;
}

function cleanDocumentTitle(raw: string, markdown: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const h2 = markdown.match(/^##\s+(.+)$/m)?.[1]?.trim();
  const candidate = !looksLikeConversationalNoise(raw) ? raw : !looksLikeConversationalNoise(h1 ?? "") ? h1 : h2;
  return humanizeTitle(candidate || "Generated Document").slice(0, 120);
}

function normalizeDocumentMarkdown(title: string, markdown: string): string {
  let md = (markdown ?? "").trim();
  if (!md) return `# ${title}\n`;
  const firstH1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (firstH1 && looksLikeConversationalNoise(firstH1)) {
    md = md.replace(/^#\s+.+\n?/, "").trim();
  }
  const paragraphs = md.split(/\n{2,}/);
  while (paragraphs.length > 1 && looksLikeConversationalNoise(stripMarkdown(paragraphs[0] ?? ""))) {
    paragraphs.shift();
  }
  md = paragraphs.join("\n\n").trim();
  return md || `# ${title}\n`;
}

// True if the markdown body already starts with an H1 — we should let the
// document's own heading own the title rather than stamping our own on top.
function markdownStartsWithH1(md: string): boolean {
  const firstLine = (md ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return !!firstLine && /^#\s+\S/.test(firstLine.trim());
}

export async function generateDocument(opts: {
  format: DocFormat;
  title: string;
  markdown: string;
}): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const format = opts.format;
  const title = cleanDocumentTitle(opts.title, opts.markdown);
  const markdown = normalizeDocumentMarkdown(title, opts.markdown);

  if (format === "txt") {
    const bytes = new TextEncoder().encode(stripMarkdown(markdown));
    return { bytes, mimeType: "text/plain", extension: "txt" };
  }

  if (format === "csv") {
    const tables = parseMarkdownTables(markdown);
    const rows = tables[0] ?? [[stripMarkdown(markdown)]];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    return {
      bytes: new TextEncoder().encode(csv),
      mimeType: "text/csv",
      extension: "csv",
    };
  }

  if (format === "xlsx") {
    const tables = parseMarkdownTables(markdown);
    const wb = XLSX.utils.book_new();
    if (tables.length === 0) {
      const ws = XLSX.utils.aoa_to_sheet([[title], [stripMarkdown(markdown)]]);
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    } else {
      tables.forEach((t, idx) => {
        const ws = XLSX.utils.aoa_to_sheet(t);
        XLSX.utils.book_append_sheet(wb, ws, `Sheet${idx + 1}`);
      });
    }
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    return {
      bytes: new Uint8Array(buf),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
    };
  }

  if (format === "docx") {
    const cleanTitle = humanizeTitle(title);
    const skipAutoTitle = markdownStartsWithH1(markdown);
    const children: (Paragraph | Table)[] = skipAutoTitle
      ? []
      : [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(cleanTitle)] })];
    const lines = markdown.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test((lines[i + 1] ?? "").trim())) {
        const rows: string[][] = [splitRow(line)];
        let j = i + 2;
        while (j < lines.length && /\|/.test(lines[j] ?? "") && (lines[j] ?? "").trim() !== "") {
          rows.push(splitRow(lines[j] ?? ""));
          j++;
        }
        children.push(buildDocxTable(rows));
        i = j;
        continue;
      }
      if (!line.trim()) {
        children.push(new Paragraph({ children: [new TextRun("")] }));
        i++;
        continue;
      }
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const lvl = m[1].length;
        const heading =
          lvl === 1
            ? HeadingLevel.HEADING_1
            : lvl === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_3;
        children.push(new Paragraph({ heading, spacing: { before: lvl <= 2 ? 240 : 160, after: 120 }, children: [new TextRun(stripMarkdown(m[2]))] }));
      } else if (/^[-*+]\s+/.test(line.trim())) {
        children.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 80 }, children: [new TextRun(stripMarkdown(line.trim().replace(/^[-*+]\s+/, "")))] }));
      } else if (/^\d+\.\s+/.test(line.trim())) {
        children.push(new Paragraph({ numbering: { reference: "numbers", level: 0 }, spacing: { after: 80 }, children: [new TextRun(stripMarkdown(line.trim().replace(/^\d+\.\s+/, "")))] }));
      } else {
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(stripMarkdown(line))] }));
      }
      i++;
    }
    void PageOrientation;
    const doc = new Document({
      styles: {
        default: { document: { run: { font: "Arial", size: 22 } } },
        paragraphStyles: [
          {
            id: "Heading1",
            name: "Heading 1",
            basedOn: "Normal",
            next: "Normal",
            quickFormat: true,
            run: { size: 32, bold: true, font: "Arial", color: "0B2545" },
            paragraph: { spacing: { before: 240, after: 180 }, outlineLevel: 0 },
          },
          {
            id: "Heading2",
            name: "Heading 2",
            basedOn: "Normal",
            next: "Normal",
            quickFormat: true,
            run: { size: 26, bold: true, font: "Arial", color: "0B2545" },
            paragraph: { spacing: { before: 220, after: 140 }, outlineLevel: 1 },
          },
          {
            id: "Heading3",
            name: "Heading 3",
            basedOn: "Normal",
            next: "Normal",
            quickFormat: true,
            run: { size: 23, bold: true, font: "Arial", color: "0B2545" },
            paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 2 },
          },
        ],
      },
      numbering: {
        config: [
          {
            reference: "bullets",
            levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
          },
          {
            reference: "numbers",
            levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
            },
          },
          children,
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    return {
      bytes: new Uint8Array(buf),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: "docx",
    };
  }

  // pdf
  const ab = renderPdf(title, markdown);
  return {
    bytes: new Uint8Array(ab),
    mimeType: "application/pdf",
    extension: "pdf",
  };
}

function buildDocxTable(rows: string[][]): Table {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const totalWidth = 9360;
  const baseColWidth = Math.floor(totalWidth / colCount);
  const columnWidths = Array.from({ length: colCount }, (_, idx) =>
    idx === colCount - 1 ? totalWidth - baseColWidth * (colCount - 1) : baseColWidth,
  );
  const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" };
  const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths,
    rows: rows.map(
      (row, rowIdx) =>
        new TableRow({
          tableHeader: rowIdx === 0,
          children: Array.from({ length: colCount }).map(
            (_, colIdx) =>
              new TableCell({
                borders: cellBorders,
                width: { size: columnWidths[colIdx], type: WidthType.DXA },
                margins: { top: 100, bottom: 100, left: 120, right: 120 },
                ...(rowIdx === 0
                  ? { shading: { fill: "DCEAF2", type: ShadingType.CLEAR, color: "auto" } }
                  : rowIdx % 2 === 0
                    ? { shading: { fill: "F8FAFC", type: ShadingType.CLEAR, color: "auto" } }
                    : {}),
                children: [
                  new Paragraph({
                    spacing: { before: 40, after: 40 },
                    children: [
                      new TextRun({
                        text: stripMarkdown(row[colIdx] ?? ""),
                        bold: rowIdx === 0,
                        color: "0F172A",
                      }),
                    ],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}

// ---------------- PDF rendering ----------------

function renderPdf(title: string, markdown: string): ArrayBuffer {
  // Consistency rule: always portrait unless a table genuinely can't fit at
  // a readable minimum column width (48pt/col). This stops the entire
  // document orientation from flipping just because the model happened to
  // emit a 7-column table.
  const tables = parseMarkdownTables(markdown);
  const maxCols = tables.reduce((m, t) => Math.max(m, ...t.map((r) => r.length)), 0);
  const needsLandscape = maxCols >= 8;
  const pdf = new jsPDF({ unit: "pt", format: "letter", orientation: needsLandscape ? "landscape" : "portrait" });
  const margin = 56;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  const brand: [number, number, number] = [13, 71, 99]; // BPA navy
  const muted: [number, number, number] = [110, 110, 110];
  const rule: [number, number, number] = [220, 224, 230];
  const headerBg: [number, number, number] = [240, 244, 248];

  let y = margin;
  let pageNum = 1;

  const drawFooter = () => {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(...muted);
    pdf.text(`Page ${pageNum}`, pageWidth - margin, pageHeight - 28, { align: "right" });
    pdf.text("BPA Bot — BP Automation", margin, pageHeight - 28);
    pdf.setDrawColor(...rule);
    pdf.setLineWidth(0.5);
    pdf.line(margin, pageHeight - 40, pageWidth - margin, pageHeight - 40);
    pdf.setTextColor(0, 0, 0);
  };

  const newPage = () => {
    drawFooter();
    pdf.addPage();
    pageNum += 1;
    y = margin;
  };

  const ensure = (h: number) => {
    if (y + h > pageHeight - margin - 24) newPage();
  };

  // ---- Title block ----
  const skipAutoTitle = markdownStartsWithH1(markdown);
  if (!skipAutoTitle) {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(22);
    pdf.setTextColor(...brand);
    const titleLines = pdf.splitTextToSize(humanizeTitle(title), contentWidth) as string[];
    for (const l of titleLines) {
      ensure(28);
      pdf.text(l, margin, y + 18);
      y += 26;
    }
    pdf.setDrawColor(...brand);
    pdf.setLineWidth(1.5);
    pdf.line(margin, y + 2, margin + 60, y + 2);
    y += 18;
    pdf.setTextColor(0, 0, 0);
  }

  // ---- Walk markdown ----
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw ?? "";
    const trimmed = line.trim();

    // Blank line → spacing
    if (!trimmed) {
      y += 6;
      i++;
      continue;
    }

    // Table?
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      const rows: string[][] = [splitRow(line)];
      let j = i + 2;
      while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]));
        j++;
      }
      drawTable(rows);
      i = j;
      continue;
    }

    // Heading
    const hm = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const lvl = hm[1].length;
      const sizes = [0, 18, 15, 13, 12, 11, 11];
      const size = sizes[lvl] ?? 12;
      y += lvl <= 2 ? 10 : 6;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(size);
      pdf.setTextColor(...brand);
      const hLines = pdf.splitTextToSize(stripInline(hm[2]), contentWidth) as string[];
      for (const l of hLines) {
        ensure(size + 6);
        pdf.text(l, margin, y + size);
        y += size + 4;
      }
      pdf.setTextColor(0, 0, 0);
      y += 4;
      i++;
      continue;
    }

    // Bullet
    const bm = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bm) {
      drawListItem("•", stripInline(bm[1]));
      i++;
      continue;
    }

    // Numbered
    const nm = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (nm) {
      drawListItem(`${nm[1]}.`, stripInline(nm[2]));
      i++;
      continue;
    }

    // Paragraph
    drawParagraph(stripInline(trimmed));
    i++;
  }

  drawFooter();
  return pdf.output("arraybuffer");

  function drawParagraph(text: string) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.setTextColor(30, 30, 30);
    const wrapped = pdf.splitTextToSize(text, contentWidth) as string[];
    for (const l of wrapped) {
      ensure(15);
      pdf.text(l, margin, y + 11);
      y += 15;
    }
    y += 4;
  }

  function drawListItem(bullet: string, text: string) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.setTextColor(30, 30, 30);
    const indent = 18;
    const wrapped = pdf.splitTextToSize(text, contentWidth - indent) as string[];
    ensure(15);
    pdf.text(bullet, margin, y + 11);
    for (let k = 0; k < wrapped.length; k++) {
      if (k > 0) ensure(15);
      pdf.text(wrapped[k], margin + indent, y + 11);
      y += 15;
    }
    y += 2;
  }

  function drawTable(rows: string[][]) {
    if (rows.length === 0) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const colWidth = contentWidth / cols;
    const tableFontSize = cols > 8 ? 7.5 : cols > 6 ? 8.5 : 10;
    const lineHeight = tableFontSize + 3;
    pdf.setFontSize(tableFontSize);

    const rowHeights = rows.map((row, idx) => {
      pdf.setFont("helvetica", idx === 0 ? "bold" : "normal");
      let max = 0;
      for (let c = 0; c < cols; c++) {
        const cell = stripInline(row[c] ?? "");
        const wrapped = pdf.splitTextToSize(cell, colWidth - 10) as string[];
        max = Math.max(max, wrapped.length * lineHeight + 10);
      }
      return max;
    });

    y += 4;
    for (let r = 0; r < rows.length; r++) {
      const h = rowHeights[r];
      if (y + h > pageHeight - margin - 24) newPage();

      // header fill
      if (r === 0) {
        pdf.setFillColor(...headerBg);
        pdf.rect(margin, y, contentWidth, h, "F");
      } else if (r % 2 === 0) {
        pdf.setFillColor(250, 251, 252);
        pdf.rect(margin, y, contentWidth, h, "F");
      }

      // borders
      pdf.setDrawColor(...rule);
      pdf.setLineWidth(0.5);
      pdf.rect(margin, y, contentWidth, h);
      for (let c = 1; c < cols; c++) {
        const x = margin + colWidth * c;
        pdf.line(x, y, x, y + h);
      }

      // text
      pdf.setFont("helvetica", r === 0 ? "bold" : "normal");
      pdf.setFontSize(tableFontSize);
      pdf.setTextColor(r === 0 ? brand[0] : 30, r === 0 ? brand[1] : 30, r === 0 ? brand[2] : 30);
      for (let c = 0; c < cols; c++) {
        const cell = stripInline(rows[r][c] ?? "");
        const wrapped = pdf.splitTextToSize(cell, colWidth - 10) as string[];
        const x = margin + colWidth * c + 6;
        let ty = y + tableFontSize + 3;
        for (const l of wrapped) {
          pdf.text(l, x, ty);
          ty += lineHeight;
        }
      }
      y += h;
    }
    pdf.setTextColor(0, 0, 0);
    y += 8;
  }
}

function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}