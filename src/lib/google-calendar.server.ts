type GoogleEventInput = {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timezone?: string;
  online_meeting?: boolean;
};

const GATEWAY = "https://connector-gateway.lovable.dev/google_calendar/calendar/v3";

function cleanAttendees(list?: string[]) {
  return Array.from(new Set((list ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)));
}

function gatewayHeaders() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const gcalKey = process.env.GOOGLE_CALENDAR_API_KEY;
  if (!lovableKey || !gcalKey) return null;
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": gcalKey,
    "Content-Type": "application/json",
  } as Record<string, string>;
}

export function isGoogleCalendarAvailable() {
  return !!process.env.GOOGLE_CALENDAR_API_KEY && !!process.env.LOVABLE_API_KEY;
}

export async function createGoogleCalendarEvent(input: GoogleEventInput) {
  const headers = gatewayHeaders();
  if (!headers) {
    return { error: "Google Calendar connector is not linked.", provider: "google" as const };
  }
  const attendees = cleanAttendees(input.attendees);
  const timezone = input.timezone ?? "America/Edmonton";
  const wantsMeet = input.online_meeting ?? true;
  const body: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: input.start, timeZone: timezone },
    end: { dateTime: input.end, timeZone: timezone },
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
    ...(wantsMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: `bpa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {}),
  };
  const params = new URLSearchParams({
    sendUpdates: attendees.length ? "all" : "none",
    conferenceDataVersion: wantsMeet ? "1" : "0",
  });
  const response = await fetch(`${GATEWAY}/calendars/primary/events?${params}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      error: `Google Calendar create failed (${response.status})`,
      status: response.status,
      detail: detail.slice(0, 1000),
      provider: "google" as const,
    };
  }
  const event = (await response.json()) as {
    id?: string;
    htmlLink?: string;
    hangoutLink?: string;
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  };
  const meetUrl =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  return {
    ok: true,
    provider: "google" as const,
    id: event.id,
    link: event.htmlLink,
    invite_sent: attendees.length > 0,
    calendar_invite_sent: attendees.length > 0,
    attendees,
    ...(meetUrl ? { meet_join_url: meetUrl, teams_join_url: meetUrl } : {}),
  };
}