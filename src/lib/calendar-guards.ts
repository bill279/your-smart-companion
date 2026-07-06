const CALENDAR_INVITE_PATTERNS = [
  /BEGIN:VCALENDAR/i,
  /BEGIN:VEVENT/i,
  /METHOD:REQUEST/i,
  /DTSTART[:;]/i,
  /DTEND[:;]/i,
  /ATTENDEE[:;]/i,
  /ORGANIZER[:;]/i,
  /\bcalendar\s+invite\b/i,
  /\bmeeting\s+invite\b/i,
  /\boutlook\s+invite\b/i,
  /\bteams\s+meeting\b/i,
  /\bmicrosoft\s+teams\s+meeting\b/i,
  /please\s+accept\s+or\s+decline/i,
  /\[insert\s+teams\s+link\s+here\]/i,
];

export function looksLikeCalendarInviteText(value: string) {
  return CALENDAR_INVITE_PATTERNS.some((pattern) => pattern.test(value));
}