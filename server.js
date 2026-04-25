// BudgetPlay — Express server
// Endpoints:
//   GET  /api/budget       -> sample city budget JSON
//   GET  /api/regions      -> region catalog for submissions & filtering
//   POST /api/analyze      -> Claude impact narrative for a reallocation
//   POST /api/submit       -> persist citizen vote (JSON file) + region (rate-limited)
//   GET  /api/community    -> aggregated averages (?region=id optional)
//   GET  /api/insights     -> gov-facing: by-region priorities vs official + recommendations
//   POST /api/letter       -> Claude drafts a personalized letter to council member
//   POST /api/exec-summary -> Claude one-paragraph executive readout per region (cached)

import express from 'express';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const BUDGET_PATH = path.join(DATA_DIR, 'budget.json');
const REGIONS_PATH = path.join(DATA_DIR, 'regions.json');
const SUBMISSIONS_PATH = path.join(DATA_DIR, 'submissions.json');

app.use(express.json({ limit: '25mb' })); // 25mb so PDF base64 payloads fit

// CORS: allows GitHub Pages (or any origin) to call this API if BUDGETPLAY_API_BASE is set in public/config.js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Same JSON paths as GitHub Pages static build (public/lib/budgetplay-api.js)
app.get('/data/budget.json', (req, res) => {
  try {
    const raw = fs.readFileSync(BUDGET_PATH, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).send('{}');
  }
});
app.get('/data/regions.json', (req, res) => {
  try {
    const raw = fs.readFileSync(REGIONS_PATH, 'utf8');
    res.type('application/json').send(raw);
  } catch {
    res.status(404).send('[]');
  }
});

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

if (!client) {
  console.warn('⚠️  No ANTHROPIC_API_KEY in .env — running in demo mode (mock narratives).');
}

// ----- persistence -----
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadRegions() {
  return readJsonSafe(REGIONS_PATH, []);
}

function loadBudgetDoc() {
  return readJsonSafe(BUDGET_PATH, null);
}

function loadSubmissionsFromDisk() {
  const doc = readJsonSafe(SUBMISSIONS_PATH, { submissions: [] });
  return Array.isArray(doc.submissions) ? doc.submissions : [];
}

