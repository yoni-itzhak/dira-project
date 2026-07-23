import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGETS = [
  ['20240342', 'https://www.petah-tikva.muni.il/engineering/planning-and-building/building2#request/20240342'],
  ['20260298', 'https://www.petah-tikva.muni.il/engineering/planning-and-building/building2#request/20260298'],
].map(([requestId, url]) => ({ requestId, url }));

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, 'state');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts');
const FORCE_NOTIFY = /^(1|true|yes)$/i.test(process.env.FORCE_NOTIFY || '');

await fs.mkdir(STATE_DIR, { recursive: true });
await fs.mkdir(ARTIFACT_DIR, { recursive: true });

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const statePath = (id) => path.join(STATE_DIR, `request-${id}.json`);
const errorPath = (id) => path.join(STATE_DIR, `request-${id}.error.json`);

function normalize(value) {
  const ignored = new Set(['Facebook', 'Instagram', 'YouTube', 'LinkedIn']);
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !ignored.has(line))
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join('\n');
}

function diffLines(before, after, limit = 80) {
  const oldLines = normalize(before).split('\n').filter(Boolean);
  const newLines = normalize(after).split('\n').filter(Boolean);
  const counts = (lines) => lines.reduce((map, line) => map.set(line, (map.get(line) || 0) + 1), new Map());
  const oldCounts = counts(oldLines);
  const newCounts = counts(newLines);
  const added = [];
  const removed = [];
  const seenAdded = new Map();
  const seenRemoved = new Map();

  for (const line of newLines) {
    const needed = Math.max(0, (newCounts.get(line) || 0) - (oldCounts.get(line) || 0));
    const seen = seenAdded.get(line) || 0;
    if (seen < needed && added.length < limit) {
      added.push(line);
      seenAdded.set(line, seen + 1);
    }
  }
  for (const line of oldLines) {
    const needed = Math.max(0, (oldCounts.get(line) || 0) - (newCounts.get(line) || 0));
    const seen = seenRemoved.get(line) || 0;
    if (seen < needed && removed.length < limit) {
      removed.push(line);
      seenRemoved.set(line, seen + 1);
    }
  }
  return { added, removed };
}

function blocked(text) {
  return [
    /request rejected/i,
    /access denied/i,
    /incident id/i,
    /verify you are human/i,
    /cloudflare ray id/i,
    /הגישה נדחתה/,
    /הבקשה נדחתה/,
  ].some((pattern) => pattern.test(text));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function removeIfPresent(file) {
  await fs.rm(file, { force: true });
}

async function launchGitHubBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context, mode: 'github-hosted' };
}

async function launchBrowserbase() {
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID || undefined,
    proxies: true,
    region: 'eu-central-1',
    timeout: 600,
    userMetadata: { purpose: 'petah-tikva-permit-watch' },
    browserSettings: {
      viewport: { width: 1440, height: 1100 },
      blockAds: true,
    },
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  return { browser, context, mode: 'browserbase', sessionId: session.id };
}

async function dismissConsent(page) {
  for (const frame of page.frames()) {
    for (const name of [/אישור/i, /מאשר/i, /מסכים/i, /accept/i, /agree/i, /הבנתי/i]) {
      const button = frame.getByRole('button', { name }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => {});
        return;
      }
    }
  }
}

async function collect(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const data = await frame.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const body = document.body?.innerText || '';
      const tables = [...document.querySelectorAll('table')]
        .filter(visible)
        .flatMap((table) => [...table.querySelectorAll('tr')].map((row) =>
          [...row.querySelectorAll('th,td')]
            .map((cell) => cell.innerText.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' | ')))
        .filter(Boolean);
      return { body, tables };
    }).catch(() => null);
    if (data) frames.push({ url: frame.url(), ...data });
  }

  const text = normalize(frames.map((frame) => [frame.body, ...frame.tables].join('\n')).join('\n\n'));
  return { text, frames: frames.map(({ url, tables }) => ({ url, tables })) };
}

async function waitForRequest(page, requestId) {
  const deadline = Date.now() + 45_000;
  let content = await collect(page);
  while (Date.now() < deadline) {
    if (content.text.includes(requestId) || blocked(content.text)) return content;
    await page.waitForTimeout(2_000);
    content = await collect(page);
  }
  return content;
}

