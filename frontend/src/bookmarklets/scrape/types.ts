export interface CapturedItem {
  title: string;
  quantity?: number;
  totalPrice?: number | null;
  unitPrice?: number | null;
}

export interface CapturedOrder {
  vendorOrderId: string | null;
  orderDate: string; // YYYY-MM-DD
  total: number;
  currency: string;
  paymentLast4: string | null;
  items: CapturedItem[];
  rawSource: string;
}
