import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
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
  AlignmentType,
} from "docx";
import * as XLSX from "xlsx";

export type ChatMsg = { role: string; content: string; created_at: string };

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Markdown helpers ----------

type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "code"; text: string };

function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");
}

function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // code fence
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: "h", level: h[1].length, text: stripInline(h[2]) });
      i++;
      continue;
    }
    // table
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      const splitRow = (l: string) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => stripInline(c.trim()));
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    // lists
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(stripInline(lines[i].replace(/^\s*[-*+]\s+/, "")));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(stripInline(lines[i].replace(/^\s*\d+\.\s+/, "")));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    // paragraph (accumulate consecutive non-empty lines)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*\|.+\|\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: stripInline(buf.join(" ")) });
  }
  return blocks;
}

function buildChatMarkdown(title: string, messages: ChatMsg[]): string {
  const out: string[] = [`# ${title}`, ""];
  for (const m of messages) {
    out.push(`## ${m.role === "user" ? "You" : "BPA Bot"} — ${new Date(m.created_at).toLocaleString()}`);
    out.push("");
    out.push(m.content);
    out.push("");
  }
  return out.join("\n");
}

// ---------- PDF ----------

export function exportChatToPdf(title: string, messages: ChatMsg[], filename: string) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 48;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensure = (need: number) => {
    if (y + need > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeWrapped = (text: string, size: number, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, maxW) as string[];
    for (const ln of lines) {
      ensure(size * 1.3);
      doc.text(ln, margin, y);
      y += size * 1.3;
    }
  };

  // Title
  writeWrapped(title, 18, true);
  y += 6;

  const md = buildChatMarkdown(title, messages).split("\n").slice(2).join("\n"); // skip dup title
  const blocks = parseMarkdown(md);

  for (const b of blocks) {
    if (b.type === "h") {
      y += 6;
      writeWrapped(b.text, b.level === 1 ? 16 : b.level === 2 ? 13 : 12, true);
      y += 2;
    } else if (b.type === "p") {
      writeWrapped(b.text, 11);
      y += 4;
    } else if (b.type === "ul" || b.type === "ol") {
      for (let idx = 0; idx < b.items.length; idx++) {
        const prefix = b.type === "ul" ? "•  " : `${idx + 1}. `;
        writeWrapped(prefix + b.items[idx], 11);
      }
      y += 4;
    } else if (b.type === "code") {
      doc.setFont("courier", "normal");
      doc.setFontSize(10);
      const lines = doc.splitTextToSize(b.text, maxW) as string[];
      for (const ln of lines) {
        ensure(12);
        doc.text(ln, margin, y);
        y += 12;
      }
      y += 4;
    } else if (b.type === "table") {
      ensure(40);
      autoTable(doc, {
        startY: y,
        head: [b.header],
        body: b.rows,
        styles: { font: "helvetica", fontSize: 10, cellPadding: 5 },
        headStyles: { fillColor: [30, 58, 90], textColor: 255 },
        margin: { left: margin, right: margin },
        theme: "grid",
      });
      // @ts-expect-error autotable adds lastAutoTable
      y = doc.lastAutoTable.finalY + 10;
    }
  }

  triggerDownload(doc.output("blob"), filename);
}

// ---------- DOCX ----------

export async function exportChatToDocx(title: string, messages: ChatMsg[], filename: string) {
  const md = buildChatMarkdown(title, messages);
  const blocks = parseMarkdown(md);
  const children: (Paragraph | Table)[] = [];

  const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  const cellBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  for (const b of blocks) {
    if (b.type === "h") {
      const lvl =
        b.level === 1
          ? HeadingLevel.HEADING_1
          : b.level === 2
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: lvl, children: [new TextRun({ text: b.text, bold: true })] }));
    } else if (b.type === "p") {
      children.push(new Paragraph({ children: [new TextRun(b.text)] }));
    } else if (b.type === "ul") {
      for (const it of b.items) {
        children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(it)] }));
      }
    } else if (b.type === "ol") {
      for (const it of b.items) {
        children.push(new Paragraph({ children: [new TextRun(`• ${it}`)] }));
      }
    } else if (b.type === "code") {
      for (const ln of b.text.split("\n")) {
        children.push(new Paragraph({ children: [new TextRun({ text: ln, font: "Courier New", size: 20 })] }));
      }
    } else if (b.type === "table") {
      const colCount = Math.max(b.header.length, ...b.rows.map((r) => r.length));
      const colW = Math.floor(9360 / colCount);
      const widths = Array.from({ length: colCount }, () => colW);
      const mkCell = (text: string, head: boolean) =>
        new TableCell({
          borders: cellBorders,
          width: { size: colW, type: WidthType.DXA },
          shading: head ? { fill: "1E3A5A", type: "clear", color: "auto" } : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text, bold: head, color: head ? "FFFFFF" : undefined })],
            }),
          ],
        });
      const headerRow = new TableRow({
        tableHeader: true,
        children: b.header.concat(Array(colCount - b.header.length).fill("")).map((c) => mkCell(c, true)),
      });
      const bodyRows = b.rows.map(
        (r) =>
          new TableRow({
            children: r.concat(Array(colCount - r.length).fill("")).map((c) => mkCell(c, false)),
          })
      );
      children.push(
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: widths,
          rows: [headerRow, ...bodyRows],
        })
      );
      children.push(new Paragraph({ children: [new TextRun("")] }));
    }
  }

  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
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

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, filename);
}

// ---------- XLSX ----------

export function exportChatToXlsx(title: string, messages: ChatMsg[], filename: string) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: transcript
  const transcript = messages.map((m) => ({
    Time: new Date(m.created_at).toLocaleString(),
    Role: m.role === "user" ? "You" : "BPA Bot",
    Message: stripInline(m.content),
  }));
  const ws1 = XLSX.utils.json_to_sheet(
    transcript.length ? transcript : [{ Time: "", Role: "", Message: "(empty)" }]
  );
  ws1["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Transcript");

  // Additional sheets: one per markdown table found in assistant messages
  let tIdx = 1;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const blocks = parseMarkdown(m.content);
    for (const b of blocks) {
      if (b.type !== "table") continue;
      const aoa = [b.header, ...b.rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = b.header.map(() => ({ wch: 22 }));
      const name = `Table ${tIdx++}`.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
  }

  const ab = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([ab], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(blob, filename);
  // suppress unused-title lint
  void title;
}