import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGETS = [
  {
    requestId: '20240342',
    url: 'https://www.petah-tikva.muni.il/engineering/planning-and-building/building2#request/20240342',
  },
  {
    requestId: '20260298',
    url: 'https://www.petah-tikva.muni.il/engineering/planning-and-building/building2#request/20260298',
  },
];

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, 'state');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts');
const REPORT_PATH = path.join(ROOT, 'report.md');
const RESULT_PATH = path.join(ROOT, 'result.json');
const FORCE_NOTIFY = ['1', 'true', 'yes'].includes(String(process.env.FORCE_NOTIFY || '').toLowerCase());

await fs.mkdir(STATE_DIR, { recursive: true });
await fs.mkdir(ARTIFACT_DIR, { recursive: true });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  const noisyExactLines = new Set(['Facebook', 'Instagram', 'YouTube', 'LinkedIn']);
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !noisyExactLines.has(line))
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join('\n')
    .trim();
}

function countLines(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

function lineDiff(before, after, limit = 80) {
  const beforeLines = normalizeText(before).split('\n').filter(Boolean);
  const afterLines = normalizeText(after).split('\n').filter(Boolean);
  const beforeCounts = countLines(beforeLines);
  const afterCounts = countLines(afterLines);
  const removed = [];
  const added = [];
  const removedCounts = new Map();
  const addedCounts = new Map();

  for (const line of beforeLines) {
    const needed = Math.max(0, (beforeCounts.get(line) || 0) - (afterCounts.get(line) || 0));
    const current = removedCounts.get(line) || 0;
    if (current < needed && removed.length < limit) {
      removed.push(line);
      removedCounts.set(line, current + 1);
    }
  }
  for (const line of afterLines) {
    const needed = Math.max(0, (afterCounts.get(line) || 0) - (beforeCounts.get(line) || 0));
    const current = addedCounts.get(line) || 0;
    if (current < needed && added.length < limit) {
      added.push(line);
      addedCounts.set(line, current + 1);
    }
  }

  return { added, removed };
}

function isBlocked(text) {
  const patterns = [
    /request rejected/i,
    /access denied/i,
    /incident id/i,
    /verify you are human/i,
    /cloudflare ray id/i,
    /הגישה נדחתה/,
    /הבקשה נדחתה/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

async function createBrowser() {
  if (process.env.BROWSERBASE_API_KEY) {
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

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context, mode: 'github-hosted', sessionId: null };
}

async function dismissConsent(page) {
  const buttonPatterns = [/אישור/i, /מאשר/i, /מסכים/i, /accept/i, /agree/i, /הבנתי/i];
  for (const frame of page.frames()) {
    for (const pattern of buttonPatterns) {
      const button = frame.getByRole('button', { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => {});
        return;
      }
    }
  }
}

async function collectVisibleContent(page) {
  const frameResults = [];
  for (const frame of page.frames()) {
    const data = await frame.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const bodyText = document.body?.innerText || '';
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .filter(visible)
        .map((element) => element.innerText.trim())
        .filter(Boolean);
      const tables = [...document.querySelectorAll('table')]
        .filter(visible)
        .map((table) => [...table.querySelectorAll('tr')]
          .map((row) => [...row.querySelectorAll('th,td')]
            .map((cell) => cell.innerText.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' | '))
          .filter(Boolean));
      const definitionLists = [...document.querySelectorAll('dl')]
        .filter(visible)
        .map((list) => list.innerText.trim())
        .filter(Boolean);
      return { bodyText, headings, tables, definitionLists };
    }).catch(() => null);
    if (data) frameResults.push({ url: frame.url(), ...data });
  }

  const combined = frameResults.map((frame) => [
    `FRAME: ${frame.url}`,
    frame.bodyText,
    ...frame.tables.flat(),
    ...frame.definitionLists,
  ].join('\n')).join('\n\n');

  return {
    text: normalizeText(combined),
    frames: frameResults.map((frame) => ({
      url: frame.url,
      headings: frame.headings,
      tables: frame.tables,
    })),
  };
}

async function waitForApplication(page, requestId) {
  const deadline = Date.now() + 45_000;
  let latestContent = await collectVisibleContent(page);
  while (Date.now() < deadline) {
    if (latestContent.text.includes(requestId) || isBlocked(latestContent.text)) return latestContent;
    await page.waitForTimeout(2_000);
    latestContent = await collectVisibleContent(page);
  }
  return latestContent;
}

async function inspectTarget(context, target, mode) {
  const page = await context.newPage();
  const screenshotPath = path.join(ARTIFACT_DIR, `request-${target.requestId}.png`);
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissConsent(page);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const content = await waitForApplication(page, target.requestId);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    if (isBlocked(content.text)) throw new Error(`Municipality access was blocked in ${mode} mode.`);
    if (content.text.length < 100) throw new Error(`The page returned too little visible content (${content.text.length} characters).`);
    if (!content.text.includes(target.requestId)) throw new Error(`Request number ${target.requestId} was not found in the loaded page.`);

    return {
      requestId: target.requestId,
      url: target.url,
      finalUrl: page.url(),
      title: await page.title(),
      checkedAt: new Date().toISOString(),
      browserMode: mode,
      contentHash: sha256(content.text),
      text: content.text,
      frames: content.frames,
      screenshot: path.relative(ROOT, screenshotPath),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function readPrevious(requestId) {
  const filePath = path.join(STATE_DIR, `request-${requestId}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveSnapshot(snapshot) {
  const filePath = path.join(STATE_DIR, `request-${snapshot.requestId}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function quoteLines(lines) {
  if (!lines.length) return '_None detected._';
  return lines.map((line) => `- ${line}`).join('\n');
}

function buildReport(results, mode, sessionId) {
  const changed = results.filter((item) => item.status === 'changed');
  const errors = results.filter((item) => item.status === 'error');
  const lines = [
    '# Petah Tikva permit watcher',
    '',
    `Checked: ${new Date().toISOString()}`,
    `Browser mode: ${mode}`,
    sessionId ? `Browserbase session: ${sessionId}` : null,
    '',
  ].filter((line) => line !== null);

  for (const item of results) {
    lines.push(`## Request ${item.requestId}`);
    lines.push('');
    lines.push(`Status: **${item.status}**`);
    lines.push(`Source: ${item.url}`);
    if (item.screenshot) lines.push(`Screenshot artifact: \`${item.screenshot}\``);
    lines.push('');

    if (item.status === 'changed') {
      lines.push('### Added or newly visible', '', quoteLines(item.diff.added), '');
      lines.push('### Removed or no longer visible', '', quoteLines(item.diff.removed), '');
    } else if (item.status === 'baseline') {
      lines.push('Initial baseline saved. Future runs will compare against this snapshot.', '');
    } else if (item.status === 'unchanged') {
      lines.push('No visible change was detected.', '');
    } else if (item.status === 'error') {
      lines.push(`Error: ${item.error}`, '');
    }
  }

  lines.push('---');
  lines.push(`Changed requests: ${changed.map((item) => item.requestId).join(', ') || 'none'}`);
  lines.push(`Errors: ${errors.map((item) => item.requestId).join(', ') || 'none'}`);
  return `${lines.join('\n')}\n`;
}

let browserBundle;
const results = [];
try {
  browserBundle = await createBrowser();
  for (const target of TARGETS) {
    try {
      const current = await inspectTarget(browserBundle.context, target, browserBundle.mode);
      const previous = await readPrevious(target.requestId);
      let status = 'unchanged';
      let diff = { added: [], removed: [] };

      if (!previous) status = 'baseline';
      else if (previous.contentHash !== current.contentHash) {
        status = 'changed';
        diff = lineDiff(previous.text, current.text);
      }

      await saveSnapshot(current);
      results.push({
        requestId: target.requestId,
        url: target.url,
        status,
        diff,
        screenshot: current.screenshot,
        previousHash: previous?.contentHash || null,
        currentHash: current.contentHash,
      });
    } catch (error) {
      results.push({
        requestId: target.requestId,
        url: target.url,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  await browserBundle?.browser?.close().catch(() => {});
}

const hasChanges = results.some((item) => item.status === 'changed');
const hasErrors = results.some((item) => item.status === 'error');
const baselineCreated = results.some((item) => item.status === 'baseline');
const shouldNotify = hasChanges || hasErrors || FORCE_NOTIFY;
const report = buildReport(results, browserBundle?.mode || 'unavailable', browserBundle?.sessionId || null);

await fs.writeFile(REPORT_PATH, report, 'utf8');
await fs.writeFile(RESULT_PATH, `${JSON.stringify({
  checkedAt: new Date().toISOString(),
  mode: browserBundle?.mode || 'unavailable',
  hasChanges,
  hasErrors,
  baselineCreated,
  shouldNotify,
  results,
}, null, 2)}\n`, 'utf8');

if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8');
if (process.env.GITHUB_OUTPUT) {
  const changedIds = results.filter((item) => item.status === 'changed').map((item) => item.requestId).join(',');
  await fs.appendFile(process.env.GITHUB_OUTPUT, [
    `has_changes=${hasChanges}`,
    `has_errors=${hasErrors}`,
    `baseline_created=${baselineCreated}`,
    `should_notify=${shouldNotify}`,
    `changed_ids=${changedIds}`,
  ].join('\n') + '\n', 'utf8');
}

console.log(report);
if (hasErrors) process.exitCode = 2;
