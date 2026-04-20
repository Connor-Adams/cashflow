import fs from 'fs/promises';
import path from 'path';
import { getOpenAiConfig, getVisionModel } from '../config/openai';
import { getReceiptsUploadDir } from '../config/receipts';
import type { Receipt } from '../models/Receipt';

export type ReceiptExtract = {
  merchant: string | null;
  total: number | null;
  currency: string | null;
  date: string | null;
  summary: string | null;
};

function parseExtract(j: Record<string, unknown>): ReceiptExtract {
  return {
    merchant:
      typeof j.merchant === 'string' && j.merchant.trim()
        ? j.merchant.trim()
        : null,
    total:
      typeof j.total === 'number' && Number.isFinite(j.total)
        ? j.total
        : typeof j.total === 'string' && j.total.trim()
          ? Number(j.total.replace(/,/g, ''))
          : null,
    currency:
      typeof j.currency === 'string' && j.currency.trim()
        ? j.currency.trim().toUpperCase().slice(0, 3)
        : null,
    date:
      typeof j.date === 'string' && j.date.trim() ? j.date.trim() : null,
    summary:
      typeof j.summary === 'string' && j.summary.trim()
        ? j.summary.trim()
        : null,
  };
}

export async function analyzeReceiptFile(receipt: Receipt): Promise<ReceiptExtract> {
  const cfg = getOpenAiConfig();
  if (!cfg) {
    const err = new Error('OpenAI is not configured (set OPENAI_API_KEY)') as Error & {
      status?: number;
    };
    err.status = 503;
    throw err;
  }

  const dir = getReceiptsUploadDir();
  const abs = path.join(dir, receipt.storedFilename);
  const buf = await fs.readFile(abs);
  const mime = receipt.mimeType.toLowerCase();
  if (!mime.startsWith('image/')) {
    const err = new Error(
      'Vision analysis supports images only (JPEG, PNG, WebP)',
    ) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const b64 = buf.toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: getVisionModel(),
      messages: [
        {
          role: 'system',
          content:
            'You read receipt images. Reply with JSON only: merchant (string|null), total (number|null), currency (3-letter ISO or null), date (ISO YYYY-MM-DD or null), summary (short string|null).',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract key fields from this receipt image.',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`OpenAI error ${res.status}: ${t.slice(0, 400)}`) as Error & {
      status?: number;
    };
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no content');
  const j = JSON.parse(text) as Record<string, unknown>;
  return parseExtract(j);
}
