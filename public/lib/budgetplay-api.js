/**
 * BudgetPlay client API.
 * Remote: set window.BUDGETPLAY_API_BASE (no trailing slash) to your Node server.
 * Static (GitHub Pages): leave unset — uses data/*.json + localStorage for submissions.
 */

const LS_KEY = 'budgetplay_submissions_v1';

export function getApiBase() {
  const b = typeof window !== 'undefined' && window.BUDGETPLAY_API_BASE;
  return (typeof b === 'string' ? b : '').replace(/\/$/, '');
}

export function isRemoteMode() {
  return Boolean(getApiBase());
}

function remoteUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBase()}${p}`;
}

async function fetchStaticJson(relPath) {
  const res = await fetch(relPath);
  if (!res.ok) throw new Error(`Failed to load ${relPath} (${res.status})`);
  return res.json();
}

export function fmtMoneyApi(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
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
        `${p.name} (+${p.deltaPctPoints.toFixed(1)} pp vs official, ~${fmtMoneyApi(p.communityAvgAmount - p.officialAmount)} / yr in this model)`
    );
    recs.push(
      `${regionLabel}: among ${count} participant${count === 1 ? '' : 's'}, the strongest reallocations toward: ${parts.join('; ')}. Consider public forums or line-item surveys on these areas.`
    );
  }
  if (decreases.length) {
    const parts = decreases.map((p) => `${p.name} (${p.deltaPctPoints.toFixed(1)} pp vs official)`);
    recs.push(
      `Participants shifted away from: ${parts.join('; ')}. If those cuts conflict with mandates (restricted funds, state requirements), use this as a cue to explain constraints—not to treat sliders as binding policy.`
    );
  }
  recs.push(
    'Tradeoff reminder: every gain in one category is funded from others in this zero-sum exercise. Pair these signals with service-level data (wait times, backlog, bond covenants) before acting.'
  );
  return recs;
}

function computeInsightsPayload(submissions, budget, regions) {
  if (!budget) {
    return { error: 'Budget data missing', totalSubmissions: 0, regions: [], global: null, byRegion: [] };
  }
  const { totalBudget, categories, city, fiscalYear } = budget;
  const all = submissions;

  const global = averageBudgetForSubs(all, totalBudget);
  const globalPriorities = buildPriorityRows(categories, global.byId, totalBudget);

  const byRegion = regions.map((r) => {
    const subs = all.filter((s) => s.regionId === r.id);
    const { count, byId } = averageBudgetForSubs(subs, totalBudget);
    const priorities = buildPriorityRows(
      categories,
      count ? byId : Object.fromEntries(categories.map((c) => [c.id, c.amount])),
      totalBudget
    );
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

function readLocalSubmissions() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const o = JSON.parse(raw);
    return Array.isArray(o.submissions) ? o.submissions : [];
  } catch {
    return [];
  }
}

function writeLocalSubmissions(subs) {
  localStorage.setItem(LS_KEY, JSON.stringify({ submissions: subs }));
}

function staticAnalyze({ original = [], modified = [], totalBudget = 0 }) {
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
        pctChange: orig.amount ? ((diff / orig.amount) * 100).toFixed(1) : '0.0',
      });
    }
  }

  if (changes.length === 0) {
    return {
      narrative: 'Move some sliders to redirect funds — Claude will analyze the tradeoffs in real time.',
      changes: [],
    };
  }

  const summary = changes
    .map((c) => `• ${c.category}: ${c.diff > 0 ? '+' : ''}${fmtMoneyApi(c.diff)} (${c.pctChange}%)`)
    .join('\n');
  return {
    narrative:
      `[GitHub Pages — static demo]\n\nReallocations registered:\n${summary}\n\nFull Claude narratives, PDF import, and server-wide vote storage require the Node app, or set BUDGETPLAY_API_BASE in config.js to a deployed API. This browser still stores your submissions in localStorage so Gov Pulse works for you on this device.`,
    changes,
  };
}

export async function fetchBudget() {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/budget'));
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  return fetchStaticJson('data/budget.json');
}

export async function fetchRegions() {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/regions'));
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  const regions = await fetchStaticJson('data/regions.json');
  return { regions };
}

export async function postAnalyze(body) {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/analyze'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }
  return staticAnalyze(body);
}

export async function postSubmit(body) {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  const { budget, regionId } = body;
  const { regions } = await fetchRegions();
  const reg = regions.find((r) => r.id === regionId);
  if (!reg) throw new Error('Unknown regionId');

  const budgetDoc = await fetchBudget();
  const expectedIds = new Set((budgetDoc.categories || []).map((c) => c.id));
  const gotIds = new Set(budget.map((c) => c.id));
  if (expectedIds.size && (gotIds.size !== expectedIds.size || [...expectedIds].some((id) => !gotIds.has(id)))) {
    throw new Error('Budget must include every category from the simulator.');
  }

  const subs = readLocalSubmissions();
  subs.push({
    at: Date.now(),
    regionId: reg.id,
    regionLabel: reg.label,
    budget: budget.map((c) => ({ id: c.id, amount: c.amount })),
  });
  writeLocalSubmissions(subs);
  return { ok: true, count: subs.length, regionId: reg.id, regionLabel: reg.label };
}

export async function fetchCommunity(regionId) {
  if (isRemoteMode()) {
    const q = regionId ? `?region=${encodeURIComponent(regionId)}` : '';
    const res = await fetch(remoteUrl(`/api/community${q}`));
    return res.json();
  }

  const subs = readLocalSubmissions();
  const list = regionId ? subs.filter((s) => s.regionId === regionId) : subs;
  const budget = await fetchBudget();
  const totalBudget = budget.totalBudget ?? 0;
  if (!list.length) return { count: 0, regionId: regionId || null, averages: [] };

  const sums = {};
  for (const sub of list) {
    for (const cat of sub.budget) {
      sums[cat.id] = (sums[cat.id] || 0) + cat.amount;
    }
  }
  const averages = Object.entries(sums).map(([id, total]) => ({
    id,
    avgAmount: total / list.length,
  }));
  return { count: list.length, regionId: regionId || null, averages };
}

export async function fetchInsights() {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/insights'));
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  const budget = await fetchBudget();
  const { regions } = await fetchRegions();
  const subs = readLocalSubmissions();
  return computeInsightsPayload(subs, budget, regions);
}

export async function postLetter(body) {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/letter'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  const budgetDoc = await fetchBudget();
  const { regions } = await fetchRegions();
  const { regionId, budget = [] } = body || {};
  const reg = regionId ? regions.find((r) => r.id === regionId) : null;
  const total = budgetDoc.totalBudget;
  const threshold = total * 0.002;
  const changes = [];
  for (const c of budgetDoc.categories) {
    const usr = budget.find((b) => b.id === c.id);
    if (!usr) continue;
    const diff = usr.amount - c.amount;
    if (Math.abs(diff) >= threshold) {
      changes.push({ category: c.name, fundType: c.fundType, from: c.amount, to: usr.amount, diff });
    }
  }

  if (!changes.length) {
    return {
      letter: 'Move some sliders first — the letter needs at least one meaningful reallocation.',
    };
  }

  const summary = changes.map((c) => `- ${c.category}: ${c.diff > 0 ? '+' : ''}${fmtMoneyApi(c.diff)}`).join('\n');
  return {
    letter: `[GitHub Pages — static demo]

