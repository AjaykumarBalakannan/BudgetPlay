# BudgetPlay

**Participatory budgeting simulator** — explore how a city-sized budget is allocated, move sliders to rebalance spending, read AI-generated tradeoff narratives, and optionally submit a “vote” grouped by region. A **Government Pulse** dashboard aggregates submissions so you can compare community averages to the official (illustrative) budget.

Built for **Anthropic Hackathon · Track #3: Governance & Accessibility**. Data is **sample / educational**, not an official government budget.

## Features

- **Citizen view** (`/`): pie or bar chart, auto-balancing sliders, per-capita context, General vs Restricted fund labels.
- **Claude impact report**: explains reallocations in plain language (requires `ANTHROPIC_API_KEY`; demo text if unset).
- **Regional submit**: pick a region so submissions roll up for reporting.
- **Gov Pulse** (`/insights.html`): total voices, shifts vs official by category (percentage points), region chips, short recommendation blurbs for leaders.

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

## Author

[Ajaykumar Balakannan](https://github.com/AjaykumarBalakannan)

## License

MIT (or adjust as you prefer.)
