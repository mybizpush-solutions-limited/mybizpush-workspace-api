import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";
import { encryptSecret } from "./crypto";
import { GoogleAccount } from "../models";

// Employees only connect Google so we can capture the Gmail they actually join
// meetings with — identity scopes only, no sensitive Calendar access. The
// calendar.events scope is held solely by the central organizer account (its
// refresh token is configured via env, minted separately).
export const GOOGLE_SCOPES = ["openid", "email"];

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function assertConfigured() {
  if (!isGoogleConfigured()) {
    throw new AppError(503, "Google integration is not configured", "google_unconfigured");
  }
}

function oauthClient(): OAuth2Client {
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

export function getAuthUrl(state: string, opts: { gmail?: boolean } = {}): string {
  assertConfigured();
  return oauthClient().generateAuthUrl({
    access_type: "offline", // request a refresh token
    prompt: "consent",
    scope: opts.gmail ? [...GOOGLE_SCOPES, ...GMAIL_SCOPES] : GOOGLE_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

// Exchange the auth code for tokens and persist them for the user.
export async function exchangeCodeAndStore(userId: string, code: string, opts: { gmail?: boolean } = {}): Promise<void> {
  assertConfigured();
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Look up the connected Google email for display (best-effort).
  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email ?? null;
  } catch {
    /* non-fatal */
  }

  const existing = await GoogleAccount.findByPk(userId);
  const refresh = tokens.refresh_token ?? null;
  await GoogleAccount.upsert({
    userId,
    // Mailbox access is stored apart from the identity link, encrypted, so it can
    // be dropped alone. Without a new token Google has kept the earlier grant.
    ...(opts.gmail
      ? {
          gmailRefreshToken: refresh ? encryptSecret(refresh) : (existing?.gmailRefreshToken ?? null),
          gmailEmail: email,
          gmailScopes: tokens.scope ?? null,
        }
      : {}),
    email,
    accessToken: tokens.access_token ?? null,
    // Google only returns a refresh token on first consent — keep the old one.
    refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
    scope: tokens.scope ?? null,
    tokenType: tokens.token_type ?? null,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  });
}

// Whether a central organizer account is configured for meetings.
export function isMeetOrganizerConfigured(): boolean {
  return isGoogleConfigured() && Boolean(env.GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN);
}

// Create the Meet event on the CENTRAL organizer account (e.g. mybizpush@gmail.com)
// using its configured refresh token, inviting every attendee by email. Returns
// null if no organizer account is configured.
export async function createMeetEventAsOrganizer(input: {
  summary: string;
  description?: string;
  attendees: string[];
  startIso: string;
  endIso: string;
  recurrence?: string | null; // an RRULE line, e.g. "RRULE:FREQ=WEEKLY;INTERVAL=2"
  conference?: boolean; // false: a plain calendar event with no Meet link
  location?: string;
  eventId?: string; // chosen by us, so a retry can't create a second event
}): Promise<{ meetUrl: string; eventId: string } | null> {
  if (!isMeetOrganizerConfigured()) return null;

  const client = oauthClient();
  client.setCredentials({ refresh_token: env.GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN });

  const calendar = google.calendar({ version: "v3", auth: client });
  const conference = input.conference !== false;
  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      ...(input.eventId ? { id: input.eventId } : {}),
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
      attendees: input.attendees.map((email) => ({ email })),
      ...(input.recurrence ? { recurrence: [input.recurrence] } : {}),
      ...(conference
        ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
        : {}),
    },
  });
  if (!conference) return res.data.id ? { meetUrl: "", eventId: res.data.id } : null;

  const meetUrl =
    res.data.hangoutLink ??
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null;
  if (!meetUrl || !res.data.id) return null;
  return { meetUrl, eventId: res.data.id };
}

// Update an existing organizer-owned event (title, time, attendee invites).
export async function updateMeetEventAsOrganizer(
  eventId: string,
  input: {
    summary: string;
    description?: string;
    attendees: string[];
    startIso: string;
    endIso: string;
    recurrence?: string | null;
    location?: string;
  },
): Promise<void> {
  if (!isMeetOrganizerConfigured()) return;
  const client = oauthClient();
  client.setCredentials({ refresh_token: env.GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN });
  const calendar = google.calendar({ version: "v3", auth: client });
  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
      attendees: input.attendees.map((email) => ({ email })),
      // Pass [] to clear recurrence (make it one-off) when not provided.
      recurrence: input.recurrence ? [input.recurrence] : [],
    },
  });
}

// Cancel (delete) an organizer-owned event; attendees are notified.
export async function deleteMeetEventAsOrganizer(eventId: string): Promise<void> {
  if (!isMeetOrganizerConfigured()) return;
  const client = oauthClient();
  client.setCredentials({ refresh_token: env.GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN });
  const calendar = google.calendar({ version: "v3", auth: client });
  await calendar.events.delete({ calendarId: "primary", eventId, sendUpdates: "all" });
}

// Reads one event from the organizer calendar. Null when it no longer exists.
export async function getMeetEventAsOrganizer(eventId: string): Promise<{ title: string; startsAt: string; endsAt: string; cancelled: boolean } | null> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: env.GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN });
  const calendar = google.calendar({ version: "v3", auth: client });
  try {
    const { data } = await calendar.events.get({ calendarId: "primary", eventId });
    return {
      title: data.summary ?? "",
      startsAt: data.start?.dateTime ?? data.start?.date ?? "",
      endsAt: data.end?.dateTime ?? data.end?.date ?? "",
      cancelled: data.status === "cancelled",
    };
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } }).response?.status ?? (err as { code?: number }).code;
    if (status === 404 || status === 410) return null;
    throw err;
  }
}

// Everything meetings do on the organizer calendar, in one replaceable place.
export const calendarOps = {
  isConfigured: isMeetOrganizerConfigured,
  create: createMeetEventAsOrganizer,
  update: updateMeetEventAsOrganizer,
  remove: deleteMeetEventAsOrganizer,
  get: getMeetEventAsOrganizer,
};
