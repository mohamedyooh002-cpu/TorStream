import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * Global error handler middleware
 * Never leak stack traces in production
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const status = (err as any).status || (err as any).statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Log the full error
  if (status >= 500) {
    logger.error('Unhandled error', {
      method: req.method,
      path: req.path,
      status,
      error: message,
      stack: err.stack
    });
  } else {
    logger.warn('Client error', {
      method: req.method,
      path: req.path,
      status,
      error: message
    });
  }

  // In production, don't leak stack traces for 500 errors
  const responseMessage = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal Server Error'
    : message;

  res.status(status).json({
    error: responseMessage,
    ...(process.env.NODE_ENV !== 'production' && status >= 500 && { stack: err.stack })
  });
}
