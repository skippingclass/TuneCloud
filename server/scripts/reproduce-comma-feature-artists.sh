#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_pg_dir=$(mktemp -d /tmp/tunecloud-comma-feature-repro.XXXXXX)
cleanup() {
  if [[ -f "$test_pg_dir/data/postmaster.pid" ]]; then
    pg_ctl -D "$test_pg_dir/data" -m fast -w stop > /dev/null
  fi
  rm -rf -- "$test_pg_dir"
}
trap cleanup EXIT
initdb -D "$test_pg_dir/data" -U tunecloud_test -A trust --no-locale > "$test_pg_dir/init.log"
pg_ctl -D "$test_pg_dir/data" -l "$test_pg_dir/postgres.log" -o "-k $test_pg_dir -h ''" -w start
createdb -h "$test_pg_dir" -U tunecloud_test tunecloud_test
export TEST_DATABASE_URL="postgresql://tunecloud_test@localhost/tunecloud_test?host=$test_pg_dir"
node --test --test-reporter=tap test/comma-feature-artists.test.js
