/**
 * Builds docs/ for GitHub Pages (static HTML + client bundle + public JSON).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');

const rmrf = (p) => {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
};

rmrf(docs);
fs.mkdirSync(path.join(docs, 'data'), { recursive: true });
fs.mkdirSync(path.join(docs, 'lib'), { recursive: true });

const copy = (from, to) => {
  fs.copyFileSync(from, to);
};

for (const f of ['index.html', 'insights.html', 'styles.css', 'app.js', 'insights.js', 'config.js']) {
  copy(path.join(root, 'public', f), path.join(docs, f));
}
copy(path.join(root, 'public', 'lib', 'budgetplay-api.js'), path.join(docs, 'lib', 'budgetplay-api.js'));

for (const f of ['budget.json', 'regions.json']) {
  copy(path.join(root, 'data', f), path.join(docs, 'data', f));
}

fs.writeFileSync(path.join(docs, '.nojekyll'), '', 'utf8');

console.log('Built', docs, '— commit docs/ and set GitHub Pages source to branch main, folder /docs.');
