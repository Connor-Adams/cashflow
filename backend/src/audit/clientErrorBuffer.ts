type ClientErrorEntry = { ts: string; message: string; stack?: string; url?: string; householdId?: number };
const MAX = 200;
const buffer: ClientErrorEntry[] = [];

export function pushClientError(entry: ClientErrorEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

export function getClientErrors(householdId: number): ClientErrorEntry[] {
  return buffer.filter((e) => e.householdId === householdId);
}

export function getAllClientErrors(): ClientErrorEntry[] {
  return [...buffer];
}
