import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { isProd } from "../config/env";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
}

// Central error handler. Normalizes AppError, ZodError, and unknown errors.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: "validation_error", message: "Validation failed", details: err.flatten() },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({
    error: {
      code: "internal_error",
      message: isProd ? "Something went wrong" : (err as Error)?.message ?? "Unknown error",
    },
  });
}