async function inspect(context, target, mode) {
  const page = await context.newPage();
  const screenshot = path.join(ARTIFACT_DIR, `request-${target.requestId}.png`);
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissConsent(page);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const content = await waitForRequest(page, target.requestId);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});

    if (blocked(content.text)) throw new Error(`Municipality access was blocked in ${mode} mode.`);
    if (content.text.length < 100) throw new Error(`Only ${content.text.length} visible characters were returned.`);
    if (!content.text.includes(target.requestId)) throw new Error(`Request ${target.requestId} was not visible after the page loaded.`);

    return {
      requestId: target.requestId,
      url: target.url,
      finalUrl: page.url(),
      title: await page.title(),
      checkedAt: new Date().toISOString(),
      browserMode: mode,
      contentHash: hash(content.text),
      text: content.text,
      frames: content.frames,
      screenshot: path.relative(ROOT, screenshot),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

let local;
let remote;
const results = [];

try {
  local = await launchGitHubBrowser();
  for (const target of TARGETS) {
    let current;
    let error;

    try {
      current = await inspect(local.context, target, local.mode);
    } catch (firstError) {
      error = firstError;
      if (process.env.BROWSERBASE_API_KEY) {
        remote ||= await launchBrowserbase();
        try {
          current = await inspect(remote.context, target, remote.mode);
          error = null;
        } catch (secondError) {
          error = secondError;
        }
      }
    }

    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      const previousError = await readJson(errorPath(target.requestId));
      const errorHash = hash(message);
      const isNewError = previousError?.errorHash !== errorHash;
      if (isNewError) await writeJson(errorPath(target.requestId), { errorHash, message, firstSeenAt: new Date().toISOString() });
      results.push({
        requestId: target.requestId,
        url: target.url,
        status: isNewError ? 'error' : 'error-repeated',
        error: message,
      });
      continue;
    }

    await removeIfPresent(errorPath(target.requestId));
    const previous = await readJson(statePath(target.requestId));
    let status = 'unchanged';
    let diff = { added: [], removed: [] };
    if (!previous) status = 'baseline';
    else if (previous.contentHash !== current.contentHash) {
      status = 'changed';
      diff = diffLines(previous.text, current.text);
    }
    if (status !== 'unchanged') await writeJson(statePath(target.requestId), current);

    results.push({
      requestId: target.requestId,
      url: target.url,
      status,
      diff,
      browserMode: current.browserMode,
      screenshot: current.screenshot,
      previousHash: previous?.contentHash || null,
      currentHash: current.contentHash,
    });
  }
} finally {
  await local?.browser?.close().catch(() => {});
  await remote?.browser?.close().catch(() => {});
}

const changes = results.filter((item) => item.status === 'changed');
const newErrors = results.filter((item) => item.status === 'error');
const repeatedErrors = results.filter((item) => item.status === 'error-repeated');
const shouldNotify = changes.length > 0 || newErrors.length > 0 || FORCE_NOTIFY;
const quote = (lines) => lines.length ? lines.map((line) => `- ${line}`).join('\n') : '_None detected._';
const report = [
  '# Petah Tikva permit watcher',
  '',
  `Checked: ${new Date().toISOString()}`,
  '',
  ...results.flatMap((item) => {
    const lines = [
      `## Request ${item.requestId}`,
      '',
      `Status: **${item.status}**`,
      `Source: ${item.url}`,
      item.browserMode ? `Browser: ${item.browserMode}` : null,
      item.screenshot ? `Screenshot artifact: \`${item.screenshot}\`` : null,
      '',
    ].filter((line) => line !== null);
    if (item.status === 'changed') {
      lines.push('### Added or newly visible', '', quote(item.diff.added), '');
      lines.push('### Removed or no longer visible', '', quote(item.diff.removed), '');
    } else if (item.status === 'baseline') lines.push('Initial baseline saved.', '');
    else if (item.status === 'unchanged') lines.push('No visible change was detected.', '');
    else lines.push(`Error: ${item.error}`, '');
    return lines;
  }),
  '---',
  `Changed requests: ${changes.map((item) => item.requestId).join(', ') || 'none'}`,
  `New errors: ${newErrors.map((item) => item.requestId).join(', ') || 'none'}`,
  `Repeated errors: ${repeatedErrors.map((item) => item.requestId).join(', ') || 'none'}`,
].join('\n') + '\n';

const result = {
  checkedAt: new Date().toISOString(),
  hasChanges: changes.length > 0,
  hasNewErrors: newErrors.length > 0,
  hasRepeatedErrors: repeatedErrors.length > 0,
  shouldNotify,
  results,
};

await fs.writeFile(path.join(ROOT, 'report.md'), report, 'utf8');
await writeJson(path.join(ROOT, 'result.json'), result);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8');
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, [
    `has_changes=${result.hasChanges}`,
    `has_new_errors=${result.hasNewErrors}`,
    `has_repeated_errors=${result.hasRepeatedErrors}`,
    `should_notify=${result.shouldNotify}`,
    `changed_ids=${changes.map((item) => item.requestId).join(',')}`,
  ].join('\n') + '\n', 'utf8');
}

console.log(report);
if (result.hasNewErrors) process.exitCode = 2;
