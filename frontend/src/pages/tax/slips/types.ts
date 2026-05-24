export type SlipFormProps = {
  issuer: string;
  onChange: (issuer: string, boxValues: Record<string, number | string>) => void;
  values?: Record<string, number | string>;
};
