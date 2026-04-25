# BudgetPlay

**Participatory budgeting simulator** — explore how a city-sized budget is allocated, move sliders to rebalance spending, read AI-generated tradeoff narratives, and optionally submit a “vote” grouped by region. A **Government Pulse** dashboard aggregates submissions so you can compare community averages to the official (illustrative) budget.

Built for **Anthropic Hackathon · Track #3: Governance & Accessibility**. Data is **sample / educational**, not an official government budget.

## Features

- **Citizen view** (`/`): pie or bar chart, auto-balancing sliders, per-capita context, General vs Restricted fund labels.
- **Claude impact report**: explains reallocations in plain language (requires `ANTHROPIC_API_KEY`; demo text if unset).
- **Regional submit**: pick a region so submissions roll up for reporting.
- **Gov Pulse** (`insights.html`): total voices, shifts vs official by category (percentage points), region chips, short recommendation blurbs for leaders.

## Quick start

```bash
npm install
cp .env.example .env   # optional: add ANTHROPIC_API_KEY
npm start
```

- Simulator: [http://localhost:3000](http://localhost:3000)  
- Insights: [http://localhost:3000/insights.html](http://localhost:3000/insights.html)

Submissions are stored in `data/submissions.json` (created on first submit; not committed — see `.gitignore`).

## Stack

- Node.js + Express (`server.js`)
- Static frontend: Tailwind (CDN), Chart.js, vanilla JS (`public/`)
- Anthropic Messages API for `/api/analyze`

## API (summary)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/budget` | Illustrative city budget JSON |
| GET | `/api/regions` | Region list for submissions |
| POST | `/api/analyze` | Impact narrative for slider changes |
| POST | `/api/submit` | Save `{ regionId, budget }` (all categories required) |
| GET | `/api/community?region=` | Average allocations (optional region filter) |
| GET | `/api/insights` | Aggregated signals + recommendation text |

## Publishing to GitHub

The repo is not created automatically from this environment. On [GitHub](https://github.com/new):

1. Repository name: **`BudgetPlay`** (owner: **AjaykumarBalakannan**).
2. Leave **empty** (no README, no .gitignore) so the first push matches this history.

Then in your project folder:

```bash
git remote add origin https://github.com/AjaykumarBalakannan/BudgetPlay.git
git push -u origin main
```

Use SSH instead if you prefer: `git@github.com:AjaykumarBalakannan/BudgetPlay.git`.

## GitHub Pages (live demo)

After the repo exists and this code is on `main`, enable **Actions → Pages** once:

1. Repo **Settings** → **Pages** → **Build and deployment** → Source: **GitHub Actions**.
2. Push to `main` (or run the **Deploy GitHub Pages** workflow manually). The workflow runs `npm run build:pages` and publishes the `docs/` output.

**Live site** (replace if your username or repo name differs):

**[https://ajaykumarbalakannan.github.io/BudgetPlay/](https://ajaykumarbalakannan.github.io/BudgetPlay/)**

- **Static mode** (no API key in the browser): sliders, demo-style impact text, Gov Pulse, and votes stored in **localStorage** (per browser—not a shared server database).
- **Full backend**: run `npm start` anywhere, or deploy the Express app and set `window.BUDGETPLAY_API_BASE` in `public/config.js` to that origin (CORS is enabled on the server for API routes).

## Author

[Ajaykumar Balakannan](https://github.com/AjaykumarBalakannan)
