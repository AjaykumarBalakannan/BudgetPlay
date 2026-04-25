// BudgetPlay — frontend logic
// State, sliders, chart, Claude impact narrative, community heatmap.

// ----- helpers -----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmtMoney = (n) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
};

const debounce = (fn, ms = 600) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// ----- state -----
let original = null;       // initial budget snapshot from API
let current  = null;       // mutable working copy
let chart    = null;
let chartType = 'doughnut';

// ----- bootstrap -----
async function init() {
  const [budgetRes, regionsRes] = await Promise.all([
    fetch('/api/budget'),
    fetch('/api/regions'),
  ]);
  const data = await budgetRes.json();
  const { regions = [] } = await regionsRes.json();

  original = JSON.parse(JSON.stringify(data));
  current  = JSON.parse(JSON.stringify(data));

  const sel = $('#regionSelect');
  sel.innerHTML = regions
    .map((r) => `<option value="${r.id}">${r.label}</option>`)
    .join('');
  if (!regions.length) {
    sel.innerHTML = '<option value="">No regions configured</option>';
  }

  $('#cityName').textContent = data.city;
  $('#fyName').textContent   = data.fiscalYear;
  $('#totalBudget').textContent = fmtMoney(data.totalBudget);
  $('#statPerCapita').textContent = fmtMoney(data.context?.perCapita || 0);

  renderSliders();
  renderChart();
  refreshStats();

  // chart toggle
  $$('.chart-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.chart-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartType = btn.dataset.chart;
      renderChart();
    });
  });

  $('#resetBtn').addEventListener('click', resetAll);
  $('#submitBtn').addEventListener('click', openConfirm);
  $('#closeModal').addEventListener('click', () => $('#modal').classList.remove('show'));

  // Confirm modal
  $('#confirmCancel').addEventListener('click', () => $('#confirmModal').classList.remove('show'));
  $('#confirmYes').addEventListener('click', async () => {
    $('#confirmModal').classList.remove('show');
    await submitVote();
  });

  // PDF import
  const openPdfModal = () => $('#pdfModal').classList.add('show');
  const closePdfModal = () => $('#pdfModal').classList.remove('show');
  $('#importPdfBtn')?.addEventListener('click', openPdfModal);
  $('#importPdfBtnMobile')?.addEventListener('click', openPdfModal);
  $('#pdfModalClose').addEventListener('click', closePdfModal);
  $('#pdfCancelBtn').addEventListener('click', closePdfModal);
  $('#pdfImportGo').addEventListener('click', importPdf);

  // Civic letter wiring
  $('#generateLetterBtn').addEventListener('click', () => generateLetter(false));
  $('#regenLetterBtn').addEventListener('click', () => generateLetter(true));
  $('#copyLetterBtn').addEventListener('click', copyLetter);
}

