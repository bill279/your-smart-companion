import { saveAs } from "file-saver";
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
} from "docx";
import * as XLSX from "xlsx";

export type ExportMessage = {
  role: string;
  content: string;
  created_at: string;
};

// --- Markdown table parsing ------------------------------------------------
function parseMarkdownTables(md: string): string[][][] {
  const tables: string[][][] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (
      header &&
      sep &&
      /\|/.test(header) &&
      /^\s*\|?\s*:?-{2,}/.test(sep.trim())
    ) {
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
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function fileBase(title: string) {
  return (title || "bpa-bot-chat").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60);
}

// --- PDF -------------------------------------------------------------------
export function exportToPdf(title: string, messages: ExportMessage[]) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(title || "BPA Bot conversation", margin, y);
  y += 24;

  doc.setFontSize(11);
  for (const m of messages) {
    const who = m.role === "user" ? "You" : "BPA Bot";
    const stamp = new Date(m.created_at).toLocaleString();
    doc.setFont("helvetica", "bold");
    const header = `${who} — ${stamp}`;
    if (y > pageHeight - margin - 24) {
      doc.addPage();
      y = margin;
    }
    doc.text(header, margin, y);
    y += 16;

    doc.setFont("helvetica", "normal");
    const text = stripMarkdown(m.content);
    const lines = doc.splitTextToSize(text, maxWidth);
    for (const line of lines) {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 14;
    }
    y += 10;
  }
  doc.save(`${fileBase(title)}.pdf`);
}

function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

// --- Word ------------------------------------------------------------------
export async function exportToDocx(title: string, messages: ExportMessage[]) {
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: title || "BPA Bot conversation", bold: true })],
    }),
  ];

  for (const m of messages) {
    const who = m.role === "user" ? "You" : "BPA Bot";
    const stamp = new Date(m.created_at).toLocaleString();
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: `${who} — ${stamp}`, bold: true })],
      }),
    );

    const tables = parseMarkdownTables(m.content);
    let body = m.content;
    if (tables.length > 0) {
      // Remove tables from body text so we don't duplicate them
      body = body.replace(/(^\s*\|.*\|\s*$\n?)+/gm, "");
    }

    for (const para of stripMarkdown(body).split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      for (const line of trimmed.split(/\n/)) {
        children.push(new Paragraph({ children: [new TextRun(line)] }));
      }
      children.push(new Paragraph({ children: [new TextRun("")] }));
    }

    for (const t of tables) {
      children.push(buildDocxTable(t));
      children.push(new Paragraph({ children: [new TextRun("")] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${fileBase(title)}.docx`);
}

function buildDocxTable(rows: string[][]): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  const borders = { top: border, bottom: border, left: border, right: border };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (r, idx) =>
        new TableRow({
          children: r.map(
            (cell) =>
              new TableCell({
                borders,
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: cell, bold: idx === 0 })],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}

// --- Excel -----------------------------------------------------------------
export function exportToXlsx(title: string, messages: ExportMessage[]) {
  const wb = XLSX.utils.book_new();

  const convo = [["Role", "Timestamp", "Message"]];
  for (const m of messages) {
    convo.push([
      m.role === "user" ? "You" : "BPA Bot",
      new Date(m.created_at).toLocaleString(),
      stripMarkdown(m.content),
    ]);
  }
  const wsConvo = XLSX.utils.aoa_to_sheet(convo);
  wsConvo["!cols"] = [{ wch: 10 }, { wch: 22 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, wsConvo, "Conversation");

  let tableIdx = 1;
  for (const m of messages) {
    const tables = parseMarkdownTables(m.content);
    for (const t of tables) {
      const ws = XLSX.utils.aoa_to_sheet(t);
      XLSX.utils.book_append_sheet(wb, ws, `Table ${tableIdx++}`.slice(0, 31));
    }
  }

  XLSX.writeFile(wb, `${fileBase(title)}.xlsx`);
}

// --- CSV (handy for the largest table) -------------------------------------
export function exportToCsv(title: string, messages: ExportMessage[]) {
  const allTables = messages.flatMap((m) => parseMarkdownTables(m.content));
  if (allTables.length === 0) {
    // Fall back to conversation CSV
    const rows = [["Role", "Timestamp", "Message"], ...messages.map((m) => [
      m.role === "user" ? "You" : "BPA Bot",
      new Date(m.created_at).toLocaleString(),
      stripMarkdown(m.content),
    ])];
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    saveAs(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${fileBase(title)}.csv`);
    return;
  }
  const biggest = allTables.sort((a, b) => b.length - a.length)[0];
  const csv = biggest.map((r) => r.map(csvCell).join(",")).join("\n");
  saveAs(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${fileBase(title)}-table.csv`);
}

function csvCell(v: string): string {
  const s = (v ?? "").toString();
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}