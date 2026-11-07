# State-to-State Migration

**Live site: <https://mckoss.com/state-to-state-migration/>**

An interactive map of U.S. state-to-state migration, built from the Census
Bureau's American Community Survey (ACS) 1-year
[state-to-state migration flow tables](https://www.census.gov/data/tables/time-series/demo/geographic-mobility/state-to-state-migration.html)
(2005–2024) and the Vintage 2025
[population estimates](https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/state/totals/NST-EST2025-ALLDATA.csv).

Deployed to GitHub Pages (served at [mckoss.com/state-to-state-migration](https://mckoss.com/state-to-state-migration/)) by `.github/workflows/deploy.yml` on every push to `main`.

## Features

- US map shaded by net interstate migration, with arrows labeled by number of movers.
- **All states:** arrows show the largest net flows between pairs of states, or the largest one-way flows.
- **One state:** pick a state (dropdown or click the map) to see its partners. *Net* shows one
  arrow per partner in the direction of the net flow; *In & out* shows both opposing flows.
- Dataset picker for every ACS 1-year release since 2005 (there is no 2020 table).
- Combined datasets that add up the most recent 5 and 10 yearly tables, for the longer-run
  picture (they count moves, so someone who moved twice counts twice).
- Year-by-year chart for the selected state, comparing ACS net migration with the
  population estimates' net domestic migration.
- Sortable tables with margins of error, and a summary table of the latest population
  estimates (net domestic, net international and total net migration, with rates).
- A second map of the latest population estimates, colored green (gain) or red (loss) by
  total, domestic or international net migration, in people or per 1,000 residents.
- Shareable URLs (`#year=2024&state=TX&mode=both`), light and dark themes, keyboard access.
- The version from `package.json` is shown in the header.

## Data

The site has no runtime dependency on census.gov. Copies of the source files live in
`data/raw/`; `npm run data` (run automatically before `dev` and `build`) converts
them to the JSON in `public/data/`.

`data/raw/sources.json` records the URL each file came from and when it was retrieved.

### Automatic monthly updates

`.github/workflows/update-data.yml` runs on the 4th of each month (and on demand from
the Actions tab). It runs `npm run fetch` (`scripts/fetch-raw.mjs`), which:

- reads the [state-to-state migration page](https://www.census.gov/data/tables/time-series/demo/geographic-mobility/state-to-state-migration.html)
  and downloads every single-year table, keeping any that are new or have changed;
- re-checks the current population-estimates file and looks for the next vintage
  (e.g. `NST-EST2026-ALLDATA.csv`), which replaces the current one;
- rejects anything that isn't a real spreadsheet or CSV, such as an error page.

If something changed, the workflow runs the unit tests, the build and the end-to-end
tests with the new data. If they all pass, it bumps the patch version, commits to `main`
and starts a deploy. If anything fails, nothing is committed and the failed run (with
its Playwright report) shows up in the Actions tab.

To run the same check locally:

```bash
npm run fetch
```

```bash
npm test && npm run build && npm run test:e2e
```

The parser (`scripts/build-data.mjs`) handles both table layouts the Census Bureau has
used: the paged matrix (2005–2023) and the long one-row-per-pair format (2024). It
fails loudly if a table doesn't yield all 52 × 51 state pairs, so a layout change
stops the automatic update rather than publishing bad data. The site always uses the
newest population-estimates vintage in `data/raw/popest/`.

## Development

```bash
npm install
```

```bash
npm run dev
```

## Tests

```bash
npm test
```

```bash
npm run build && npm run test:e2e
```

`npm test` runs the data-parser unit tests. `npm run test:e2e` runs the Playwright
suite in `e2e/` against the production build served by `vite preview`. It covers
map interactions, arrow colors and widths, hover tooltips, the dataset and year
controls, table sorting, and phone layout. CI runs both before every deploy, and
a failed run uploads the Playwright report as an artifact.

Versioning follows semver: bump `package.json` (and the lockfile) once per PR with
`npm version <patch|minor|major> --no-git-tag-version`.
