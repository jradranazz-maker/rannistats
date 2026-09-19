# RanniStats — working notes

## What things are called

The owner's vocabulary. Use these names; don't guess between them.

**Box score** — the per-game player stats page, reached by tapping a matchup on
the Scores tab. Route `#/nfl/game/<gameId>`, built by `renderGame()` in app.js.
Every player's line for that one game, grouped Passing / Rushing / Receiving /
Defense / Kicking, with a line score and team totals. Fetched live per game from
ESPN's summary endpoint (`ensureLiveBoxscore`) — it is the only screen whose
numbers are never stale.

This is the **only** thing "box score" means. It is not:

- the **scoreboard** — the grid of game cards on the Scores tab
  (`renderScores` / `scoreCard`). Team, record, final score, winner.
- the **season stat block** — the grouped stat card on a player's profile
  (`statBlock`). Season totals with a league rank. Dated "as of" because it is
  baked into data.json at build time, not fetched.
- the **game log** — the per-week table on a player's profile's Game Log tab.

## Two things that are easy to get wrong

**Season totals vs. a game line.** A player's profile carries season figures; the
box score carries one game. In week 1 they're identical, which hides the
difference — from week 2 on, showing one where the other belongs is the bug that
reads as "the stats are just wrong."

**What's live and what's baked.** Standings, scores, news, rosters, injuries and
box scores are fetched from ESPN on open. Player season stat lines, leaders and
the schedule are baked into data.json by the refresh scripts and go stale between
runs — `REFRESH_PLAYBOOK.md` is how they're refreshed.

## Before shipping

`node build_site.js`, then the suites in `tests/`. `test_sweep2.js` is the hard
gate (`ISSUES FOUND: 0` and `PAGE ERRORS: 0`); the rest should pass too.

Deploy is a manual upload of `index.html` to the `jradranazz-maker/rannistats`
GitHub repo. Don't attempt `git push` — it's blocked from this environment.
