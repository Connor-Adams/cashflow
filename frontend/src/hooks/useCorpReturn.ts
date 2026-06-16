export type CorpTaxLineDto = {
  code: string;
  label: string;
  amount: string; // serialized Decimal (toFixed(2))
  inputs: { source: string; amount: string }[];
  formula?: string;
};
