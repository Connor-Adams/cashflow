export const AMAZON_CATEGORIES = [
  'Office Equipment',
  'Software',
  'Meals & Groceries',
  'Household',
  'Travel',
  'Medical',
  'Personal',
  'Uncategorized',
] as const;

export type AmazonCategory = (typeof AMAZON_CATEGORIES)[number];

const rules: Array<{ category: AmazonCategory; terms: string[] }> = [
  {
    category: 'Office Equipment',
    terms: [
      'usb-c',
      'usb c',
      'cable',
      'monitor',
      'keyboard',
      'mouse',
      'dock',
      'adapter',
      'charger',
      'laptop stand',
      'webcam',
      'printer',
      'toner',
      'notebook',
      'desk',
      'office',
    ],
  },
  {
    category: 'Software',
    terms: ['software', 'subscription', 'license', 'antivirus', 'windows', 'macos', 'saas'],
  },
  {
    category: 'Meals & Groceries',
    terms: [
      'protein',
      'coffee',
      'snack',
      'tea',
      'grocery',
      'granola',
      'vitamin water',
      'meal',
      'food',
      'beverage',
    ],
  },
  {
    category: 'Household',
    terms: [
      'detergent',
      'cleaning',
      'cleaner',
      'paper towel',
      'toilet paper',
      'soap',
      'laundry',
      'dish',
      'filter',
      'trash',
      'garbage',
    ],
  },
  {
    category: 'Travel',
    terms: ['luggage', 'suitcase', 'travel', 'passport', 'adapter', 'packing cube'],
  },
  {
    category: 'Medical',
    terms: ['medical', 'first aid', 'bandage', 'thermometer', 'pharmacy', 'medicine'],
  },
  {
    category: 'Personal',
    terms: [
      'toothpaste',
      'toothbrush',
      'shampoo',
      'deodorant',
      'razor',
      'skincare',
      'personal',
    ],
  },
];

export function categorizeAmazonItem(title: string): AmazonCategory {
  const normalized = title.toLowerCase();
  for (const rule of rules) {
    if (rule.terms.some((term) => normalized.includes(term))) {
      return rule.category;
    }
  }
  return 'Uncategorized';
}
