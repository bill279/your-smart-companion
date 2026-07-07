type CalendarMessage = { role: string; content: string };

export type DirectCalendarDraft = {
  title: string;
  start: string;
  end: string;
  timezone: string;
  attendees: string[];
  description?: string;
  missing: string[];
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const APPROVAL_RE = /^(?:yes|yep|yeah|confirm|confirmed|approved|approve|looks good|looks good looks good|send it|send|go ahead|do it|create it|schedule it|book it|proceed|finalize|yup|sure)\b/i;
const URGENCY_RE = /\b(?:hurry|are you done|actually doing it|just stalling|finalize|finish it)\b/i;

function cleanValue(value: string) {
  return value
    .replace(/[*_`]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function addDaysToDateString(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function zonedToday(now: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Fall through to UTC below.
  }
  return now.toISOString().slice(0, 10);
}

function extractTitle(text: string) {
  const patterns = [
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?Title(?:\*\*)?\s*[:|-]\s*([^\n]+)/i,
    /\b(?:call it|called|titled|title it)\s+["“]?([^"”\n.]+)["”]?/i,
    /\bmeeting titled\s+["“]?([^"”\n.]+)["”]?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[1];
    if (match) return cleanValue(match).slice(0, 200);
  }
  return "Meeting";
}

function extractDate(text: string, now: Date, timezone: string) {
  const explicit = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (explicit) return `${explicit[1]}-${pad(Number(explicit[2]))}-${pad(Number(explicit[3]))}`;
  const today = zonedToday(now, timezone);
  if (/\btomorrow\b/i.test(text)) return addDaysToDateString(today, 1);
  if (/\btoday\b/i.test(text)) return today;
  return undefined;
}

function extractTime(text: string) {
  const labelled = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?Time(?:\*\*)?\s*[:|-]\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?/i);
  const any = labelled ?? text.match(/\b(?:at|for)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i) ?? text.match(/\b(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (!any) return undefined;
  let hour = Number(any[1]);
  const minute = Number(any[2] ?? "0");
  const meridiem = String(any[3] ?? "").toLowerCase();
  if (meridiem.startsWith("p") && hour < 12) hour += 12;
  if (meridiem.startsWith("a") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}:00`;
}

function extractAttendees(text: string) {
  const emails = text.match(EMAIL_RE) ?? [];
  const names: string[] = [];
  const withMatch = text.match(/\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (withMatch?.[1] && !/tomorrow|today|meeting|calendar|teams/i.test(withMatch[1])) {
    names.push(withMatch[1]);
  }
  const attendeeLine = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?Attendees?(?:\*\*)?\s*[:|-]\s*([^\n]+)/i)?.[1];
  if (attendeeLine) {
    const beforeParen = attendeeLine.split("(")[0]?.trim();
    if (beforeParen && !EMAIL_RE.test(beforeParen)) names.push(beforeParen.replace(/^Bill\s*$/i, "Bill"));
  }
  return unique([...emails.map((email) => email.toLowerCase()), ...names]);
}

function localDateTime(date: string, time: string) {
  return `${date}T${time}`;
}

function addMinutesLocal(dateTime: string, minutes: number) {
  const [date, time] = dateTime.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes, second || 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

export function isCalendarApproval(text: string) {
  const normalized = text.trim();
  return APPROVAL_RE.test(normalized) || URGENCY_RE.test(normalized);
}

export function hasRecentCalendarDraft(messages: CalendarMessage[]) {
  return messages
    .slice(-16)
    .some((m) => /\b(calendar invite|meeting invite|teams|outlook|book|schedule|attendees?)\b/i.test(m.content));
}

export function buildCalendarDraftFromMessages(
  messages: CalendarMessage[],
  options: { now?: Date; timezone?: string } = {},
): DirectCalendarDraft {
  const timezone = options.timezone || "UTC";
  const now = options.now ?? new Date();
  const recent = messages.slice(-24);
  const text = recent.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  const title = extractTitle(text);
  const date = extractDate(text, now, timezone);
  const time = extractTime(text);
  const attendees = extractAttendees(text);
  const missing: string[] = [];
  if (!date) missing.push("date");
  if (!time) missing.push("time");
  const start = date && time ? localDateTime(date, time) : "";
  const end = start ? addMinutesLocal(start, 30) : "";
  return {
    title,
    start,
    end,
    timezone,
    attendees,
    description: `Created by BPA Bot.${attendees.length ? "" : " No attendees were provided."}`,
    missing,
  };
}

export function shouldAutoCreateCalendarEvent(text: string, messages: CalendarMessage[]) {
  return isCalendarApproval(text) && hasRecentCalendarDraft(messages);
}