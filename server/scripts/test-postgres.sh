#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  exec npm test
fi
# A separate disposable cluster; never touch a development/production database.
test_pg_dir=$(mktemp -d /tmp/tunecloud-pg-test.XXXXXX)
initdb -D "$test_pg_dir/data" -U tunecloud_test -A trust --no-locale > "$test_pg_dir/init.log"
cleanup() {
  pg_ctl -D "$test_pg_dir/data" -m fast -w stop > /dev/null
}
trap cleanup EXIT
pg_ctl -D "$test_pg_dir/data" -l "$test_pg_dir/postgres.log" -o "-k $test_pg_dir -h ''" -w start
createdb -h "$test_pg_dir" -U tunecloud_test tunecloud_test
export TEST_DATABASE_URL="postgresql://tunecloud_test@localhost/tunecloud_test?host=$test_pg_dir"
npm test
