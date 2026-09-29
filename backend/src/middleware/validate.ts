import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

/** Parses req.body with the schema (throwing ZodError → 400) and replaces it with the result. */
export function validateBody(schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
}
