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
} from "docx";
import * as XLSX from "xlsx";

export type DocFormat = "pdf" | "docx" | "xlsx" | "csv" | "txt" | "md";

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

export async function generateDocument(opts: {
  format: DocFormat;
  title: string;
  markdown: string;
}): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const { format, title, markdown } = opts;

  if (format === "txt") {
    const bytes = new TextEncoder().encode(stripMarkdown(markdown));
    return { bytes, mimeType: "text/plain", extension: "txt" };
  }

  if (format === "md") {
    const header = `# ${title}\n\n_Generated ${new Date().toISOString().slice(0, 10)}_\n\n`;
    const bytes = new TextEncoder().encode(header + markdown);
    return { bytes, mimeType: "text/markdown", extension: "md" };
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
    const tables = parseMarkdownTables(markdown);
    const children: (Paragraph | Table)[] = [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }),
    ];
    const tableSet = new Set(tables.flat().map((r) => r.join("|")));
    const lines = markdown.split(/\r?\n/);
    let inTable = false;
    for (const line of lines) {
      if (/^\s*\|/.test(line) || /^\s*\|?\s*:?-{2,}/.test(line.trim())) {
        inTable = true;
        continue;
      }
      if (inTable && line.trim() === "") {
        inTable = false;
        continue;
      }
      if (!line.trim()) {
        children.push(new Paragraph({ children: [new TextRun("")] }));
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
        children.push(new Paragraph({ heading, children: [new TextRun(m[2])] }));
      } else {
        children.push(new Paragraph({ children: [new TextRun(stripMarkdown(line))] }));
      }
    }
    for (const t of tables) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: t.map(
            (row) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun(cell)] })],
                    }),
                ),
              }),
          ),
        }),
      );
    }
    // suppress unused
    void tableSet;
    const doc = new Document({ sections: [{ children }] });
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

// ---------------- PDF rendering ----------------

function renderPdf(title: string, markdown: string): ArrayBuffer {
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
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
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(22);
  pdf.setTextColor(...brand);
  const titleLines = pdf.splitTextToSize(title, contentWidth) as string[];
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
    pdf.setFontSize(10);

    const rowHeights = rows.map((row, idx) => {
      pdf.setFont("helvetica", idx === 0 ? "bold" : "normal");
      let max = 0;
      for (let c = 0; c < cols; c++) {
        const cell = stripInline(row[c] ?? "");
        const wrapped = pdf.splitTextToSize(cell, colWidth - 12) as string[];
        max = Math.max(max, wrapped.length * 13 + 10);
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
      pdf.setTextColor(r === 0 ? brand[0] : 30, r === 0 ? brand[1] : 30, r === 0 ? brand[2] : 30);
      for (let c = 0; c < cols; c++) {
        const cell = stripInline(rows[r][c] ?? "");
        const wrapped = pdf.splitTextToSize(cell, colWidth - 12) as string[];
        const x = margin + colWidth * c + 6;
        let ty = y + 12;
        for (const l of wrapped) {
          pdf.text(l, x, ty);
          ty += 13;
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