import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupSeedBrand,
  type BrandEntry,
} from '../src/import/enrichment/brandDictionary';

test('lookupSeedBrand returns Amazon for AMZN MKTP variants', () => {
  assert.equal(lookupSeedBrand('AMZN MKTP US A1B2C3'), 'Amazon');
  assert.equal(lookupSeedBrand('amazon.ca prime'), 'Amazon');
  assert.equal(lookupSeedBrand('AMZN Digital Svcs'), 'Amazon');
});

test('lookupSeedBrand returns Netflix for Netflix variants', () => {
  assert.equal(lookupSeedBrand('NETFLIX.COM'), 'Netflix');
  assert.equal(lookupSeedBrand('netflix monthly'), 'Netflix');
});

test('lookupSeedBrand returns null for unknown', () => {
  assert.equal(lookupSeedBrand("Joe's Coffee Shop"), null);
  assert.equal(lookupSeedBrand(''), null);
});

test('lookupSeedBrand normalizes case', () => {
  assert.equal(lookupSeedBrand('SPOTIFY'), 'Spotify');
  assert.equal(lookupSeedBrand('spotify usa'), 'Spotify');
});

test('lookupSeedBrand matches DoorDash on glued restaurant suffixes', () => {
  assert.equal(lookupSeedBrand('DOORDASHTHESAFFRONI DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHBARBURRITO DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHMCDONALDS DOWNTOWN'), 'DoorDash');
  assert.equal(lookupSeedBrand('DOORDASHPOPEYESLOUI'), 'DoorDash');
});

test('lookupSeedBrand still matches plain DoorDash', () => {
  assert.equal(lookupSeedBrand('DOORDASH'), 'DoorDash');
  assert.equal(lookupSeedBrand('DD *DOORDASH'), 'DoorDash');
});

test('lookupSeedBrand handles new restaurant brands', () => {
  assert.equal(lookupSeedBrand('BURGER KING'), 'Burger King');
  assert.equal(lookupSeedBrand('BURGER KING #24238 PUSLINCH'), 'Burger King');
  assert.equal(lookupSeedBrand('WENDYS'), "Wendy's");
  assert.equal(lookupSeedBrand("MCDONALD'S"), "McDonald's");
  assert.equal(lookupSeedBrand('A&W'), 'A&W');
  assert.equal(lookupSeedBrand('A & W'), 'A&W');
  assert.equal(lookupSeedBrand('POPEYES #13383'), 'Popeyes');
  assert.equal(lookupSeedBrand('TACO BELL'), 'Taco Bell');
  assert.equal(lookupSeedBrand('KFC'), 'KFC');
  assert.equal(lookupSeedBrand('KFC/TB STONE RD'), 'KFC/Taco Bell (combo)');
  assert.equal(lookupSeedBrand('BOOSTER JUICE'), 'Booster Juice');
  assert.equal(lookupSeedBrand('PIZZA PIZZA'), 'Pizza Pizza');
  assert.equal(lookupSeedBrand('PIZZAVILLE'), 'Pizzaville');
});

test('lookupSeedBrand handles new retail brands', () => {
  assert.equal(lookupSeedBrand('DOLLARAMA'), 'Dollarama');
  assert.equal(lookupSeedBrand('SHOPPERS DRUG MART'), 'Shoppers Drug Mart');
  assert.equal(lookupSeedBrand('THE HOME DEPOT'), 'Home Depot');
  assert.equal(lookupSeedBrand('MARSHALLS'), 'Marshalls');
  assert.equal(lookupSeedBrand('WINNERS'), 'Winners');
});

test('lookupSeedBrand handles new grocery/liquor brands', () => {
  assert.equal(lookupSeedBrand('FARM BOY'), 'Farm Boy');
  assert.equal(lookupSeedBrand('FOOD BASICS'), 'Food Basics');
  assert.equal(lookupSeedBrand('ZEHRS'), 'Zehrs');
  assert.equal(lookupSeedBrand('THE BEER STORE'), 'Beer Store');
  assert.equal(lookupSeedBrand('LCBO'), 'LCBO');
  assert.equal(lookupSeedBrand('RCSS'), 'Real Canadian Superstore');
});

test('lookupSeedBrand handles new tech/subscription brands', () => {
  assert.equal(lookupSeedBrand('CURSOR'), 'Cursor');
  assert.equal(lookupSeedBrand('XAI LLC'), 'xAI');
  assert.equal(lookupSeedBrand('GROK XAI'), 'xAI');
  assert.equal(lookupSeedBrand('CLOUDFLARE'), 'Cloudflare');
  assert.equal(lookupSeedBrand('DISCORD'), 'Discord');
  assert.equal(lookupSeedBrand('DISCORD* NITROMONTHLY'), 'Discord');
  assert.equal(lookupSeedBrand('TWITCH'), 'Twitch');
  assert.equal(lookupSeedBrand('HOLAFLY'), 'Holafly');
  assert.equal(lookupSeedBrand('AIRALO'), 'Airalo');
  assert.equal(lookupSeedBrand('INSTACART'), 'Instacart');
  assert.equal(lookupSeedBrand('INTUIT QBOOKS'), 'Intuit');
  assert.equal(lookupSeedBrand('PADDLE.NET'), 'Paddle');
  assert.equal(lookupSeedBrand('FEDEX'), 'FedEx');
  assert.equal(lookupSeedBrand('UPS'), 'UPS');
  assert.equal(lookupSeedBrand('UPS*'), 'UPS');
});
