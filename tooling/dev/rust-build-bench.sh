#!/bin/sh
# Times one Cargo workspace's test build and appends a TSV row:
#   clean   build every test binary from an empty target dir
#   touch   rebuild after touching one crate's src/lib.rs (compile + relink)
#   test    run the tests (nextest) and keep the summary line; BENCH_TESTS=0 skips it
# Usage: rust-build-bench.sh <workspace dir> <target dir> <label> <crate to touch> [results.tsv]
# Environment variables (PAGED_LINKER, PAGED_SCCACHE, …) pass through, so one
# script measures every configuration. Logs go next to the results file.
# `busy` is the mean number of other rustc processes during the run (0 = quiet machine).
set -u
ws=$1 target=$2 label=$3 touch_crate=$4
results=${5:-$PWD/rust-build-bench.tsv}
logs="${results%.tsv}-logs"
mkdir -p "$logs"
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }
elapsed() { perl -e "printf '%.1f', $2 - $1"; }

rm -rf "$target"
export CARGO_TARGET_DIR="$target"
cd "$ws" || exit 2
have_sccache=0
if [ "${PAGED_SCCACHE:-1}" != 0 ] && command -v sccache >/dev/null 2>&1; then
  have_sccache=1
  sccache --zero-stats >/dev/null
fi

# Other builds on the machine skew the timings: sample them every 5 s.
samples="$logs/$label-busy.txt"
: > "$samples"
# shellcheck disable=SC2009 # pgrep can't count "rustc, but not ours"
(while :; do ps -axo command= | grep -E '(^|/)rustc ' | grep -vc -- "$target" >> "$samples"; sleep 5; done) &
sampler=$!

t0=$(now)
cargo nextest run --workspace --locked --no-run > "$logs/$label-clean.log" 2>&1
clean_exit=$?
t1=$(now)

lib=$(cargo metadata --format-version 1 --no-deps --locked 2>/dev/null |
  perl -MJSON::PP -e 'my $m = decode_json(join "", <STDIN>); for (@{$m->{packages}}) { if ($_->{name} eq $ARGV[0]) { for (@{$_->{targets}}) { print $_->{src_path} if grep { $_ eq "lib" } @{$_->{kind}} } } }' "$touch_crate")
touch "$lib"
t2=$(now)
cargo nextest run --workspace --locked --no-run > "$logs/$label-touch.log" 2>&1
touch_exit=$?
t3=$(now)

test_exit=- summary=-
t4=$t3
if [ "${BENCH_TESTS:-1}" != 0 ]; then
  cargo nextest run --workspace --locked --no-fail-fast > "$logs/$label-test.log" 2>&1
  test_exit=$?
  t4=$(now)
  summary=$(grep -E '^ *Summary' "$logs/$label-test.log" | tail -1 | sed 's/^ *//')
fi

kill "$sampler" 2>/dev/null
busy=$(perl -e 'my ($n, $s) = (0, 0); while (<>) { $n++; $s += $_ } printf "%.1f", $n ? $s / $n : 0' "$samples")
hits=-
if [ "$have_sccache" = 1 ]; then
  hits=$(sccache --show-stats | perl -ne '$h = $1 if /^Cache hits\s+(\d+)/; $e = $1 if /^Compile requests executed\s+(\d+)/; END { print "$h/$e" }')
fi

[ -s "$results" ] || printf 'label\tclean_s\ttouch_s\ttest_s\texits(clean,touch,test)\ttarget_size\tbusy\tsccache_hits/executed\tsummary\n' > "$results"
printf '%s\t%s\t%s\t%s\t%s,%s,%s\t%s\t%s\t%s\t%s\n' "$label" "$(elapsed "$t0" "$t1")" "$(elapsed "$t2" "$t3")" \
  "$(elapsed "$t3" "$t4")" "$clean_exit" "$touch_exit" "$test_exit" "$(du -sh "$target" | cut -f1)" "$busy" "$hits" "$summary" >> "$results"
tail -1 "$results"
