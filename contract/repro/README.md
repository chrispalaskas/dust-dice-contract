# Upstream defect reproductions

Self-contained Compact sources that reproduce compiler defects, kept so each can be attached
to an upstream issue verbatim and re-run against a future compiler to check whether it is
fixed. See `docs/bugs-found.md` for the write-ups.

None of these are part of the build. They are not `include`d by anything and
`npm run compact` does not touch them.

## bug #1 — exponential compile time on nested conditional reuse

compactc 0.34.0, language 0.26.0. No hashing, no witnesses, no ledger ADTs, no dependencies
beyond `CompactStandardLibrary`.

### Growth curve

`bug1-const-reuse-depth-12.compact` and `bug1-const-reuse-depth-20.compact` compose a `step`
circuit whose body uses one `const` twice inside a conditional, N deep.

```
compact compile --skip-zk repro/bug1-const-reuse-depth-12.compact /tmp/r12   # ~1.2 s
compact compile --skip-zk repro/bug1-const-reuse-depth-20.compact /tmp/r20   # ~17.8 s
```

Full curve measured at depth 4 / 8 / 12 / 16 / 20: 0.35 / 0.47 / 1.24 / 4.66 / 17.76 s —
roughly 1.39x per level.

### The cliff, as actually hit

`bug1-modalface-nesting-1.compact` and `bug1-modalface-nesting-2.compact` are the shape that
stopped the project: a six-step running max (`modalFace`) over five summed equality
comparisons (`faceCount`), composed 1 and 2 deep.

```
compact compile --skip-zk repro/bug1-modalface-nesting-1.compact /tmp/n1   # ~1.85 s
compact compile --skip-zk repro/bug1-modalface-nesting-2.compact /tmp/n2   # NEVER COMPLETES
```

Run the second one under a timeout. It spins at 100% CPU with RSS climbing past 1.3 GB and
produces no output, no error, and no progress indication — indistinguishable from a hang:

```
/usr/bin/time -f 'TIME %e s MAXRSS %M KB' \
  timeout 180 compact compile --skip-zk repro/bug1-modalface-nesting-2.compact /tmp/n2
```

`nesting-3` (a third level) behaves the same as `nesting-2`; two levels is already unbounded.

### Corrected root cause — the fan-in set

`bug1-fanin-narrow.compact`, `bug1-fanin-wide-cheap.compact` and `bug1-fanin-wide-modal.compact`
are three files identical except for the three-line body of `mask`, with instruction counts
agreeing to within 6% (1 293 / 1 303 / 1 367). They show that nesting depth is _not_ the
variable: `wide-cheap` has the same fan-in as `wide-modal` and compiles instantly, and a flat
argmax rewrite of `wide-modal`'s mask does not help either.

```
for v in narrow wide-cheap wide-modal; do
  /usr/bin/time -f "$v TIME %e s MAXRSS %M KB" \
    timeout 240 compact compile --skip-zk repro/bug1-fanin-$v.compact /tmp/f-$v
done
```

| Variant      | `mask` reads    | `mask` cost   | reuse=6 | reuse=12 | reuse=18 |
| ------------ | --------------- | ------------- | ------: | -------: | -------: |
| `narrow`     | own position    | 1 comparison  | 0.43 s  | 0.48 s   | 0.57 s   |
| `wide-cheap` | all 5 positions | 1 `faceCount` | 0.45 s  | —        | —        |
| `wide-modal` | all 5 positions | running max   | 3.89 s  | 25.5 s   | 51.6 s   |

`reuse=N` is the number of times each element of `merged` is read; the shipped files use 6. To
reproduce the other columns, repeat the `faceCount(d, 1..6)` block inside `reuse`. `narrow` is
flat in that count and `wide-modal` is not, at equal instruction counts — that is the defect.

## bug #10 — `Uint<a..b>` excludes `b`

`bug10-uint-range-upper-bound.compact`. Compiles cleanly and reads its own answer out of the
generated JavaScript, so it demonstrates the defect without a runtime:

```
compact compile --skip-zk repro/bug10-uint-range-upper-bound.compact /tmp/b10
grep -n 't1 > ' /tmp/b10/contract/index.js
```

`Uint<0..1>` emits a bound check against **0**, `Uint<0..3>` against **2**, and `Uint<0..256>`
against 255 — i.e. `Uint<0..256>` is `Uint<8>`. So `x as Uint<0..1>` throws for every `true`.
The file's header comment carries the full table and the two confirming type errors.
