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
  { pattern: /\b(doordash|dd\s*\*doordash)/i, canonical: 'DoorDash' },
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
  { pattern: /\b(kfc\/tb)\b/i, canonical: 'KFC/Taco Bell (combo)' },
  { pattern: /\b(taco\s*bell)\b/i, canonical: 'Taco Bell' },
  { pattern: /\b(kfc)\b/i, canonical: 'KFC' },
  { pattern: /\b(burger\s*king|bk\s*#?\d*)\b/i, canonical: 'Burger King' },
  { pattern: /\b(wendys|wendy's)\b/i, canonical: "Wendy's" },
  { pattern: /\b(popeyes)/i, canonical: 'Popeyes' },
  { pattern: /\b(a\s*&\s*w|a&w)\b/i, canonical: 'A&W' },
  { pattern: /\b(pizza\s*pizza)\b/i, canonical: 'Pizza Pizza' },
  { pattern: /\b(pizzaville)\b/i, canonical: 'Pizzaville' },
  { pattern: /\b(booster\s*juice)\b/i, canonical: 'Booster Juice' },
  { pattern: /\b(dollarama)\b/i, canonical: 'Dollarama' },
  { pattern: /\b(shoppers\s*drug\s*mart|shoppers\s*dm)\b/i, canonical: 'Shoppers Drug Mart' },
  { pattern: /\b(home\s*depot)\b/i, canonical: 'Home Depot' },
  { pattern: /\b(marshalls)\b/i, canonical: 'Marshalls' },
  { pattern: /\b(winners)\b/i, canonical: 'Winners' },
  { pattern: /\b(farm\s*boy)\b/i, canonical: 'Farm Boy' },
  { pattern: /\b(food\s*basics)\b/i, canonical: 'Food Basics' },
  { pattern: /\b(zehrs)\b/i, canonical: 'Zehrs' },
  { pattern: /\b(the\s*beer\s*store|beer\s*store)\b/i, canonical: 'Beer Store' },
  { pattern: /\b(lcbo)\b/i, canonical: 'LCBO' },
  { pattern: /\b(real\s*canadian\s*superstore|rcss)\b/i, canonical: 'Real Canadian Superstore' },
  { pattern: /\b(cursor)\b/i, canonical: 'Cursor' },
  { pattern: /\b(xai|grok|x\.ai)\b/i, canonical: 'xAI' },
  { pattern: /\b(cloudflare)\b/i, canonical: 'Cloudflare' },
  { pattern: /\b(discord)/i, canonical: 'Discord' },
  { pattern: /\b(twitch)\b/i, canonical: 'Twitch' },
  { pattern: /\b(holafly)\b/i, canonical: 'Holafly' },
  { pattern: /\b(airalo)\b/i, canonical: 'Airalo' },
  { pattern: /\b(instacart|ic\s*\*\s*instacart)/i, canonical: 'Instacart' },
  { pattern: /\b(intuit|qbooks|quickbooks)\b/i, canonical: 'Intuit' },
  { pattern: /\b(paddle\.net|paddle)/i, canonical: 'Paddle' },
  { pattern: /\b(fedex)/i, canonical: 'FedEx' },
  { pattern: /\b(ups\s*\*|\bups\b)/i, canonical: 'UPS' },
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
