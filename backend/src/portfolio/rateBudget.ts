export type RateBudgetOptions = {
  dailyCap: number;
  now?: () => Date;
};

export class RateBudget {
  private readonly dailyCap: number;
  private readonly now: () => Date;
  private currentDay: string;
  private spent: number;

  constructor(opts: RateBudgetOptions) {
    if (!Number.isFinite(opts.dailyCap) || opts.dailyCap < 0) {
      throw new Error('RateBudget dailyCap must be a non-negative finite number');
    }
    this.dailyCap = Math.floor(opts.dailyCap);
    this.now = opts.now ?? (() => new Date());
    this.currentDay = this.utcDay();
    this.spent = 0;
  }

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollIfNewDay(): void {
    const today = this.utcDay();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.spent = 0;
    }
  }

  spend(): boolean {
    this.rollIfNewDay();
    if (this.spent >= this.dailyCap) return false;
    this.spent += 1;
    return true;
  }

  remaining(): number {
    this.rollIfNewDay();
    return Math.max(0, this.dailyCap - this.spent);
  }

  nextResetAt(): Date {
    const n = this.now();
    const next = new Date(
      Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1, 0, 0, 0, 0),
    );
    return next;
  }
}
