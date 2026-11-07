// Converts the local copies of the Census source files in data/raw/ into the
// compact JSON the site loads from public/data/. Run with `npm run data`.
//
// ACS state-to-state tables come in two layouts:
//  - wide (2005-2023): a paged matrix. Rows are the current residence
//    (destination); column headers are the residence 1 year ago (origin), each
//    spanning an Estimate and an MOE column. Pages repeat the row labels.
//  - long (2024+): one row per (current residence, residence 1 year ago) pair.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'public', 'data');

// FIPS codes (matching us-atlas feature ids) and postal abbreviations.
export const STATES = [
  ['01', 'AL', 'Alabama'], ['02', 'AK', 'Alaska'], ['04', 'AZ', 'Arizona'],
  ['05', 'AR', 'Arkansas'], ['06', 'CA', 'California'], ['08', 'CO', 'Colorado'],
  ['09', 'CT', 'Connecticut'], ['10', 'DE', 'Delaware'],
  ['11', 'DC', 'District of Columbia'], ['12', 'FL', 'Florida'],
  ['13', 'GA', 'Georgia'], ['15', 'HI', 'Hawaii'], ['16', 'ID', 'Idaho'],
  ['17', 'IL', 'Illinois'], ['18', 'IN', 'Indiana'], ['19', 'IA', 'Iowa'],
  ['20', 'KS', 'Kansas'], ['21', 'KY', 'Kentucky'], ['22', 'LA', 'Louisiana'],
  ['23', 'ME', 'Maine'], ['24', 'MD', 'Maryland'], ['25', 'MA', 'Massachusetts'],
  ['26', 'MI', 'Michigan'], ['27', 'MN', 'Minnesota'], ['28', 'MS', 'Mississippi'],
  ['29', 'MO', 'Missouri'], ['30', 'MT', 'Montana'], ['31', 'NE', 'Nebraska'],
  ['32', 'NV', 'Nevada'], ['33', 'NH', 'New Hampshire'], ['34', 'NJ', 'New Jersey'],
  ['35', 'NM', 'New Mexico'], ['36', 'NY', 'New York'],
  ['37', 'NC', 'North Carolina'], ['38', 'ND', 'North Dakota'], ['39', 'OH', 'Ohio'],
  ['40', 'OK', 'Oklahoma'], ['41', 'OR', 'Oregon'], ['42', 'PA', 'Pennsylvania'],
  ['44', 'RI', 'Rhode Island'], ['45', 'SC', 'South Carolina'],
  ['46', 'SD', 'South Dakota'], ['47', 'TN', 'Tennessee'], ['48', 'TX', 'Texas'],
  ['49', 'UT', 'Utah'], ['50', 'VT', 'Vermont'], ['51', 'VA', 'Virginia'],
  ['53', 'WA', 'Washington'], ['54', 'WV', 'West Virginia'],
  ['55', 'WI', 'Wisconsin'], ['56', 'WY', 'Wyoming'], ['72', 'PR', 'Puerto Rico'],
];
const NAME_TO_INDEX = new Map(STATES.map(([, , name], i) => [name.toLowerCase(), i]));

/** Map a cell to a state index, ignoring footnote markers and spacing. */
export function stateIndex(cell) {
  if (typeof cell !== 'string') return -1;
  const s = cell
    .replace(/[\d*]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const i = NAME_TO_INDEX.get(s);
  return i === undefined ? -1 : i;
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const t = v.replace(/,/g, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  }
  return null;
}

function readGrid(file) {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

/** Parse a grid into an N x N matrix: flows[dest][origin] = {e, m}. */
export function parseGrid(grid) {
  const n = STATES.length;
  const est = Array.from({ length: n }, () => new Array(n).fill(null));
  const moe = Array.from({ length: n }, () => new Array(n).fill(null));
  let found = 0;
  const width = Math.max(...grid.map((r) => r.length));
  const cell = (r, c) => (grid[r] ? grid[r][c] : null);

  // Long layout: column A and B both hold state names on most rows.
  let longRows = 0;
  for (const row of grid) if (stateIndex(row[0]) >= 0 && stateIndex(row[1]) >= 0) longRows++;
  if (longRows > n * (n - 5)) {
    for (const row of grid) {
      const d = stateIndex(row[0]);
      const o = stateIndex(row[1]);
      if (d < 0 || o < 0 || d === o) continue;
      est[d][o] = num(row[2]);
      moe[d][o] = num(row[3]);
      found++;
    }
    return { est, moe, found };
  }

  // Wide layout. Label columns are those holding most of the state names.
  const labelCols = [];
  for (let c = 0; c < width; c++) {
    let k = 0;
    for (let r = 0; r < grid.length; r++) if (stateIndex(cell(r, c)) >= 0) k++;
    if (k >= n * 0.6) labelCols.push(c);
  }
  if (!labelCols.length) throw new Error('no label columns found');

  // Header cells: a state name that is not in a label column and that sits
  // directly above an "Estimate" header (possibly with a blank row between).
  const headers = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < width; c++) {
      if (labelCols.includes(c)) continue;
      const o = stateIndex(cell(r, c));
      if (o < 0) continue;
      const below = [cell(r + 1, c), cell(r + 2, c)].map((v) => String(v ?? '').trim().toLowerCase());
      if (below.some((v) => v.startsWith('estimate'))) headers.push({ r, c, o });
    }
  }
  const headerRows = [...new Set(headers.map((h) => h.r))].sort((a, b) => a - b);

  for (const h of headers) {
    const labelCol = Math.max(...labelCols.filter((c) => c < h.c));
    const nextHeaderRow = headerRows.find((r) => r > h.r) ?? grid.length;
    for (let r = h.r + 1; r < nextHeaderRow; r++) {
      const d = stateIndex(cell(r, labelCol));
      if (d < 0 || d === h.o) continue;
      est[d][h.o] = num(cell(r, h.c));
      moe[d][h.o] = num(cell(r, h.c + 1));
      found++;
    }
  }
  return { est, moe, found };
}

