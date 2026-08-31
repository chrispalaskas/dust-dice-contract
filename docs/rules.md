# Table rules (site copy)

The authoritative player-facing rules. The UI renders this; the contract enforces it.
Any change here must land together with the matching circuit/api change.

## The game

Standard Yahtzee, 2–6 players per table. 13 rounds; each turn you get up to three rolls of
five dice. You pre-declare a **roll strategy** for the turn (how holds are decided between
rolls — e.g. "keep fours", "chase the straight", "stand on the first roll"); the scoring
**category is yours to choose after you see the final dice**. Upper-section bonus: +35 when
your six upper categories total 63+. Extra Yahtzees: +100 each while your Yahtzee box holds
50, with official joker placement rules.

## Stakes and payout

- Four tables tiers: 100 / 1 000 / 10 000 / 100 000 NIGHT per seat. Your stake goes into the
  table pot when you take a seat.
- **The winner takes 99% of the pot.** 1% (rounded down; the rounding remainder stays with
  the winner) goes to the table operator's rake address, which is fixed at table creation and
  publicly visible on-chain.
- **Ties never split the pot.** Highest total wins; if tied, the player who reached that
  total earliest in the game wins; if still tied, the lowest seat number (earliest to join)
  wins. This is deterministic and enforced by the contract.

## Fees, and two warnings your wallet will thank you for

- Every move you make is a transaction paid in DUST. DUST regenerates from NIGHT you hold
  **and have designated** — NIGHT locked in a pot generates nothing. **The lobby will stop
  you from staking your entire balance**: keep a fee reserve or you cannot afford your own
  turns.
- **Winnings arrive undesignated.** They generate no DUST until you designate them. Your
  first designation is free; re-designating costs DUST — do not empty your DUST tank before
  designating a payout.

## Timeouts — a table can never trap your stake

- Miss your turn deadline and your remaining categories score zero; the game continues
  without you. Anyone can trigger this — no one has to wait on a vanished player.
- If the table itself stalls (the operator stops resolving rolls), anyone can trigger an
  abort after the table deadline: **every seated player gets their full stake back**, and the
  rake gets nothing.

## Fairness — verify any game yourself

Dice come from a commit–reveal scheme: the operator commits to a secret seed before the
table opens; your per-turn entropy is forced from a key you commit to when you join; every
roll mixes in a running digest of the whole game so far. Neither you, other players, nor the
operator can steer a single die — the operator's only power is to stop resolving (which ends
in the refund above, never in a changed outcome). When a game ends, the seed becomes public:
the **Verify this game** panel re-derives every roll of the game in your browser, and you
can do the same offline from the chain log alone.

The operator does not play at tables it operates.

## What this site is not

Dice and scorecards are public — this is an open-information game and we make no privacy
claims about play. This deployment is a technology demo on a test network; the NIGHT staked
here is test value. See the legal note in the README.