// ----- sliders -----
function renderSliders() {
  const total = current.totalBudget;
  const list = $('#sliders');
  list.innerHTML = '';

  current.categories.forEach(cat => {
    const pct = (cat.amount / total) * 100;
    const row = document.createElement('div');
    row.className = 'slider-row p-3 rounded-lg';
    row.dataset.id = cat.id;
    row.style.setProperty('--cat-color', cat.color);
    row.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-sm" style="background:${cat.color}"></span>
          <span class="font-medium text-sm">${cat.name}</span>
          <span class="fund-tag ${cat.fundType.toLowerCase()}">${cat.fundType}</span>
        </div>
        <div class="text-right">
          <div class="font-mono font-semibold text-sm" data-amount>${fmtMoney(cat.amount)}</div>
          <div class="text-xs text-slate-400" data-pct>${pct.toFixed(1)}%</div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <input type="range" min="0" max="40" step="0.1" value="${pct.toFixed(1)}" class="flex-1" />
        <div class="text-xs text-slate-500 font-mono w-16 text-right" data-delta>—</div>
      </div>
    `;
    const slider = row.querySelector('input[type="range"]');
    slider.addEventListener('input', (e) => onSlide(cat.id, parseFloat(e.target.value)));
    slider.addEventListener('change', () => requestNarrative());  // fire when user releases
    list.appendChild(row);
  });
}

// when user drags slider for cat X to newPct, redistribute the delta proportionally across others
function onSlide(catId, newPct) {
  const total = current.totalBudget;
  const target = current.categories.find(c => c.id === catId);
  const oldPct = (target.amount / total) * 100;
  const deltaPct = newPct - oldPct;
  if (Math.abs(deltaPct) < 0.01) return;

  // redistribute -deltaPct across other cats proportionally to their current share
  const others = current.categories.filter(c => c.id !== catId);
  const othersTotalPct = others.reduce((s, c) => s + (c.amount / total) * 100, 0);
  if (othersTotalPct <= 0) return;

  // apply
  target.amount = (newPct / 100) * total;
  for (const c of others) {
    const cPct = (c.amount / total) * 100;
    const share = cPct / othersTotalPct;
    const newCPct = cPct - deltaPct * share;
    c.amount = Math.max(0, (newCPct / 100) * total);
  }

  // tiny rounding correction so totals match
  const sum = current.categories.reduce((s, c) => s + c.amount, 0);
  const scale = total / sum;
  current.categories.forEach(c => c.amount *= scale);

  syncAllRows();
  updateChart();
  refreshStats();
}

function syncAllRows() {
  const total = current.totalBudget;
  current.categories.forEach(cat => {
    const row = $(`.slider-row[data-id="${cat.id}"]`);
    if (!row) return;
    const orig = original.categories.find(o => o.id === cat.id);
    const pct = (cat.amount / total) * 100;
    row.querySelector('[data-amount]').textContent = fmtMoney(cat.amount);
    row.querySelector('[data-pct]').textContent = `${pct.toFixed(1)}%`;
    const slider = row.querySelector('input[type="range"]');
    if (document.activeElement !== slider) slider.value = pct.toFixed(1);
    const diff = cat.amount - orig.amount;
    const delta = row.querySelector('[data-delta]');
    if (Math.abs(diff) < total * 0.0005) {
      delta.textContent = '—';
      delta.className = 'text-xs text-slate-500 font-mono w-16 text-right';
      row.classList.remove('changed');
    } else {
      const sign = diff > 0 ? '+' : '';
      delta.textContent = `${sign}${fmtMoney(diff)}`;
      delta.className = `text-xs font-mono w-16 text-right ${diff > 0 ? 'text-emerald-400' : 'text-rose-400'}`;
      row.classList.add('changed');
    }
  });
}

function refreshStats() {
  const allocated = current.categories.reduce((s, c) => s + c.amount, 0);
  const remaining = current.totalBudget - allocated;
  const changes = current.categories.filter(c => {
    const orig = original.categories.find(o => o.id === c.id);
    return Math.abs(c.amount - orig.amount) > current.totalBudget * 0.0005;
  }).length;

  $('#statAllocated').textContent = fmtMoney(allocated);
  $('#statRemaining').textContent = fmtMoney(remaining);
  $('#statChanges').textContent = changes;

  // Draft badge: pulses when there are pending uncast changes
  const badge = $('#draftBadge');
  if (badge) {
    if (changes > 0) {
      badge.textContent = `Draft · ${changes} change${changes === 1 ? '' : 's'} not cast`;
      badge.classList.add('dirty');
    } else {
      badge.textContent = 'No changes yet';
      badge.classList.remove('dirty');
    }
  }
}

function resetAll() {
  current = JSON.parse(JSON.stringify(original));
  renderSliders();
  updateChart();
  refreshStats();
  $('#narrative').textContent = 'Move any slider to see Claude analyze the tradeoffs of your reallocation in real time.';
  $('#narrativeStatus').textContent = 'idle';
}

// ----- chart -----
function renderChart() {
  if (chart) chart.destroy();
  const ctx = document.getElementById('budgetChart').getContext('2d');
  const labels = current.categories.map(c => c.name);
  const data = current.categories.map(c => c.amount);
  const colors = current.categories.map(c => c.color);

  const config = {
    type: chartType,
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: '#0f172a',
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: chartType === 'doughnut',
          position: 'right',
          labels: { color: '#cbd5e1', font: { size: 10 }, padding: 8, boxWidth: 10 }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed?.y ?? ctx.parsed;
              const total = current.totalBudget;
              const pct = ((v / total) * 100).toFixed(1);
              return `${ctx.label}: ${fmtMoney(v)} (${pct}%)`;
            }
          }
        }
      },
      scales: chartType === 'bar' ? {
        x: { ticks: { color: '#94a3b8', font: { size: 9 }, maxRotation: 60, minRotation: 45 }, grid: { display: false } },
        y: { ticks: { color: '#94a3b8', callback: (v) => fmtMoney(v) }, grid: { color: '#1e293b' } }
      } : {}
    }
  };
  chart = new Chart(ctx, config);
}

function updateChart() {
  if (!chart) return;
  chart.data.datasets[0].data = current.categories.map(c => c.amount);
  chart.update('none');
}

// ----- Claude narrative -----
const requestNarrative = debounce(async () => {
  const status = $('#narrativeStatus');
  const box = $('#narrative');
  status.textContent = 'analyzing…';
  box.classList.add('narrative-loading');

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original: original.categories.map(c => ({ id: c.id, name: c.name, amount: c.amount, fundType: c.fundType })),
        modified: current.categories.map(c => ({ id: c.id, name: c.name, amount: c.amount, fundType: c.fundType })),
        totalBudget: current.totalBudget,
        context: original.context && original.city ? { ...original.context, city: original.city, fiscalYear: original.fiscalYear } : {},
      })
    });
    const json = await res.json();
    box.textContent = json.narrative || '(no narrative)';
    status.textContent = json.changes?.length ? `${json.changes.length} change(s)` : 'idle';
  } catch (err) {
    box.textContent = `Error: ${err.message}`;
    status.textContent = 'error';
  } finally {
    box.classList.remove('narrative-loading');
  }
}, 700);

// ----- Confirm modal: shown BEFORE actually submitting -----
function openConfirm() {
  const regionId = $('#regionSelect').value;
  if (!regionId) {
    alert('Choose your region so your vote can be grouped for the Government Pulse dashboard.');
    return;
  }

  // Build a human-readable diff list
  const total = current.totalBudget;
  const lines = [];
  current.categories.forEach((cat) => {
    const orig = original.categories.find((o) => o.id === cat.id);
    const diff = cat.amount - orig.amount;
    if (Math.abs(diff) > total * 0.0005) {
      const sign = diff > 0 ? '+' : '−';
      lines.push(`${sign}${fmtMoney(Math.abs(diff))}  ${cat.name}`);
    }
  });

  if (lines.length === 0) {
    if (!confirm('You haven\'t changed anything from the official budget. Cast a "no change" vote anyway?')) return;
  }

  const regionLabel = $('#regionSelect').selectedOptions[0]?.textContent || regionId;
  $('#confirmRegion').textContent = regionLabel;
  $('#confirmChanges').textContent = lines.length ? lines.join('\n') : '(No changes — voting to endorse the official budget as-is)';
  $('#confirmModal').classList.add('show');
}

// ----- Submit vote + community heatmap -----
async function submitVote() {
  const regionId = $('#regionSelect').value;
  if (!regionId) {
    alert('Choose your region so your vote can be grouped for the Government Pulse dashboard.');
    return;
  }

  const btn = $('#submitBtn');
  btn.disabled = true;
  btn.textContent = 'Casting…';
  try {
    const subRes = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        regionId,
        budget: current.categories.map((c) => ({ id: c.id, amount: c.amount })),
      }),
    });
    const subJson = await subRes.json().catch(() => ({}));
    if (!subRes.ok) {
      throw new Error(subJson.error || subRes.statusText);
    }

    const q = new URLSearchParams({ region: regionId });
    const res = await fetch(`/api/community?${q}`);
    const data = await res.json();
    showHeatmap(data, subJson.regionLabel || '');
  } catch (err) {
    alert('Submit failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🗳️ Cast My Vote';
  }
}

function showHeatmap(data, regionLabel = '') {
  const total = current.totalBudget;
  const html = current.categories.map(cat => {
    const orig = original.categories.find(o => o.id === cat.id);
    const community = data.averages.find(a => a.id === cat.id);
    const commAmount = community ? community.avgAmount : orig.amount;
    const officialPct = (orig.amount / total) * 100;
    const commPct = (commAmount / total) * 100;
    const max = Math.max(officialPct, commPct, 1);
    const officialW = (officialPct / max) * 100;
    const commW = (commPct / max) * 100;
    const diff = commPct - officialPct;
    const diffStr = diff >= 0 ? `+${diff.toFixed(1)}%` : `${diff.toFixed(1)}%`;
    const diffColor = Math.abs(diff) < 0.5 ? 'text-slate-500' : diff > 0 ? 'text-emerald-400' : 'text-rose-400';
    return `
      <div class="heat-row">
        <div class="truncate"><span class="inline-block w-2 h-2 rounded-sm mr-1" style="background:${cat.color}"></span>${cat.name}</div>
        <div class="space-y-1">
          <div class="heat-bar"><div class="heat-bar-current" style="width:${officialW}%"></div></div>
          <div class="heat-bar"><div class="heat-bar-community" style="width:${commW}%"></div></div>
        </div>
        <div class="text-right">
          <div class="font-mono ${diffColor} text-xs">${diffStr}</div>
          <div class="text-[10px] text-slate-500">vs official</div>
        </div>
      </div>
    `;
  }).join('');

  const regionLine = regionLabel
    ? `Region: <span class="text-cyan-300 font-medium">${regionLabel}</span> · `
    : '';
  $('#communityCount').innerHTML = `${regionLine}Based on <span class="text-amber-400 font-semibold">${data.count}</span> citizen submission${data.count === 1 ? '' : 's'} in this segment.<br><span class="text-slate-500">Top bar = official budget · Bottom bar = community average · <a href="/insights.html" class="text-cyan-500 hover:underline">Open Gov Pulse</a> for all regions</span>`;
  $('#communityHeatmap').innerHTML = html;
  $('#modal').classList.add('show');
}

// ----- Civic letter generator -----
async function generateLetter(isRegen) {
  const regionId = $('#regionSelect').value;
  if (!regionId) {
    alert('Pick a region first.');
    return;
  }
  const status = $('#letterStatus');
  const ta = $('#letterText');
  const actions = $('#letterActions');
  const btn = $('#generateLetterBtn');

  status.textContent = isRegen ? 're-drafting…' : 'drafting…';
  status.classList.remove('hidden');
  ta.classList.toggle('hidden', !isRegen); // keep visible during re-draft
  actions.classList.toggle('hidden', !isRegen);
  btn.disabled = true;

  try {
    const res = await fetch('/api/letter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        regionId,
        budget: current.categories.map((c) => ({ id: c.id, amount: c.amount })),
        narrative: $('#narrative').textContent || '',
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);

    ta.value = json.letter || '(no letter returned)';
    ta.classList.remove('hidden');
    actions.classList.remove('hidden');
    status.textContent = isRegen ? 're-drafted ✓' : 'draft ready ✓';
    setTimeout(() => status.classList.add('hidden'), 2500);
    btn.textContent = 'Re-draft';
    updateMailLink();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

function updateMailLink() {
  const text = $('#letterText').value || '';
  const lines = text.split('\n');
  let subject = '';
  const bodyLines = [];
  for (const ln of lines) {
    if (!subject && /^subject:/i.test(ln.trim())) {
      subject = ln.replace(/^subject:\s*/i, '').trim();
      continue;
    }
    bodyLines.push(ln);
  }
  if (!subject) subject = 'Constituent input on city budget priorities';
  const href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join('\n').trim())}`;
  $('#emailLetterLink').setAttribute('href', href);
}

async function copyLetter() {
  const text = $('#letterText').value || '';
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('#copyLetterBtn');
    const old = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => (btn.textContent = old), 1500);
  } catch {
    $('#letterText').select();
    document.execCommand('copy');
  }
}

// keep mailto link fresh while user edits
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'letterText') updateMailLink();
});

// ----- PDF import (Claude reads the PDF and rewrites budget.json) -----
async function importPdf() {
  const fileInput = $('#pdfFileInput');
  const status = $('#pdfStatus');
  const goBtn = $('#pdfImportGo');
  const file = fileInput.files?.[0];
  if (!file) { alert('Choose a PDF first.'); return; }
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('That doesn\'t look like a PDF.'); return;
  }
  if (file.size > 20 * 1024 * 1024) {
    alert('PDF is over 20MB — try a smaller version.'); return;
  }

  status.classList.remove('hidden');
  status.textContent = `Reading ${file.name}…`;
  goBtn.disabled = true;

  try {
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Failed to read file'));
      r.readAsDataURL(file);
    });

    status.textContent = 'Sending to Claude — this can take 20-40 seconds for a real city budget…';
    const res = await fetch('/api/import-budget-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, pdf: base64 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);

    status.textContent = `✓ ${json.message || 'Budget imported. Reloading…'}`;
    // Re-hydrate everything from new /api/budget
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    goBtn.disabled = false;
  }
}

// go!
init();
