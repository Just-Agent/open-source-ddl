import fs from 'node:fs';

async function gsocAdapter() {
  return {
    source: "Google Summer of Code",
    url: "https://summerofcode.withgoogle.com",
    items: [],
    note: 'TODO: implement parser for Google Summer of Code; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function osppAdapter() {
  return {
    source: "Open Source Promotion Plan",
    url: "https://summer-ospp.ac.cn",
    items: [],
    note: 'TODO: implement parser for Open Source Promotion Plan; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function lfxAdapter() {
  return {
    source: "LFX Mentorship",
    url: "https://mentorship.lfx.linuxfoundation.org",
    items: [],
    note: 'TODO: implement parser for LFX Mentorship; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function outreachyAdapter() {
  return {
    source: "Outreachy",
    url: "https://www.outreachy.org",
    items: [],
    note: 'TODO: implement parser for Outreachy; keep data/items.json as curated fallback until parser is verified.'
  };
}

const adapters = [gsocAdapter, osppAdapter, lfxAdapter, outreachyAdapter];
const existingItemsUrl = new URL('../data/items.json', import.meta.url);
const existingItems = JSON.parse(fs.readFileSync(existingItemsUrl, 'utf8'));
const reports = [];

for (const adapter of adapters) {
  reports.push(await adapter());
}

const harvestedItems = reports.flatMap(report => report.items);
if (harvestedItems.length > 0) {
  fs.writeFileSync(existingItemsUrl, JSON.stringify(harvestedItems, null, 2) + '\n', 'utf8');
  console.log(`crawler wrote ${harvestedItems.length} fetched items`);
} else {
  console.log(`crawler adapters ran; no verified fetched items yet, preserving ${existingItems.length} curated items`);
}

fs.writeFileSync(new URL('../data/crawl-report.json', import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  topicId: "open-source-ddl",
  adapters: reports
}, null, 2) + '\n', 'utf8');
