import * as Sentry from "@sentry/node";
import { env } from "./config/env";

// Must be imported before anything else (see index.ts) so Sentry can patch
// http, express, pg and ioredis as they load.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Request bodies here carry passwords, SSH keys and database connection
    // strings, and cookies carry refresh tokens, so none of it is sent.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
      }
      return event;
    },
  });
}
