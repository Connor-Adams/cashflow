export interface DailyPoint {
  date: string;
  marketValueCad: number;
  cashFlowCad: number;
}

export function computeTwr(points: DailyPoint[]): number {
  if (points.length < 2) return 0;
  if (points[0].marketValueCad === 0) return 0;

  let product = 1;
  for (let i = 1; i < points.length; i++) {
    const mvStart = points[i - 1].marketValueCad;
    const mvEnd = points[i].marketValueCad;
    const cashFlow = points[i].cashFlowCad;
    if (mvStart === 0) continue;
    const r = (mvEnd - cashFlow) / mvStart - 1;
    product *= 1 + r;
  }
  return (product - 1) * 100;
}
