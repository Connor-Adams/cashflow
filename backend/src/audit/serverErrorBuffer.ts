type ServerErrorEntry = { ts: string; message: string; path?: string; statusCode?: number; householdId?: number };
const MAX = 200;
const buffer: ServerErrorEntry[] = [];

export function pushServerError(entry: ServerErrorEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

export function getServerErrors(householdId: number): ServerErrorEntry[] {
  return buffer.filter((e) => e.householdId === householdId);
}

export function getAllServerErrors(): ServerErrorEntry[] {
  return [...buffer];
}
