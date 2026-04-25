import { fetchInsights, postExecSummary } from './lib/budgetplay-api.js';

const $ = (sel) => document.querySelector(sel);

const fmtMoney = (n) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
};

let cached = null;
let selectedKey = 'global';

async function load() {
  const errEl = $('#loadError');
  errEl.classList.add('hidden');
  try {
    cached = await fetchInsights();
    if (cached.error) throw new Error(cached.error);
    render();
  } catch (e) {
    errEl.textContent = `Could not load insights: ${e.message}`;
    errEl.classList.remove('hidden');
  }
}

function render() {
  if (!cached) return;
  const d = cached;
  $('#kpiVoices').textContent = d.totalSubmissions.toLocaleString();
  $('#kpiCity').textContent = d.city || '—';
  $('#kpiFy').textContent = d.fiscalYear || '';
  $('#kpiTotal').textContent = fmtMoney(d.totalBudget || 0);

  const chips = $('#regionChips');
  chips.innerHTML = '';

  const mkChip = (key, label, count, active) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.key = key;
    b.className = `px-3 py-2 rounded-lg text-sm border transition ${
      active
        ? 'bg-cyan-900/50 border-cyan-500 text-cyan-100'
        : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:border-slate-500'
    }`;
    b.innerHTML = `<span class="font-medium">${label}</span> <span class="text-slate-500 text-xs">(${count})</span>`;
    b.addEventListener('click', () => {
      selectedKey = key;
      render();
    });
    chips.appendChild(b);
  };

  mkChip('global', 'All regions', d.global.submissionCount, selectedKey === 'global');
  for (const r of d.byRegion) {
    mkChip(r.regionId, r.shortLabel, r.submissionCount, selectedKey === r.regionId);
  }

  const segment =
    selectedKey === 'global'
      ? d.global
      : d.byRegion.find((r) => r.regionId === selectedKey) || d.global;

  $('#segmentLabel').textContent =
    selectedKey === 'global' ? 'All regions combined' : segment.label || segment.shortLabel;

  const recList = $('#recList');
  recList.innerHTML = '';
  for (const line of segment.recommendations || []) {
    const li = document.createElement('li');
    li.textContent = line;
    recList.appendChild(li);
  }

  const tbody = $('#priorityTable');
  tbody.innerHTML = '';
  for (const p of segment.priorities || []) {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-800/80';
    const delta = p.deltaPctPoints;
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(2);
    const deltaClass =
      Math.abs(delta) < 0.05 ? 'text-slate-500' : delta > 0 ? 'text-emerald-400' : 'text-rose-400';
    tr.innerHTML = `
      <td class="py-2.5 pr-4">
        <span class="inline-block w-2 h-2 rounded-sm mr-1 align-middle" style="background:${p.color || '#64748b'}"></span>
        ${p.name}
      </td>
      <td class="py-2.5 pr-4"><span class="fund-tag ${String(p.fundType).toLowerCase()}">${p.fundType}</span></td>
      <td class="py-2.5 pr-4 text-right font-mono text-slate-400">${p.officialPct.toFixed(1)}%</td>
      <td class="py-2.5 pr-4 text-right font-mono">${p.communityPct.toFixed(1)}%</td>
      <td class="py-2.5 text-right font-mono ${deltaClass}">${deltaStr}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ----- AI Exec Readout -----
async function generateExecSummary() {
  const btn = $('#execBtn');
  const summaryEl = $('#execSummary');
  const metaEl = $('#execMeta');
  btn.disabled = true;
  const previous = summaryEl.textContent;
  summaryEl.textContent = 'Drafting…';
  metaEl.textContent = '';
  try {
    const json = await postExecSummary({ regionId: selectedKey });
    summaryEl.textContent = json.summary || '(empty)';
    metaEl.textContent = json.cached
      ? 'Cached result · click again on another region for a fresh draft'
      : 'Generated just now';
  } catch (e) {
    summaryEl.textContent = previous;
    metaEl.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

$('#execBtn').addEventListener('click', generateExecSummary);
$('#refreshBtn').addEventListener('click', load);
load();
