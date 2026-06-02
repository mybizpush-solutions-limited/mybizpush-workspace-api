import type { NextFunction, Request, Response } from "express";

// Application error with an HTTP status. Throw these from anywhere; the error
// middleware turns them into clean JSON responses.
export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, code = "error", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Unauthorized") => new AppError(401, msg, "unauthorized");
export const forbidden = (msg = "Forbidden") => new AppError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new AppError(404, msg, "not_found");
export const conflict = (msg: string) => new AppError(409, msg, "conflict");

// Wrap async route handlers so thrown/rejected errors reach the error middleware.
type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
export const asyncHandler =
  (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
