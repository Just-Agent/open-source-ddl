import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const CRAWL_TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS) || 10000;
const USER_AGENT = 'Just-DDL-Crawler/1.0 (+https://just-agent.github.io/just-ddl/)';

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 200) : null;
}

function fetchViaPowerShell(url) {
  if (process.platform !== 'win32') return null;
  const timeoutSec = Math.max(15, Math.ceil(CRAWL_TIMEOUT_MS / 1000) + 5);
  const escapedUrl = url.replace(/'/g, "''");
  const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); (Invoke-WebRequest -Uri '" + escapedUrl + "' -UseBasicParsing -TimeoutSec " + timeoutSec + " -Headers @{ 'User-Agent'='Mozilla/5.0'; 'Accept-Language'='en-US,en;q=0.9' }).Content";
  for (const command of ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: (timeoutSec + 5) * 1000
    });
    if (result.status === 0 && result.stdout && result.stdout.trim().length > 1000) {
      return result.stdout;
    }
  }
  return null;
}

async function fetchSourcePage(source) {
  const report = {
    sourceId: source.id,
    source: source.name,
    url: source.url,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'Source reachability check only; curated data/items.json preserved until item parser is implemented.',
    error: null
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
    const res = await fetch(source.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT }
    });
    clearTimeout(timer);
    report.httpStatus = res.status;
    report.finalUrl = res.url;
    const text = await res.text();
    report.contentLength = text.length;
    report.title = extractTitle(text);
    report.reachable = res.status >= 200 && res.status < 400;
    report.note = report.reachable
      ? 'Source reachable. Curated data/items.json preserved until item parser is implemented.'
      : `Source returned HTTP ${res.status}. Curated data/items.json preserved.`;
  } catch (err) {
    report.error = err.name === 'AbortError' ? `Timeout after ${CRAWL_TIMEOUT_MS}ms` : err.message;
    report.note = `Source fetch failed: ${report.error}. Curated data/items.json preserved.`;
  }
  return report;
}

const GSOC_TIMELINE_URL = 'https://developers.google.com/open-source/gsoc/timeline?hl=en';
const GSOC_MIN_ITEMS = 8;
const GSOC_MAX_FUTURE_DAYS = Number(process.env.GSOC_MAX_FUTURE_DAYS) || 500;

function parseGsocDate(dateStr) {
  // dateStr examples:
  //   "January 22 - 18:00 UTC"
  //   "January 22 - February 11 - 18:00 UTC"
  //   "January 27 - 18:00 UTC"
  //   "February 11"
  //   "August 17 - 24 - 18:00 UTC"
  // Returns { iso: string, isDeadline: boolean } or null.

  const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
  const text = dateStr.replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ').trim();

  // Check for UTC time
  const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*UTC/i);
  const hour = timeMatch ? parseInt(timeMatch[1], 10) : null;
  const minute = timeMatch ? parseInt(timeMatch[2], 10) : null;

  // Find all month+day pairs and same-month day-only range endings.
  const monthDayRe = /([A-Za-z]+)\s+(\d{1,2})/g;
  const pairs = [];
  let mm;
  while ((mm = monthDayRe.exec(text)) !== null) {
    const m = MONTHS[mm[1].toLowerCase()];
    if (m) pairs.push({ month: m, day: parseInt(mm[2], 10) });
  }
  if (pairs.length === 0) return null;

  // For ranges, use the last date (deadline/end date)
  let last = pairs[pairs.length - 1];
  const sameMonthRange = text.match(/[A-Za-z]+\s+\d{1,2}\s*-\s*(\d{1,2})(?=\s*(?:-|$))(?:\s*-\s*\d{1,2}:\d{2}\s*UTC)?/i);
  if (pairs.length === 1 && sameMonthRange) {
    last = { month: pairs[0].month, day: parseInt(sameMonthRange[1], 10) };
  }
  const year = 2026;
  const pad = n => String(n).padStart(2, '0');
  const iso = hour !== null
    ? `${year}-${pad(last.month)}-${pad(last.day)}T${pad(hour)}:${pad(minute)}:00Z`
    : `${year}-${pad(last.month)}-${pad(last.day)}T23:59:59Z`;

  return { iso };
}

function gsocSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function parseGsocItems() {
  const report = {
    sourceId: 'gsoc',
    source: 'Google Summer of Code',
    url: GSOC_TIMELINE_URL,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'GSoC 2026 timeline parser.',
    error: null,
    parsedItemCount: 0,
    invalidItemCount: 0,
    parserHealthy: false
  };
  try {
    let text;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
      const res = await fetch(GSOC_TIMELINE_URL, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' }
      });
      clearTimeout(timer);
      report.httpStatus = res.status;
      report.finalUrl = res.url;
      text = await res.text();
      report.reachable = res.status >= 200 && res.status < 400;
    } catch (fetchErr) {
      const fallbackText = fetchViaPowerShell(GSOC_TIMELINE_URL);
      if (!fallbackText) throw fetchErr;
      text = fallbackText;
      report.httpStatus = 200;
      report.finalUrl = GSOC_TIMELINE_URL;
      report.reachable = true;
      report.note = 'Fetched GSoC timeline with Windows PowerShell fallback after Node fetch failed.';
    }
    report.contentLength = text.length;
    report.title = (text.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || null;

    if (!report.reachable) {
      report.note = 'GSoC timeline returned HTTP ' + report.httpStatus + '. No items parsed.';
      return report;
    }

    // Verify the 2026_timeline section exists
    if (!/id="2026_timeline"/i.test(text)) {
      report.note = 'Could not find 2026_timeline section in GSoC timeline page. Page structure may have changed.';
      return report;
    }

    // Parse h3 headings with data-text attributes followed by content until next h3
    // Pattern: <h3 ... data-text="..." ...>...</h3> ... (content until next <h3)
    const h3Re = /<h3[^>]*\bdata-text="([^"]*)"[^>]*>[\s\S]*?<\/h3>([\s\S]*?)(?=<h3|$)/gi;
    let h3Match;
    while ((h3Match = h3Re.exec(text)) !== null) {
      const dateText = h3Match[1];
      const afterH3 = h3Match[2];

      const parsed = parseGsocDate(dateText);
      if (!parsed) {
        report.invalidItemCount += 1;
        continue;
      }

      const deadlineDate = new Date(parsed.iso);
      if (isNaN(deadlineDate.getTime())) {
        report.invalidItemCount += 1;
        continue;
      }
      const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
      if (daysFromNow < -7 || daysFromNow > GSOC_MAX_FUTURE_DAYS) {
        report.invalidItemCount += 1;
        continue;
      }

      // Extract li items from the following ul
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRe.exec(afterH3)) !== null) {
        const rawText = liMatch[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
        if (!rawText || rawText.length < 3) continue;

        const eventTitle = rawText.length > 150 ? rawText.slice(0, 150) + '...' : rawText;
        const eventLower = rawText.toLowerCase();
        const dateRange = dateText.replace(/\s+/g, ' ').trim();
        const isDeadline = /deadline|due|final date|closes?|applications?\s+close|rankings?\s+due|evaluations?\s+deadline|submit\s+(?:their\s+)?final/.test(eventLower);
        const itemId = 'gsoc-2026-' + gsocSlug(dateRange + '-' + eventTitle);
        const stageLabel = isDeadline ? 'Deadline' : 'Milestone';

        report.items.push({
          id: itemId,
          title: eventTitle,
          deadline: parsed.iso,
          dateRange,
          location: 'Online',
          isOnline: true,
          tags: ['GSoC', 'open source'],
          url: GSOC_TIMELINE_URL,
          status: 'upcoming',
          description: 'Parsed from the official GSoC 2026 timeline. ' + stageLabel + ' event.',
          stage: stageLabel,
          source: 'Google Summer of Code',
          type: 'program'
        });
      }
    }

    report.parsedItemCount = report.items.length;
    report.parserHealthy = report.parsedItemCount >= GSOC_MIN_ITEMS;
    report.note = 'Parsed ' + report.parsedItemCount + ' items from GSoC 2026 timeline; rejected ' + report.invalidItemCount + ' date-window outliers.';
  } catch (err) {
    report.error = err.name === 'AbortError' ? 'Timeout after ' + CRAWL_TIMEOUT_MS + 'ms' : err.message;
    report.note = 'GSoC timeline fetch failed: ' + report.error;
  }
  return report;
}

async function gsocAdapter() {
  return parseGsocItems();
}
async function osppAdapter() {
  return fetchSourcePage({ id: "ospp", name: "Open Source Promotion Plan", url: "https://summer-ospp.ac.cn" });
}

async function lfxAdapter() {
  return fetchSourcePage({ id: "lfx", name: "LFX Mentorship", url: "https://mentorship.lfx.linuxfoundation.org" });
}

async function outreachyAdapter() {
  return fetchSourcePage({ id: "outreachy", name: "Outreachy", url: "https://www.outreachy.org" });
}

const adapters = [gsocAdapter, osppAdapter, lfxAdapter, outreachyAdapter];
const existingItemsUrl = new URL('../data/items.json', import.meta.url);
const existingItems = JSON.parse(fs.readFileSync(existingItemsUrl, 'utf8'));
let previousParsedItemCount = null;
try {
  const previousReport = JSON.parse(fs.readFileSync(new URL('../data/crawl-report.json', import.meta.url), 'utf8'));
  previousParsedItemCount = previousReport.parsedItemCount ?? null;
} catch {}
const reports = [];

for (const adapter of adapters) {
  reports.push(await adapter());
}

const harvestedItems = reports.flatMap(report => report.items);
const parsedItemCount = reports.reduce((s, r) => s + (r.parsedItemCount || 0), 0);
const parserHealthy = reports.every(r => r.parserHealthy !== false);
const parserDropOk = previousParsedItemCount === null || parsedItemCount >= Math.floor(previousParsedItemCount * 0.5);
if (harvestedItems.length >= GSOC_MIN_ITEMS && parserHealthy && parserDropOk) {
  fs.writeFileSync(existingItemsUrl, JSON.stringify(harvestedItems, null, 2) + '\n', 'utf8');
  console.log('crawler wrote ' + harvestedItems.length + ' fetched items');
} else {
  console.log('parser emitted ' + harvestedItems.length + ' items (health gate failed or threshold not met); preserving ' + existingItems.length + ' curated items in data/items.json');
}

const reachableCount = reports.filter(r => r.reachable).length;
console.log('reachability: ' + reachableCount + '/' + reports.length + ' sources reachable');
if (parsedItemCount > 0) console.log('parsedItemCount: ' + parsedItemCount);

fs.writeFileSync(new URL('../data/crawl-report.json', import.meta.url), JSON.stringify({
  topicId: "open-source-ddl",
  generatedAt: new Date().toISOString(),
  adapterCount: reports.length,
  reachableCount,
  parsedItemCount,
  previousParsedItemCount,
  parserHealthy,
  parserDropOk,
  adapters: reports
}, null, 2) + '\n', 'utf8');