function saveSubmissionsToDisk(submissions) {
  const tmp = `${SUBMISSIONS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ submissions }, null, 2), 'utf8');
  fs.renameSync(tmp, SUBMISSIONS_PATH);
}

/** In-memory mirror; kept in sync with disk on each mutating op */
let submissions = loadSubmissionsFromDisk();

// ----- per-IP rate limit (in-memory, demo-grade) -----
const RATE_WINDOW_MS = 8_000;
const recentSubmits = new Map(); // ip -> last submit timestamp
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
function rateLimitSubmit(req, res, next) {
  const ip = clientIp(req);
  const last = recentSubmits.get(ip) || 0;
  const now = Date.now();
  if (now - last < RATE_WINDOW_MS) {
    const wait = Math.ceil((RATE_WINDOW_MS - (now - last)) / 1000);
    return res.status(429).json({
      ok: false,
      error: `Slow down — try again in ${wait}s. (Prevents one device from flooding the heatmap.)`,
    });
  }
  recentSubmits.set(ip, now);
  next();
}

// ----- exec summary cache (regionId -> { at, text }) -----
const execSummaryCache = new Map();
const EXEC_TTL_MS = 5 * 60_000; // 5-minute TTL keeps demo cheap & fast

// ----- helpers -----
const fmtMoney = (n) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};

function regionById(id) {
  return loadRegions().find((r) => r.id === id) || null;
}

function averageBudgetForSubs(subs, totalBudget) {
  if (!subs.length) return { count: 0, averages: [], byId: {} };
  const sums = {};
  for (const sub of subs) {
    for (const cat of sub.budget) {
      sums[cat.id] = (sums[cat.id] || 0) + cat.amount;
    }
  }
  const averages = Object.entries(sums).map(([id, total]) => ({
    id,
    avgAmount: total / subs.length,
  }));
  const byId = Object.fromEntries(averages.map((a) => [a.id, a.avgAmount]));
  return { count: subs.length, averages, byId, totalBudget };
}

function buildPriorityRows(officialCategories, avgById, totalBudget) {
  const rows = officialCategories.map((c) => {
    const officialPct = (c.amount / totalBudget) * 100;
    const avg = avgById[c.id] ?? c.amount;
    const communityPct = (avg / totalBudget) * 100;
    const deltaPctPoints = communityPct - officialPct;
    return {
      id: c.id,
      name: c.name,
      fundType: c.fundType,
      color: c.color,
      officialAmount: c.amount,
      officialPct,
      communityAvgAmount: avg,
      communityPct,
      deltaPctPoints,
    };
  });
  rows.sort((a, b) => Math.abs(b.deltaPctPoints) - Math.abs(a.deltaPctPoints));
  return rows;
}

function governmentRecommendations(regionLabel, count, priorities, topN = 4) {
  if (count === 0) {
    return [
      'No submissions from this segment yet — share the simulator to collect a signal.',
    ];
  }
  const recs = [];
  const increases = priorities.filter((p) => p.deltaPctPoints > 0.15).slice(0, topN);
  const decreases = priorities.filter((p) => p.deltaPctPoints < -0.15).slice(0, topN);

  if (increases.length) {
    const parts = increases.map(
      (p) =>
        `${p.name} (+${p.deltaPctPoints.toFixed(1)} pp vs official, ~${fmtMoney(p.communityAvgAmount - p.officialAmount)} / yr in this model)`
    );
    recs.push(
      `${regionLabel}: among ${count} participant${count === 1 ? '' : 's'}, the strongest reallocations toward: ${parts.join('; ')}. Consider public forums or line-item surveys on these areas.`
    );
  }
  if (decreases.length) {
    const parts = decreases.map(
      (p) =>
        `${p.name} (${p.deltaPctPoints.toFixed(1)} pp vs official)`
    );
    recs.push(
      `Participants shifted away from: ${parts.join('; ')}. If those cuts conflict with mandates (restricted funds, state requirements), use this as a cue to explain constraints—not to treat sliders as binding policy.`
    );
  }
  recs.push(
    'Tradeoff reminder: every gain in one category is funded from others in this zero-sum exercise. Pair these signals with service-level data (wait times, backlog, bond covenants) before acting.'
  );
  return recs;
}

function insightsPayload() {
  const budget = loadBudgetDoc();
  if (!budget) {
    return { error: 'Budget data missing', totalSubmissions: 0, regions: [], global: null, byRegion: [] };
  }
  const { totalBudget, categories, city, fiscalYear } = budget;
  const regions = loadRegions();
  const all = submissions;

  const global = averageBudgetForSubs(all, totalBudget);
  const globalPriorities = buildPriorityRows(categories, global.byId, totalBudget);

  const byRegion = regions.map((r) => {
    const subs = all.filter((s) => s.regionId === r.id);
    const { count, byId } = averageBudgetForSubs(subs, totalBudget);
    const priorities = buildPriorityRows(categories, count ? byId : Object.fromEntries(categories.map((c) => [c.id, c.amount])), totalBudget);
    const recommendations = governmentRecommendations(r.label, count, priorities);
    return {
      regionId: r.id,
      label: r.label,
      shortLabel: r.shortLabel || r.label,
      submissionCount: count,
      priorities,
      recommendations,
    };
  });

  return {
    generatedAt: Date.now(),
    city,
    fiscalYear,
    totalBudget,
    totalSubmissions: all.length,
    regions,
    global: {
      submissionCount: global.count,
      priorities: globalPriorities,
      averages: global.averages,
      recommendations: governmentRecommendations('All regions combined', global.count, globalPriorities),
    },
    byRegion,
  };
}

// ----- routes -----
app.get('/api/budget', (req, res) => {
  const data = readJsonSafe(BUDGET_PATH, null);
  if (!data) return res.status(500).json({ error: 'budget.json missing' });
  res.json(data);
});

app.get('/api/regions', (req, res) => {
  res.json({ regions: loadRegions() });
});

app.post('/api/analyze', async (req, res) => {
  const { original = [], modified = [], totalBudget = 0, context = {} } = req.body;

  const threshold = totalBudget * 0.001;
  const changes = [];
  for (const cat of modified) {
    const orig = original.find((o) => o.id === cat.id);
    if (!orig) continue;
    const diff = cat.amount - orig.amount;
    if (Math.abs(diff) >= threshold) {
      changes.push({
        category: cat.name,
        fundType: orig.fundType,
        from: orig.amount,
        to: cat.amount,
        diff,
        pctChange: ((diff / orig.amount) * 100).toFixed(1),
      });
    }
  }

  if (changes.length === 0) {
    return res.json({
      narrative: 'Move some sliders to redirect funds — Claude will analyze the tradeoffs in real time.',
      changes: [],
    });
  }

  if (!client) {
    const summary = changes
      .map((c) => `• ${c.category}: ${c.diff > 0 ? '+' : ''}${fmtMoney(c.diff)} (${c.pctChange}%)`)
      .join('\n');
    return res.json({
      narrative:
        `[DEMO MODE — add ANTHROPIC_API_KEY to .env for live AI analysis]\n\nReallocations registered:\n${summary}\n\nIn live mode, Claude would explain each tradeoff with concrete consequences (response times, units of housing funded, infrastructure backlog) and suggest creative alternatives like dedicated taxes or public-private partnerships.`,
      changes,
    });
  }

  const systemPrompt = `You are a non-partisan City Budget Analyst writing for an everyday citizen using a participatory budgeting simulator. Your job is to make trade-offs concrete, not abstract.

Rules:
- Be realistic about what things actually cost (1 affordable housing unit ≈ $250–400K to build, 1 patrol officer ≈ $150K/yr fully loaded, 1 mile of road repaving ≈ $1–3M, etc.)
- ALWAYS quantify consequences in human terms (e.g., "this funds 200 housing units" or "response times would rise by ~3 minutes in outer zones")
- Acknowledge BOTH the upside and the cost — never one-sided
- Flag legal constraints when relevant (Restricted funds can't always be moved freely — debt service, federal grants, bond proceeds)
- Suggest ONE creative alternative (a dedicated tax, public-private partnership, phased implementation, etc.)
- Stay non-partisan — no ideological framing
- Write 4-6 sentences in plain English. No bullet lists, no headers.`;

  const userPrompt = `City: ${context.city || 'Sample City'}, FY ${context.fiscalYear || ''}
Population: ${context.population?.toLocaleString() || 'unknown'}
Total budget: ${fmtMoney(totalBudget)}

The citizen has made these reallocations:
${changes.map((c) => `- ${c.category} (${c.fundType} fund): ${fmtMoney(c.from)} → ${fmtMoney(c.to)}  [${c.diff > 0 ? '+' : ''}${fmtMoney(c.diff)}, ${c.pctChange}%]`).join('\n')}

Write the impact narrative.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const narrative = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    res.json({ narrative, changes });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({
      error: 'Claude API call failed',
      detail: err.message,
      narrative: `[Error contacting Claude — ${err.message}]`,
      changes,
    });
  }
});

