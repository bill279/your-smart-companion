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
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 54;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  let y = margin;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  const titleLines = pdf.splitTextToSize(title, pageWidth - margin * 2) as string[];
  for (const l of titleLines) {
    pdf.text(l, margin, y);
    y += 22;
  }
  y += 8;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(11);
  const body = stripMarkdown(markdown);
  const lines = pdf.splitTextToSize(body, pageWidth - margin * 2) as string[];
  for (const l of lines) {
    if (y > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
    pdf.text(l, margin, y);
    y += 15;
  }
  const ab = pdf.output("arraybuffer");
  return {
    bytes: new Uint8Array(ab),
    mimeType: "application/pdf",
    extension: "pdf",
  };
}