Subject: Reallocating priorities for ${budgetDoc.city}

Dear Council Member,

As a constituent of ${reg?.label || 'this region'}, I used the BudgetPlay simulator to think through our city's tradeoffs. The reallocations I would prioritize:
${summary}

Please consider these signals as part of public input. Thank you.

— A constituent`,
  };
}

export async function postExecSummary(body) {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/exec-summary'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  const data = await fetchInsights();
  const { regionId = 'global' } = body || {};
  const segment =
    regionId === 'global' ? data.global : data.byRegion.find((r) => r.regionId === regionId);
  if (!segment) throw new Error('Unknown region');

  const label =
    regionId === 'global' ? 'All regions combined' : segment.label || segment.shortLabel || regionId;
  const count = segment.submissionCount;

  if (count === 0) {
    return {
      summary: `No submissions yet from ${label}. Once participants from this segment submit budgets, this card can summarize divergences from the official model.`,
      cached: false,
    };
  }

  const top = (segment.priorities || [])
    .filter((p) => Math.abs(p.deltaPctPoints) >= 0.2)
    .slice(0, 6)
    .map(
      (p) =>
        `- ${p.name} (${p.fundType}): official ${p.officialPct.toFixed(1)}% vs community ${p.communityPct.toFixed(1)}% (Δ ${p.deltaPctPoints >= 0 ? '+' : ''}${p.deltaPctPoints.toFixed(2)}pp)`
    )
    .join('\n');

  return {
    summary: `[GitHub Pages — static demo]\n\n${count} participant${count === 1 ? '' : 's'} from ${label}. Top divergences vs the illustrative official budget:\n${top}\n\nFor an AI-written executive paragraph, deploy the Node server or point config.js at your API.`,
    cached: false,
  };
}

export async function postImportPdf(body) {
  if (isRemoteMode()) {
    const res = await fetch(remoteUrl('/api/import-budget-pdf'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }
  throw new Error('PDF import requires the Node server (not available in static GitHub Pages mode).');
}
