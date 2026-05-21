export interface BrandEntry {
  pattern: RegExp;
  canonical: string;
}

const SEED_BRANDS: BrandEntry[] = [
  { pattern: /\b(amazon(?:\.(?:com|ca|co\.uk))?|amzn|amzn\s*mktp|amzn\s*digital)\b/i, canonical: 'Amazon' },
  { pattern: /\b(netflix)\b/i, canonical: 'Netflix' },
  { pattern: /\b(spotify)\b/i, canonical: 'Spotify' },
  { pattern: /\b(apple\.com|itunes|apple\s*music|apple\s*tv|apple\s*store)\b/i, canonical: 'Apple' },
  { pattern: /\b(google\s*\*|google\s*play|google\s*storage|google\s*one|youtube\s*premium|googlepay)\b/i, canonical: 'Google' },
  { pattern: /\b(uber(?:\s*eats)?|uber\.com)\b/i, canonical: 'Uber' },
  { pattern: /\b(lyft)\b/i, canonical: 'Lyft' },
  { pattern: /\b(doordash|dd\s*\*doordash)\b/i, canonical: 'DoorDash' },
  { pattern: /\b(starbucks|sbux)\b/i, canonical: 'Starbucks' },
  { pattern: /\b(mcdonalds|mcdonald's|mcd\s*\d*)\b/i, canonical: "McDonald's" },
  { pattern: /\b(costco(?:\s*whse)?)\b/i, canonical: 'Costco' },
  { pattern: /\b(walmart|wal-mart|wm\s*supercenter)\b/i, canonical: 'Walmart' },
  { pattern: /\b(target\.com|target\s*\d*)\b/i, canonical: 'Target' },
  { pattern: /\b(shell\s*oil|shell\s*\d|shell\s*canada)\b/i, canonical: 'Shell' },
  { pattern: /\b(esso)\b/i, canonical: 'Esso' },
  { pattern: /\b(petro-canada|petro\s*can)\b/i, canonical: 'Petro-Canada' },
  { pattern: /\b(loblaws|loblaw|nofrills|no\s*frills)\b/i, canonical: 'Loblaws' },
  { pattern: /\b(metro\s*ontario|metro\s*store)\b/i, canonical: 'Metro' },
  { pattern: /\b(sobeys)\b/i, canonical: 'Sobeys' },
  { pattern: /\b(tim\s*hortons|tim\s*horton)\b/i, canonical: 'Tim Hortons' },
  { pattern: /\b(rogers\s*comm|rogers\s*wireless)\b/i, canonical: 'Rogers' },
  { pattern: /\b(bell\s*canada|bell\s*mobility|bell\s*mts)\b/i, canonical: 'Bell' },
  { pattern: /\b(telus|telus\s*mobility)\b/i, canonical: 'Telus' },
  { pattern: /\b(hydro\s*one|toronto\s*hydro|bc\s*hydro)\b/i, canonical: 'Hydro' },
  { pattern: /\b(enbridge)\b/i, canonical: 'Enbridge' },
  { pattern: /\b(disney\s*plus|disneyplus|disney\s*\+)\b/i, canonical: 'Disney+' },
  { pattern: /\b(github|gh\s*\*github)\b/i, canonical: 'GitHub' },
  { pattern: /\b(openai|chatgpt)\b/i, canonical: 'OpenAI' },
  { pattern: /\b(anthropic|claude\.ai)\b/i, canonical: 'Anthropic' },
  { pattern: /\b(stripe\s*\*|stripe\.com)\b/i, canonical: 'Stripe' },
  { pattern: /\b(paypal\s*\*)\b/i, canonical: 'PayPal' },
  { pattern: /\b(square\s*\*|sq\s*\*)\b/i, canonical: 'Square' },
];

export function lookupSeedBrand(merchantClean: string): string | null {
  if (!merchantClean) return null;
  for (const entry of SEED_BRANDS) {
    if (entry.pattern.test(merchantClean)) return entry.canonical;
  }
  return null;
}

export function getSeedBrandList(): readonly BrandEntry[] {
  return SEED_BRANDS;
}