function checkMatrix(year, { est, found }) {
  const pairs = est.length * (est.length - 1);
  if (found !== pairs) throw new Error(`${year}: parsed ${found} of ${pairs} state pairs`);
  let missing = 0;
  let total = 0;
  for (let d = 0; d < est.length; d++) {
    for (let o = 0; o < est.length; o++) {
      if (d === o) continue;
      if (est[d][o] === null) missing++;
      else total += est[d][o];
    }
  }
  // Some tables suppress small cells ("N"); a large share means a misread.
  if (missing > pairs * 0.15) throw new Error(`${year}: ${missing} missing cells`);
  if (total < 5e6 || total > 1e7) throw new Error(`${year}: implausible total ${total}`);
  return { missing, total };
}

function buildAcs() {
  const dir = path.join(RAW, 'acs');
  const files = fs.readdirSync(dir).filter((f) => /^acs1_\d{4}\.xlsx?$/.test(f)).sort();
  const years = [];
  for (const f of files) {
    const year = Number(f.match(/\d{4}/)[0]);
    const m = parseGrid(readGrid(path.join(dir, f)));
    const { missing, total } = checkMatrix(year, m);
    fs.writeFileSync(
      path.join(OUT, `acs-${year}.json`),
      JSON.stringify({ year, source: f, est: m.est, moe: m.moe }),
    );
    years.push({ year, file: `acs-${year}.json`, source: f, interstateMovers: total, suppressed: missing });
    console.log(`ACS ${year}: ${total.toLocaleString()} interstate movers, ${missing} suppressed cells`);
  }
  return years;
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // NAME has no embedded commas in this file; guard anyway.
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((s) => s.replace(/,$/, '').replace(/^"|"$/g, ''));
    return Object.fromEntries(head.map((h, i) => [h, cols[i]]));
  });
}

/** The newest population-estimates vintage present in data/raw/popest/. */
export function latestPopestFile(names) {
  const found = names
    .map((f) => ({ f, m: f.match(/^NST-EST(\d{4})-ALLDATA\.csv$/i) }))
    .filter((x) => x.m)
    .map((x) => ({ file: x.f, vintage: Number(x.m[1]) }))
    .sort((a, b) => b.vintage - a.vintage);
  if (!found.length) throw new Error('no NST-ESTyyyy-ALLDATA.csv in data/raw/popest');
  return found[0];
}

function buildPopest() {
  const { file, vintage } = latestPopestFile(fs.readdirSync(path.join(RAW, 'popest')));
  const rows = parseCsv(fs.readFileSync(path.join(RAW, 'popest', file), 'latin1'));
  const years = Object.keys(rows[0])
    .map((k) => k.match(/^POPESTIMATE(\d{4})$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const fields = ['POPESTIMATE', 'NPOPCHG_', 'BIRTHS', 'DEATHS', 'NATURALCHG', 'INTERNATIONALMIG', 'DOMESTICMIG', 'NETMIG', 'RDOMESTICMIG', 'RINTERNATIONALMIG', 'RNETMIG'];
  const states = [];
  for (const row of rows) {
    if (row.SUMLEV !== '040') continue;
    const i = stateIndex(row.NAME);
    if (i < 0) continue;
    const series = {};
    for (const f of fields) {
      const key = f.replace(/_$/, '').toLowerCase();
      series[key] = years.map((y) => {
        const v = row[`${f}${y}`];
        return v === undefined || v === '' ? null : Number(v);
      });
    }
    states.push({ fips: STATES[i][0], ...series });
  }
  const us = rows.find((r) => r.SUMLEV === '010');
  fs.writeFileSync(
    path.join(OUT, 'popest.json'),
    JSON.stringify({
      vintage,
      source: file,
      years,
      usPopulation: years.map((y) => Number(us[`POPESTIMATE${y}`])),
      usInternationalMig: years.map((y) => Number(us[`INTERNATIONALMIG${y}`])),
      states,
    }),
  );
  console.log(`PopEst vintage ${vintage}: ${states.length} states, years ${years.join(', ')}`);
  return { vintage, file: 'popest.json', source: file, years };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const acs = buildAcs();
  const popest = buildPopest();
  // Where each raw file came from, recorded by scripts/fetch-raw.mjs.
  const sourcesFile = path.join(RAW, 'sources.json');
  const sources = fs.existsSync(sourcesFile) ? JSON.parse(fs.readFileSync(sourcesFile, 'utf8')) : {};
  for (const a of acs) a.url = sources[`acs/${a.source}`]?.url ?? null;
  popest.url = sources[`popest/${popest.source}`]?.url ?? null;
  fs.writeFileSync(
    path.join(OUT, 'index.json'),
    JSON.stringify({ states: STATES.map(([fips, abbr, name]) => ({ fips, abbr, name })), acs, popest }, null, 1),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
