import type { Request, Response } from 'express';
import { isDemoUserEmail } from './seedDemoData';

export function isDemoUserRequest(req: Request): boolean {
  return isDemoUserEmail(req.auth?.user.email);
}

export function rejectDemoAiRequest(req: Request, res: Response): boolean {
  if (!isDemoUserRequest(req)) return false;
  res.status(403).json({ error: 'AI is disabled for the demo account' });
  return true;
}
