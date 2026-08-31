#!/usr/bin/env bash
# Copyright (C) Shielded Technologies
# SPDX-License-Identifier: Apache-2.0
#
# Compile every contract twice (--skip-zk and full ZK) and record wall time and artifact sizes.
#
# Always compiles into a FRESH directory: a stale managed/ tree keeps serving the previous
# interface, and a partial key set from an interrupted run reads as a successful build with
# suspiciously small keys (see docs/bugs-found.md, and the neighbouring project's #14 on
# cleaning dist/managed before copy).
#
# Usage: scripts/measure-build.sh <outdir>

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: measure-build.sh <outdir>}"
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: >"$RESULTS"

printf 'contract\tmode\twall_seconds\texit\n' >>"$RESULTS"

compile_one() {
  local name="$1" mode="$2" flags="$3"
  local target="$OUT/$name-$mode"
  rm -rf "$target"
  local start end rc
  start=$(date +%s.%N)
  # shellcheck disable=SC2086
  # COMPACT_PATH so `include "policy-core"` (and dice-core / scoring-core) resolve when the
  # compiler is invoked from anywhere but src/.
  COMPACT_PATH="$HERE/src" compact compile $flags "$HERE/src/$name.compact" "$target" \
    >"$OUT/$name-$mode.log" 2>&1
  rc=$?
  end=$(date +%s.%N)
  printf '%s\t%s\t%s\t%s\n' \
    "$name" "$mode" "$(echo "$end - $start" | bc)" "$rc" >>"$RESULTS"
  echo "[$name/$mode] exit=$rc $(echo "$end - $start" | bc)s"
}

CONTRACTS=(dice turn scoring takeTurn table lobby)

for name in "${CONTRACTS[@]}"; do
  compile_one "$name" skipzk "--skip-zk"
  compile_one "$name" zk ""
done

echo "=== artifact sizes ==="
{
  printf 'contract\tcircuit\tartifact\tbytes\n'
  for name in "${CONTRACTS[@]}"; do
    d="$OUT/$name-zk"
    for f in "$d"/keys/* "$d"/zkir/*; do
      [ -f "$f" ] || continue
      base="$(basename "$f")"
      printf '%s\t%s\t%s\t%s\n' \
        "$name" "${base%.*}" "${base##*.}" "$(stat -c %s "$f")"
    done
  done
} >"$OUT/sizes.tsv"
cat "$OUT/sizes.tsv"
echo "=== done, results in $RESULTS ==="
