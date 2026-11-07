#!/usr/bin/env bash
# Refreshes the local copies of the Census source files in data/raw/.
# The site never fetches from census.gov at run time; run this only when the
# Census Bureau publishes a new year, then `npm run data` and commit.
set -euo pipefail
cd "$(dirname "$0")/.."
PAGE=https://www.census.gov/data/tables/time-series/demo/geographic-mobility/state-to-state-migration.html
POPEST=https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/state/totals/NST-EST2025-ALLDATA.csv

mkdir -p data/raw/acs data/raw/popest
# Single-year ACS tables only (skip the 3- and 5-year 20XX_20YY tables).
curl -fsS "$PAGE" \
  | grep -oiE '//www2\.census\.gov[^"]*state_to_state_migrations?_table_[0-9]{4}(_T13[^"]*)?\.xlsx?' \
  | sort -u \
  | while read -r url; do
      year=$(echo "$url" | grep -oE 'geographic-mobility/[0-9]{4}' | cut -d/ -f2)
      ext=${url##*.}
      echo "ACS $year <- https:$url"
      curl -fsS "https:$url" -o "data/raw/acs/acs1_${year}.${ext}"
    done
echo "PopEst <- $POPEST"
curl -fsS "$POPEST" -o data/raw/popest/NST-EST2025-ALLDATA.csv
