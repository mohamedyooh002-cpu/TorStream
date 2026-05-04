import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      isAdmin?: boolean;
    }
  }
}

/**
 * JWT authentication middleware for admin routes
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer '

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as { username: string; isAdmin: boolean };
    if (!decoded.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    req.isAdmin = true;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
