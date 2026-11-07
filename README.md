# State-to-State Migration

An interactive map of U.S. state-to-state migration, built from the Census
Bureau's American Community Survey (ACS) 1-year
[state-to-state migration flow tables](https://www.census.gov/data/tables/time-series/demo/geographic-mobility/state-to-state-migration.html)
(2005–2024) and the Vintage 2025
[population estimates](https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/state/totals/NST-EST2025-ALLDATA.csv).

Deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.

## Features

- US map shaded by net interstate migration, with arrows labeled by number of movers.
- **All states:** arrows show the largest net flows between pairs of states, or the largest one-way flows.
- **One state:** pick a state (dropdown or click the map) to see its partners. *Net* shows one
  arrow per partner in the direction of the net flow; *In & out* shows both opposing flows.
- Dataset picker for every ACS 1-year release since 2005 (there is no 2020 table).
- Year-by-year chart for the selected state, comparing ACS net migration with the
  population estimates' net domestic migration.
- Sortable tables with margins of error, and a summary table of the latest population
  estimates (net domestic, net international and total net migration, with rates).
- Shareable URLs (`#year=2024&state=TX&mode=both`), light and dark themes, keyboard access.
- The version from `package.json` is shown in the header.

## Data

The site has no runtime dependency on census.gov. Copies of the source files live in
`data/raw/`; `npm run data` (run automatically before `dev` and `build`) converts
them to the JSON in `public/data/`.

To pick up a newly published year:

```bash
./scripts/fetch-raw.sh
```

```bash
npm test && npm run build
```

The parser (`scripts/build-data.mjs`) handles both table layouts the Census Bureau has
used: the paged matrix (2005–2023) and the long one-row-per-pair format (2024). It
fails loudly if a table doesn't yield all 52 × 51 state pairs. When a new population
estimates vintage is released, update the file name in `scripts/fetch-raw.sh` and
`scripts/build-data.mjs`.

## Development

```bash
npm install
```

```bash
npm run dev
```

Versioning follows semver: bump `package.json` (and the lockfile) once per PR with
`npm version <patch|minor|major> --no-git-tag-version`.
