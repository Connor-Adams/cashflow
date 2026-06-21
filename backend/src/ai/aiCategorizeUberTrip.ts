import { openaiJsonWithMeta, type OpenAiJsonResult } from './openaiJson';
import type { TripDetail } from './extractReceiptItems';

export type UberTripCategorization = {
  category: string;
  businessUsePercent: number | null;
  confidence: number;
  rationale: string;
};

export type UberTripOpenAiCaller = (
  messages: Parameters<typeof openaiJsonWithMeta>[0],
  options: Parameters<typeof openaiJsonWithMeta>[1],
) => Promise<OpenAiJsonResult>;

const SYSTEM_PROMPT = `You classify a single Uber ride for personal-finance purposes.
Reply with JSON only:
{"category": string, "businessUsePercent": number|null, "confidence": number, "rationale": string}
Rules:
- category is a short label, default "Transport".
- businessUsePercent is 0-100 when the trip is plausibly for work (weekday, work hours,
  office/airport/client destination); null when clearly personal or uncertain.
- confidence 0-100.`;

function clampPercent(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function categorizeUberTrip(
  trip: TripDetail,
  opts: { caller?: UberTripOpenAiCaller } = {},
): Promise<UberTripCategorization> {
  const caller = opts.caller ?? ((m, o) => openaiJsonWithMeta(m, o));
  const meta = await caller(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(trip) },
    ],
    { temperature: 0 },
  );
  const j = (meta.json ?? {}) as Record<string, unknown>;
  const category =
    typeof j.category === 'string' && j.category.trim() ? j.category.trim().slice(0, 128) : 'Transport';
  return {
    category,
    businessUsePercent: clampPercent(j.businessUsePercent),
    confidence: clampConfidence(j.confidence),
    rationale: typeof j.rationale === 'string' ? j.rationale.slice(0, 512) : '',
  };
}
