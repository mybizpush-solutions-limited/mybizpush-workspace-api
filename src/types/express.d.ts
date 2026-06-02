import type { AccessTokenPayload } from "../lib/jwt";

// Attach the authenticated user's token payload to the request.
declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload;
    }
  }
}

export {};
