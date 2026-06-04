import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";
import { GoogleAccount } from "../models";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
];

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

export function getAuthUrl(state: string): string {
  assertConfigured();
  return oauthClient().generateAuthUrl({
    access_type: "offline", // request a refresh token
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

// Exchange the auth code for tokens and persist them for the user.
export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
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
  await GoogleAccount.upsert({
    userId,
    email,
    accessToken: tokens.access_token ?? null,
    // Google only returns a refresh token on first consent — keep the old one.
    refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
    scope: tokens.scope ?? null,
    tokenType: tokens.token_type ?? null,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  });
}

// Build an OAuth client for a connected user, auto-refreshing + persisting tokens.
async function getAuthorizedClient(userId: string): Promise<OAuth2Client | null> {
  assertConfigured();
  const account = await GoogleAccount.findByPk(userId);
  if (!account?.refreshToken) return null;

  const client = oauthClient();
  client.setCredentials({
    access_token: account.accessToken ?? undefined,
    refresh_token: account.refreshToken,
    scope: account.scope ?? undefined,
    token_type: account.tokenType ?? undefined,
    expiry_date: account.expiryDate ? account.expiryDate.getTime() : undefined,
  });

  client.on("tokens", (tokens) => {
    void GoogleAccount.update(
      {
        accessToken: tokens.access_token ?? account.accessToken,
        refreshToken: tokens.refresh_token ?? account.refreshToken,
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : account.expiryDate,
      },
      { where: { userId } },
    ).catch(() => undefined);
  });

  return client;
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
}): Promise<{ meetUrl: string; eventId: string } | null> {
  if (!isMeetOrganizerConfigured()) return null;

  const client = oauthClient();
  client.setCredentials({ refresh_token: env.GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN });

  const calendar = google.calendar({ version: "v3", auth: client });
  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    },
  });

  const meetUrl =
    res.data.hangoutLink ??
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null;
  if (!meetUrl || !res.data.id) return null;
  return { meetUrl, eventId: res.data.id };
}

// Create a Google Calendar event with a Meet link. Returns null if the user
// hasn't connected Google (so callers can fall back to a placeholder URL).
export async function createMeetEvent(
  userId: string,
  input: { summary: string; description?: string; attendees: string[]; startIso: string; endIso: string },
): Promise<{ meetUrl: string; eventId: string } | null> {
  const client = await getAuthorizedClient(userId);
  if (!client) return null;

  const calendar = google.calendar({ version: "v3", auth: client });
  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    },
  });

  const meetUrl =
    res.data.hangoutLink ??
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null;
  if (!meetUrl || !res.data.id) return null;
  return { meetUrl, eventId: res.data.id };
}
