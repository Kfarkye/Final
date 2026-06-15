import { Request, Response, NextFunction } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

/**
 * 🛡️ Automatically catches unhandled promise rejections and forwards them 
 * to the Express error handler, eliminating the need for try/catch in controllers.
 */
export const catchAsync = (fn: AsyncHandler) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
