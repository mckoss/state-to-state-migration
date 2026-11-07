// Parser checks against figures published in the Census tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { STATES, latestPopestFile, parseGrid, publishedTotals, stateIndex } from './build-data.mjs';
import { acsLinks } from './fetch-raw.mjs';

const RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw', 'acs');
const idx = (abbr) => STATES.findIndex((s) => s[1] === abbr);
const load = (file) => {
  const wb = XLSX.readFile(path.join(RAW, file));
  return parseGrid(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }));
};
// est[destination][origin]
const flow = (m, from, to) => m.est[idx(to)][idx(from)];

test('stateIndex ignores footnote markers and spacing', () => {
  assert.equal(stateIndex('United States2'), -1);
  assert.equal(stateIndex('Texas'), idx('TX'));
  assert.equal(stateIndex('District of Columbia '), idx('DC'));
  assert.equal(stateIndex('New York*'), idx('NY'));
});

test('wide layout with population columns (2022)', () => {
  const m = load('acs1_2022.xlsx');
  assert.equal(flow(m, 'CA', 'TX'), 102442);
  assert.equal(m.found, 52 * 51);
});

test('wide layout without population columns (2005)', () => {
  const m = load('acs1_2005.xls');
  // Row "Alaska", column "Alabama" in the source sheet.
  assert.equal(flow(m, 'AL', 'AK'), 152);
  assert.equal(flow(m, 'AK', 'AL'), 608);
  assert.equal(m.found, 52 * 51);
});

test('long layout (2024)', () => {
  const m = load('acs1_2024.xlsx');
  assert.equal(flow(m, 'CA', 'TX'), 77161);
  assert.equal(flow(m, 'TX', 'CA'), 45447);
  assert.equal(flow(m, 'AK', 'AL'), 387);
  assert.equal(m.moe[idx('AL')][idx('AK')], 404);
  assert.equal(flow(m, 'NC', 'PR'), null, 'suppressed "N" cells stay null');
});

test('acsLinks keeps single-year tables and skips multi-year ones', () => {
  const html = `
    <a href="//www2.census.gov/programs-surveys/demo/tables/geographic-mobility/2007/state-to-state-migration/state_to_state_migrations_table_2005_2007.xls">3-yr</a>
    <a href="//www2.census.gov/programs-surveys/demo/tables/geographic-mobility/2007/state-to-state-migration/state_to_state_migrations_table_2007.xls">2007</a>
    <a href="//www2.census.gov/programs-surveys/demo/tables/geographic-mobility/2022/state-to-state-migration/State_to_State_Migration_Table_2022_T13_updated_2024_06_27.xlsx">2022</a>
    <a href="//www2.census.gov/programs-surveys/demo/tables/geographic-mobility/2025/state-to-state-migration/State_to_State_Migration_Table_2025_T13.xlsx">2025</a>
    <a href="//www2.census.gov/programs-surveys/demo/tables/geographic-mobility/2005/state-to-state-migration/state_migration_flows_tables.xls">other</a>`;
  const links = acsLinks(html);
  assert.deepEqual(links.map((l) => [l.year, l.ext]), [[2007, 'xls'], [2022, 'xlsx'], [2025, 'xlsx']]);
  assert.match(links[2].url, /^https:\/\/www2\.census\.gov\/.*_2025_T13\.xlsx$/);
});

test('latestPopestFile picks the newest vintage', () => {
  assert.deepEqual(latestPopestFile(['NST-EST2025-ALLDATA.csv', 'NST-EST2026-ALLDATA.csv', 'notes.txt']), {
    file: 'NST-EST2026-ALLDATA.csv',
    vintage: 2026,
  });
  assert.throws(() => latestPopestFile(['notes.txt']));
});

test('published total-mover margins of error', () => {
  const ix = (abbr) => STATES.findIndex((s) => s[1] === abbr);
  // 2005-2009 tables have no totals.
  assert.deepEqual(publishedTotals(path.join(RAW, 'acs1_2005.xls')), { inMoe: null, outMoe: null });
  // 2010-2023: in-movers only ("Different state of residence 1 year ago", Total).
  const t23 = publishedTotals(path.join(RAW, 'acs1_2023.xlsx'));
  assert.equal(t23.inMoe[ix('WA')], 10566);
  assert.equal(t23.outMoe, null);
  // 2024: both, from the supplemental sheets.
  const t24 = publishedTotals(path.join(RAW, 'acs1_2024.xlsx'));
  assert.equal(t24.inMoe[ix('AL')], 9899);
  assert.equal(t24.outMoe[ix('AL')], 8922);
  assert.equal(t24.inMoe.filter((v) => v === null).length, 0);
});