app.post('/api/submit', rateLimitSubmit, (req, res) => {
  const { budget, regionId } = req.body;
  if (!Array.isArray(budget) || budget.length === 0) {
    return res.status(400).json({ ok: false, error: 'Invalid budget payload' });
  }
  if (!regionId || typeof regionId !== 'string') {
    return res.status(400).json({ ok: false, error: 'regionId is required — pick where you live / vote from.' });
  }
  const reg = regionById(regionId);
  if (!reg) {
    return res.status(400).json({ ok: false, error: 'Unknown regionId' });
  }

  const budgetDoc = loadBudgetDoc();
  const expectedIds = new Set((budgetDoc?.categories || []).map((c) => c.id));
  const gotIds = new Set(budget.map((c) => c.id));
  if (expectedIds.size && (gotIds.size !== expectedIds.size || [...expectedIds].some((id) => !gotIds.has(id)))) {
    return res.status(400).json({ ok: false, error: 'Budget must include every category from the simulator.' });
  }

  const entry = {
    at: Date.now(),
    regionId: reg.id,
    regionLabel: reg.label,
    budget: budget.map((c) => ({ id: c.id, amount: c.amount })),
  };
  submissions.push(entry);
  try {
    saveSubmissionsToDisk(submissions);
  } catch (e) {
    console.error('Failed to persist submissions:', e);
    submissions.pop();
    return res.status(500).json({ ok: false, error: 'Could not save submission' });
  }

  res.json({
    ok: true,
    count: submissions.length,
    regionId: reg.id,
    regionLabel: reg.label,
  });
});

