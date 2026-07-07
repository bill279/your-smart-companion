import { getMicrosoftAccessToken } from "@/lib/ms-graph.server";

type CalendarError = {
  error: string;
  detail?: string;
  status?: number;
  provider: "outlook";
};

type GraphEvent = {
  id?: string;
  subject?: string;
  webLink?: string;
  onlineMeetingUrl?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { address?: string; name?: string }; status?: { response?: string; time?: string } }>;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  responseStatus?: { response?: string; time?: string };
  isOrganizer?: boolean;
};

type EventCreateInput = {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timezone?: string;
  online_meeting?: boolean;
};

const EVENT_SELECT = "id,subject,webLink,onlineMeeting,onlineMeetingUrl,isOnlineMeeting,onlineMeetingProvider,start,end,location,attendees,organizer,responseStatus,isOrganizer";

function cleanAttendees(attendees?: string[]) {
  return Array.from(
    new Set(
      (attendees ?? [])
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function teamsJoinUrl(event: GraphEvent) {
  return event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? undefined;
}

function htmlWithTeamsLink(description: string | undefined, joinUrl: string) {
  const intro = description?.trim() ? `<div>${description}</div><br>` : "";
  return `${intro}<div><strong>Microsoft Teams meeting</strong><br><a href="${joinUrl}">Join the meeting</a></div>`;
}

async function createStandaloneTeamsMeeting(userId: string, input: EventCreateInput, attendees: string[]) {
  const startDateTime = new Date(input.start);
  const endDateTime = new Date(input.end);
  if (Number.isNaN(startDateTime.getTime()) || Number.isNaN(endDateTime.getTime())) return undefined;

  const response = await graphFetch(userId, "/me/onlineMeetings", {
    method: "POST",
    body: JSON.stringify({
      subject: input.title,
      startDateTime: startDateTime.toISOString(),
      endDateTime: endDateTime.toISOString(),
      ...(attendees.length
        ? {
            participants: {
              attendees: attendees.map((email) => ({ upn: email, role: "attendee" })),
            },
          }
        : {}),
    }),
  });
  if (!response) return { error: { error: "Microsoft is not connected. Open Activity & memory and click Connect Microsoft.", provider: "outlook" as const } };
  if (!response.ok) return { error: await providerError(response, "Teams meeting create") };
  const meeting = (await response.json().catch(() => ({}))) as { joinWebUrl?: string };
  return { joinUrl: meeting.joinWebUrl };
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphFetch(userId: string, graphPath: string, init: RequestInit = {}) {
  const ms = await getMicrosoftAccessToken(userId);
  if (!ms) return null;
  const { headers, ...rest } = init;
  return fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${ms.accessToken}`,
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
  });
}

async function providerError(response: Response, action: string): Promise<CalendarError> {
  const detail = await response.text().catch(() => "");
  const common = {
    provider: "outlook" as const,
    status: response.status,
    detail: detail.slice(0, 1000),
  };
  if (response.status === 403) {
    return {
      ...common,
      error: `${action} failed (403). Reconnect Microsoft from Activity & memory and make sure the Entra app has Calendars.ReadWrite and OnlineMeetings.ReadWrite consented.`,
    };
  }
  return { ...common, error: `${action} failed (${response.status})` };
}

function serializeEvent(e: GraphEvent) {
  return {
    id: e.id,
    title: e.subject ?? "(no title)",
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    timezone: e.start?.timeZone,
    location: e.location?.displayName,
    link: e.webLink,
    teams_join_url: teamsJoinUrl(e),
    is_online_meeting: !!e.isOnlineMeeting,
    online_meeting_provider: e.onlineMeetingProvider,
    organizer: e.organizer?.emailAddress?.address,
    is_organizer: e.isOrganizer,
    response_status: e.responseStatus?.response,
    attendees: (e.attendees ?? [])
      .map((a) => ({
        email: a.emailAddress?.address,
        name: a.emailAddress?.name,
        response: a.status?.response,
      }))
      .filter((a) => !!a.email),
  };
}

export async function listMicrosoftCalendarEvents(
  userId: string,
  input: { days?: number; max_results?: number; start?: string; end?: string },
) {
  const start = input.start ? new Date(input.start) : new Date();
  const end = input.end ? new Date(input.end) : new Date(start.getTime() + (input.days ?? 7) * 86_400_000);
  const params = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    $orderby: "start/dateTime",
    $top: String(Math.min(input.max_results ?? 10, 50)),
    $select: EVENT_SELECT,
  });
  const response = await graphFetch(userId, `/me/calendarView?${params}`, { method: "GET" });
  if (!response) return { error: "Microsoft is not connected. Open Activity & memory and click Connect Microsoft.", provider: "outlook" as const };
  if (!response.ok) return providerError(response, "Outlook calendar read");
  const json = (await response.json()) as { value?: GraphEvent[] };
  return { provider: "outlook" as const, events: (json.value ?? []).map(serializeEvent) };
}

export async function createMicrosoftCalendarEvent(userId: string, input: EventCreateInput) {
  const attendees = cleanAttendees(input.attendees);
  const timezone = input.timezone ?? "America/Edmonton";
  const wantsTeams = input.online_meeting ?? true;
  const precreatedTeams = wantsTeams
    ? await createStandaloneTeamsMeeting(userId, input, attendees).catch((e) => ({
        error: { error: "Teams meeting create failed", detail: e instanceof Error ? e.message : String(e), provider: "outlook" as const },
      }))
    : undefined;
  const precreatedTeamsJoinUrl = precreatedTeams && "joinUrl" in precreatedTeams ? precreatedTeams.joinUrl : undefined;
  const attendeePayload = attendees.map((email) => ({
    emailAddress: { address: email },
    type: "required",
  }));
  const delayAttendeesUntilTeamsLink = wantsTeams && attendees.length > 0 && !precreatedTeamsJoinUrl;
  const body = {
    subject: input.title,
    ...(precreatedTeamsJoinUrl
      ? { body: { contentType: "HTML", content: htmlWithTeamsLink(input.description, precreatedTeamsJoinUrl) } }
      : input.description
        ? { body: { contentType: "HTML", content: input.description } }
        : {}),
    start: { dateTime: input.start, timeZone: timezone },
    end: { dateTime: input.end, timeZone: timezone },
    responseRequested: true,
    allowNewTimeProposals: true,
    ...(precreatedTeamsJoinUrl
      ? { location: { displayName: "Microsoft Teams Meeting" } }
      : input.location
        ? { location: { displayName: input.location } }
        : {}),
    ...(!delayAttendeesUntilTeamsLink && attendeePayload.length
      ? {
          attendees: attendeePayload,
        }
      : {}),
    ...(wantsTeams ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };

  const response = await graphFetch(userId, "/me/events", {
    method: "POST",
    headers: { Prefer: `outlook.timezone="${timezone}"` },
    body: JSON.stringify(body),
  });
  if (!response) return { error: "Microsoft is not connected. Open Activity & memory and click Connect Microsoft.", provider: "outlook" as const };
  if (!response.ok) return providerError(response, "Outlook calendar create");

  let event = (await response.json()) as GraphEvent;
  let joinUrl = teamsJoinUrl(event) ?? precreatedTeamsJoinUrl;
  let joinUrlSource: "event" | "onlineMeeting" | undefined = teamsJoinUrl(event) ? "event" : precreatedTeamsJoinUrl ? "onlineMeeting" : undefined;

  const createdEventId = event.id;
  if (wantsTeams && createdEventId && (!teamsJoinUrl(event) || !joinUrl)) {
    for (let attempt = 0; attempt < 3 && !teamsJoinUrl(event); attempt += 1) {
      await wait(attempt === 0 ? 500 : 900);
      if (attempt === 2) {
        await graphFetch(userId, `/me/events/${encodeURIComponent(createdEventId)}`, {
          method: "PATCH",
          body: JSON.stringify({ isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }),
        }).catch(() => undefined);
      }
      const fresh = await graphFetch(
        userId,
        `/me/events/${encodeURIComponent(createdEventId)}?$select=${encodeURIComponent(EVENT_SELECT)}`,
        { method: "GET", headers: { Prefer: `outlook.timezone="${timezone}"` } },
      );
      if (fresh?.ok) {
        event = (await fresh.json()) as GraphEvent;
        const eventJoinUrl = teamsJoinUrl(event);
        if (eventJoinUrl) {
          joinUrl = eventJoinUrl;
          joinUrlSource = "event";
        }
      }
    }
  }

  if (wantsTeams && !joinUrl) {
    const standalone = await createStandaloneTeamsMeeting(userId, input, attendees).catch(() => undefined);
    if (standalone && "joinUrl" in standalone && standalone.joinUrl) {
      joinUrl = standalone.joinUrl;
      joinUrlSource = "onlineMeeting";
    }
  }

  if (wantsTeams && !joinUrl) {
    if (event.id) {
      await graphFetch(userId, `/me/events/${encodeURIComponent(event.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    const precreateError = precreatedTeams && "error" in precreatedTeams ? precreatedTeams.error : undefined;
    return {
      error:
        "I did not send the calendar invite because Microsoft did not return a Teams join link. Reconnect Microsoft from Activity & memory and approve OnlineMeetings.ReadWrite, then try again.",
      detail: precreateError?.detail,
      status: precreateError && "status" in precreateError ? precreateError.status : undefined,
      provider: "outlook" as const,
    };
  }

  const eventId = event.id;
  if (eventId && joinUrl) {
    const patchResponse = await graphFetch(userId, `/me/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        body: { contentType: "HTML", content: htmlWithTeamsLink(input.description, joinUrl) },
        location: { displayName: "Microsoft Teams Meeting" },
        ...(delayAttendeesUntilTeamsLink && attendeePayload.length ? { attendees: attendeePayload } : {}),
      }),
    }).catch(() => undefined);
    if (delayAttendeesUntilTeamsLink && patchResponse && !patchResponse.ok) {
      await graphFetch(userId, `/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }).catch(() => undefined);
      return providerError(patchResponse, "Outlook calendar invite send");
    }
  }

  return {
    ok: true,
    provider: "outlook" as const,
    id: eventId,
    link: event.webLink,
    invite_sent: attendees.length > 0,
    calendar_invite_sent: attendees.length > 0,
    attendees,
    ...(joinUrl ? { teams_join_url: joinUrl } : {}),
    ...(joinUrlSource ? { teams_join_url_source: joinUrlSource } : {}),
  };
}

export async function cancelMicrosoftCalendarEvent(userId: string, input: { event_id: string; comment?: string }) {
  const response = await graphFetch(userId, `/me/events/${encodeURIComponent(input.event_id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ comment: input.comment ?? "Canceled by BPA Bot." }),
  });
  if (!response) return { error: "Microsoft is not connected. Open Activity & memory and click Connect Microsoft.", provider: "outlook" as const };
  if (response.ok) return { ok: true, provider: "outlook" as const, id: input.event_id, canceled: true, cancellation_sent: true };

  if (response.status === 400 || response.status === 404 || response.status === 405) {
    const fallback = await graphFetch(userId, `/me/events/${encodeURIComponent(input.event_id)}`, { method: "DELETE" });
    if (fallback?.ok) return { ok: true, provider: "outlook" as const, id: input.event_id, canceled: true, cancellation_sent: false };
    if (fallback) return providerError(fallback, "Outlook calendar delete");
  }
  return providerError(response, "Outlook calendar cancel");
}

export async function respondToMicrosoftCalendarEvent(
  userId: string,
  input: { event_id: string; response: "accept" | "tentative" | "decline"; comment?: string; send_response?: boolean },
) {
  const action = input.response === "accept" ? "accept" : input.response === "tentative" ? "tentativelyAccept" : "decline";
  const response = await graphFetch(userId, `/me/events/${encodeURIComponent(input.event_id)}/${action}`, {
    method: "POST",
    body: JSON.stringify({
      comment: input.comment ?? "",
      sendResponse: input.send_response ?? true,
    }),
  });
  if (!response) return { error: "Microsoft is not connected. Open Activity & memory and click Connect Microsoft.", provider: "outlook" as const };
  if (!response.ok) return providerError(response, "Outlook meeting response");
  return { ok: true, provider: "outlook" as const, id: input.event_id, response: input.response, response_sent: input.send_response ?? true };
}