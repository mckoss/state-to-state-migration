// Checks the Census Bureau source URLs for new or revised data and updates the
// local copies in data/raw/. Run monthly by .github/workflows/update-data.yml,
// or by hand: `npm run fetch`. The site itself never fetches from census.gov.
//
// - ACS state-to-state tables: every single-year table linked from PAGE.
// - Population estimates: the current vintage, plus the next one if published.
//
// Prints a summary and, under GitHub Actions, sets the step outputs
// `changed` (true/false) and `summary`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestPopestFile } from './build-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const SOURCES = path.join(RAW, 'sources.json');
export const PAGE = 'https://www.census.gov/data/tables/time-series/demo/geographic-mobility/state-to-state-migration.html';
const POPEST_BASE = 'https://www2.census.gov/programs-surveys/popest/datasets';
const UA = 'state-to-state-migration data refresh (+https://github.com/mckoss/state-to-state-migration)';

async function get(url, { allow404 = false } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Single-year ACS table links on the Census page: [{ year, ext, url }]. */
export function acsLinks(html) {
  const re = /\/\/www2\.census\.gov\/[^"']*?\/geographic-mobility\/(\d{4})\/state-to-state-migration\/state_to_state_migrations?_table_\d{4}[^"'/]*?\.(xlsx?)/gi;
  const byYear = new Map();
  for (const m of html.matchAll(re)) {
    const name = m[0].split('/').pop();
    // Skip multi-year tables such as ..._table_2005_2007.xls.
    if (/_table_\d{4}_\d{4}/i.test(name)) continue;
    byYear.set(Number(m[1]), { year: Number(m[1]), ext: m[2].toLowerCase(), url: `https:${m[0]}` });
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Reject error pages served with HTTP 200 (e.g. a bot-check HTML page). */
function looksValid(name, buf) {
  if (name.endsWith('.xls')) return buf.subarray(0, 4).toString('hex') === 'd0cf11e0';
  if (name.endsWith('.xlsx')) return buf.subarray(0, 2).toString() === 'PK';
  if (name.endsWith('.csv')) return buf.subarray(0, 6).toString() === 'SUMLEV';
  return false;
}

function readSources() {
  return fs.existsSync(SOURCES) ? JSON.parse(fs.readFileSync(SOURCES, 'utf8')) : {};
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const sources = readSources();
  const changes = [];

  // Saves buf as data/raw/<rel> if it is new or different. Returns true if written.
  const save = (rel, url, buf, label) => {
    if (!looksValid(rel, buf)) throw new Error(`${url}: response is not a valid ${path.extname(rel)} file`);
    const file = path.join(RAW, rel);
    const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!sources[rel] || sources[rel].url !== url) sources[rel] = { url, retrieved: today };
    if (old && old.equals(buf)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    sources[rel] = { url, retrieved: today };
    changes.push(`${old ? 'Updated' : 'Added'} ${label}`);
    return true;
  };

  // ACS tables.
  const html = (await get(PAGE)).toString('utf8');
  const links = acsLinks(html);
  const acsDir = path.join(RAW, 'acs');
  const existing = fs.existsSync(acsDir) ? fs.readdirSync(acsDir).filter((f) => /^acs1_\d{4}\.xlsx?$/.test(f)) : [];
  if (links.length < existing.length) {
    throw new Error(`Found ${links.length} ACS tables on the Census page but ${existing.length} locally; the page layout may have changed`);
  }
  for (const { year, ext, url } of links) {
    const rel = `acs/acs1_${year}.${ext}`;
    save(rel, url, await get(url), `ACS ${year} state-to-state table`);
    // A table re-released in another format replaces the old file.
    for (const f of existing) {
      if (f.startsWith(`acs1_${year}.`) && `acs/${f}` !== rel) {
        fs.rmSync(path.join(acsDir, f));
        delete sources[`acs/${f}`];
      }
    }
  }

  // Population estimates: re-check the current vintage, then probe the next.
  const popDir = path.join(RAW, 'popest');
  const current = latestPopestFile(fs.readdirSync(popDir));
  const popUrl = (v, base) => `${POPEST_BASE}/${base}-${v}/state/totals/NST-EST${v}-ALLDATA.csv`;
  const bases = (v) => [...new Set([2020, v - (v % 10)])].filter((b) => b <= v);
  const curRel = `popest/${current.file}`;
  const curUrl = sources[curRel]?.url ?? popUrl(current.vintage, 2020);
  save(curRel, curUrl, await get(curUrl), `Vintage ${current.vintage} population estimates`);

  const next = current.vintage + 1;
  for (const base of bases(next)) {
    const url = popUrl(next, base);
    const buf = await get(url, { allow404: true });
    if (!buf) continue;
    save(`popest/NST-EST${next}-ALLDATA.csv`, url, buf, `Vintage ${next} population estimates`);
    // The site uses only the newest vintage; drop the superseded file.
    fs.rmSync(path.join(popDir, current.file));
    delete sources[curRel];
    break;
  }

  const sorted = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(SOURCES, `${JSON.stringify(sorted, null, 2)}\n`);

  const summary = changes.length ? changes.join('\n') : 'No new or revised data.';
  console.log(summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\nsummary<<EOF\n${summary}\nEOF\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