function communityResponse(regionId) {
  const list = regionId ? submissions.filter((s) => s.regionId === regionId) : submissions;
  if (list.length === 0) {
    return { count: 0, regionId: regionId || null, averages: [] };
  }
  const budget = loadBudgetDoc();
  const totalBudget = budget?.totalBudget ?? 0;
  const { averages } = averageBudgetForSubs(list, totalBudget);
  return { count: list.length, regionId: regionId || null, averages };
}

app.get('/api/community', (req, res) => {
  const regionId = typeof req.query.region === 'string' ? req.query.region : null;
  if (regionId && !regionById(regionId)) {
    return res.status(400).json({ error: 'Unknown region' });
  }
  res.json(communityResponse(regionId));
});

app.get('/api/insights', (req, res) => {
  res.json(insightsPayload());
});

// ----- PDF budget importer (Claude vision on PDF) -----
app.post('/api/import-budget-pdf', async (req, res) => {
  const { filename = 'uploaded.pdf', pdf } = req.body || {};
  if (!pdf || typeof pdf !== 'string') {
    return res.status(400).json({ error: 'Missing PDF data (expect base64 string in `pdf` field).' });
  }
  if (!client) {
    return res.status(400).json({ error: 'PDF import needs ANTHROPIC_API_KEY in .env.' });
  }

  const sys = `You extract structured city budget data from PDFs. Return ONLY valid JSON — no preamble, no commentary, no markdown fences.

Required output schema:
{
  "city": "<city name with state, e.g. 'Austin, TX'>",
  "fiscalYear": "<e.g. 'FY 2025' or '2025 (Adopted)'>",
  "totalBudget": <number, total dollars>,
  "categories": [
    {
      "id": "<unique-kebab-case-slug>",
      "name": "<readable category name>",
      "amount": <number, dollars>,
      "fundType": "General" | "Restricted",
      "color": "<hex color string>"
    }
  ],
  "context": {
    "population": <number or null>,
    "perCapita": <number or null>,
    "notes": "<one short sentence>"
  }
}

Rules:
- Aggregate fine-grained line items into 8-15 broad readable categories (Public Safety, Education, Transportation, Housing, Health, Sanitation, Parks, Admin, Debt Service, etc.)
- All category amounts must SUM to totalBudget. If the PDF doesn't perfectly add up, normalize and note in context.notes.
- Mark Debt Service, Pension contributions, and federal/state grant pass-throughs as "Restricted". General operations are "General".
- Pick distinctive hex colors per category (e.g. #3b82f6, #ef4444, #8b5cf6, #f59e0b, #10b981, #ec4899, #06b6d4, #a855f7, #64748b).
- IDs must be unique lowercase kebab-case slugs.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: sys,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf },
            },
            {
              type: 'text',
              text: `Extract the city's budget from this PDF (filename: ${filename}). Return ONLY the JSON object — no markdown fences, no commentary.`,
            },
          ],
        },
      ],
    });

    const txt = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    // strip optional ```json fences if Claude added them despite instructions
    const cleaned = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({
        error: 'Claude returned non-JSON. Try a more standard budget PDF.',
        raw: cleaned.slice(0, 1500),
      });
    }

    if (!Array.isArray(parsed.categories) || parsed.categories.length < 3) {
      return res.status(500).json({ error: 'No usable categories found in PDF.' });
    }

    // Re-derive total if missing or off
    const sum = parsed.categories.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    if (!parsed.totalBudget || Math.abs(parsed.totalBudget - sum) / sum > 0.05) {
      parsed.totalBudget = sum;
    }

    // Normalize so amounts EXACTLY sum to totalBudget (UI assumes this)
    const scale = parsed.totalBudget / sum;
    parsed.categories.forEach((c) => (c.amount = c.amount * scale));

    // Backfill missing color/fundType to keep UI consistent
    const palette = ['#3b82f6','#ef4444','#8b5cf6','#f59e0b','#10b981','#ec4899','#22c55e','#06b6d4','#a855f7','#64748b','#f97316','#475569','#84cc16'];
    parsed.categories.forEach((c, i) => {
      if (!c.color) c.color = palette[i % palette.length];
      if (!c.fundType) c.fundType = 'General';
      if (!c.id) c.id = (c.name || `cat-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    });

    // Save as the new official budget
    fs.writeFileSync(BUDGET_PATH, JSON.stringify(parsed, null, 2), 'utf8');

    // Old submissions had different category IDs — archive then clear
    if (submissions.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(DATA_DIR, `submissions-archive-${stamp}.json`);
      fs.writeFileSync(archivePath, JSON.stringify({ submissions }, null, 2), 'utf8');
    }
    submissions = [];
    saveSubmissionsToDisk(submissions);
    execSummaryCache.clear();

    res.json({
      ok: true,
      budget: parsed,
      message: `Imported ${parsed.city} (${parsed.categories.length} categories, ${fmtMoney(parsed.totalBudget)} total). Previous submissions archived.`,
    });
  } catch (err) {
    console.error('PDF import error:', err);
    res.status(500).json({ error: err.message || 'PDF import failed' });
  }
});

// ----- Civic letter generator (Claude) -----
app.post('/api/letter', async (req, res) => {
  const { regionId, budget = [], narrative = '' } = req.body || {};
  const reg = regionId ? regionById(regionId) : null;
  const budgetDoc = loadBudgetDoc();
  if (!budgetDoc) return res.status(500).json({ error: 'Missing budget doc' });

  const total = budgetDoc.totalBudget;
  const threshold = total * 0.002;
  const changes = [];
  for (const c of budgetDoc.categories) {
    const usr = budget.find((b) => b.id === c.id);
    if (!usr) continue;
    const diff = usr.amount - c.amount;
    if (Math.abs(diff) >= threshold) {
      changes.push({
        category: c.name,
        fundType: c.fundType,
        from: c.amount,
        to: usr.amount,
        diff,
      });
    }
  }

  if (!changes.length) {
    return res.json({
      letter: 'Move some sliders first — Claude needs at least one meaningful reallocation to draft a letter.',
    });
  }

  if (!client) {
    const summary = changes
      .map((c) => `- ${c.category}: ${c.diff > 0 ? '+' : ''}${fmtMoney(c.diff)}`)
      .join('\n');
    return res.json({
      letter: `[DEMO MODE — add ANTHROPIC_API_KEY for an AI-drafted letter]

Subject: Reallocating priorities for ${budgetDoc.city}

Dear Council Member,

As a constituent of ${reg?.label || 'this region'}, I used the BudgetPlay simulator to think through our city's tradeoffs. The reallocations I would prioritize:
${summary}

Please consider these signals as part of public input. Thank you.

— A constituent`,
    });
  }

  const sysPrompt = `You are drafting a civic letter on behalf of a citizen who used a participatory budgeting simulator. Turn their slider movements into a respectful, specific, persuasive letter to their elected representative.

Rules:
- Open with a "Subject:" line on its own
- Address it to "Dear Council Member,"
- Mention the city by name and the citizen's region
- Reference 2-4 specific reallocations with concrete dollar amounts
- Anchor at least one reallocation in a real-world consequence (housing units funded, response times, miles repaired, etc.)
- If any Restricted-fund categories appear, briefly acknowledge legal limits on reallocation
- Make ONE specific ask (not vague — e.g., "I urge you to fund a $15M pilot…" or "Please raise this at the next budget hearing.")
- 180-240 words, two paragraphs, plain language, non-partisan
- Sign as "— A concerned constituent" (the user will replace with their name)

Output ONLY the letter text. No preamble, no commentary.`;

  const userPrompt = `City: ${budgetDoc.city}, FY ${budgetDoc.fiscalYear}
Region: ${reg?.label || 'unspecified'}
Total budget: ${fmtMoney(total)}

The citizen's reallocations:
${changes.map((c) => `- ${c.category} (${c.fundType} fund): ${fmtMoney(c.from)} → ${fmtMoney(c.to)} [${c.diff > 0 ? '+' : ''}${fmtMoney(c.diff)}]`).join('\n')}

${narrative ? `Their reasoning (from the impact analysis they read):\n${narrative}\n` : ''}
Draft the letter.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system: sysPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const letter = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    res.json({ letter, changes });
  } catch (err) {
    console.error('Letter API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----- Executive summary for gov dashboard (Claude, cached) -----
app.post('/api/exec-summary', async (req, res) => {
  const { regionId = 'global' } = req.body || {};
  const cached = execSummaryCache.get(regionId);
  if (cached && Date.now() - cached.at < EXEC_TTL_MS) {
    return res.json({ summary: cached.text, cached: true });
  }

  const data = insightsPayload();
  const segment =
    regionId === 'global'
      ? data.global
      : data.byRegion.find((r) => r.regionId === regionId);
  if (!segment) return res.status(404).json({ error: 'Unknown region' });

  const label =
    regionId === 'global'
      ? 'All regions combined'
      : segment.label || segment.shortLabel || regionId;
  const count = segment.submissionCount;

  if (count === 0) {
    return res.json({
      summary: `No submissions yet from ${label}. Once participants from this segment submit budgets, this card will produce a one-paragraph executive readout for your team.`,
      cached: false,
    });
  }

  const top = (segment.priorities || [])
    .filter((p) => Math.abs(p.deltaPctPoints) >= 0.2)
    .slice(0, 6)
    .map(
      (p) =>
        `- ${p.name} (${p.fundType}): official ${p.officialPct.toFixed(1)}% vs community ${p.communityPct.toFixed(1)}% (Δ ${p.deltaPctPoints >= 0 ? '+' : ''}${p.deltaPctPoints.toFixed(2)}pp)`
    )
    .join('\n');

  if (!client) {
    return res.json({
      summary: `[Demo mode — add ANTHROPIC_API_KEY for AI readouts]\n\n${count} participant${count === 1 ? '' : 's'} from ${label}. Top divergences:\n${top}`,
      cached: false,
    });
  }

  const sys = `You are a non-partisan municipal policy analyst writing a one-paragraph executive readout for a council member's chief of staff. The signal comes from a participatory budgeting simulator — treat it as one citizen-input data point, not as binding policy.

Rules:
- 90-130 words, single paragraph
- Lead with the segment label and participant count
- Highlight 2-3 strongest reallocations with percentage points
- Note if any are in Restricted-fund categories (these face legal limits on reallocation)
- End with one sentence on what the chief of staff might do next (forum topic, line-item survey, town hall framing, etc.)
- Plain English, no jargon, no headers, no bullets`;

  const userMsg = `Segment: ${label}
Participants: ${count}
City: ${data.city} FY ${data.fiscalYear}

Top divergences (community vs official):
${top}

Write the executive readout.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
    });
    const summary = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    execSummaryCache.set(regionId, { at: Date.now(), text: summary });
    res.json({ summary, cached: false });
  } catch (err) {
    console.error('Exec summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🏛️  BudgetPlay running on http://localhost:${PORT}`);
  console.log(`   Simulator: /   ·  Gov insights: /insights.html\n`);
});
