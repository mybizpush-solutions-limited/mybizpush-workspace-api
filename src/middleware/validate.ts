import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny, infer as zInfer } from "zod";

// Validate a request part against a Zod schema, replacing it with the parsed
// (typed, coerced) value. Throws ZodError which the error handler formats.
export const validateBody =
  <S extends ZodTypeAny>(schema: S) =>
  (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body) as zInfer<S>;
    next();
  };

export const validateQuery =
  <S extends ZodTypeAny>(schema: S) =>
  (req: Request, _res: Response, next: NextFunction) => {
    req.query = schema.parse(req.query) as never;
    next();
  };

export const validateParams =
  <S extends ZodTypeAny>(schema: S) =>
  (req: Request, _res: Response, next: NextFunction) => {
    req.params = schema.parse(req.params) as never;
    next();
  };
