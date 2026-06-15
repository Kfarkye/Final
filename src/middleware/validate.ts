import { Request, Response, NextFunction } from "express";
import { ZodTypeAny, ZodError } from "zod";
import { ValidationError } from "../utils/errors";

export const validateRequest = (schema: ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError("Payload validation failed", error.issues));
      } else {
        next(error);
      }
    }
  };
};
