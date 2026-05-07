import type { User, Household } from '../models';

export type AuthContext = {
  user: User;
  household: Household;
  role: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}
