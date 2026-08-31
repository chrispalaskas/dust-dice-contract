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
