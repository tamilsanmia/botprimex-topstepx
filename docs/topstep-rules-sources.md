# Topstep rule values and their sources

Checked on 2026-10-25. The preset tables in `projectx-gateway/src/rules.js` and
`projectx/backtest_guard.py` are starting points; every value can be overridden in the
`topstep` config block. Topstep revises these, so re-check the pages below before relying on
a number.

## How the check was done

`help.topstep.com` is an Intercom single-page app. `web_fetch` of every article returned only
the page shell (title and licence text, no body), so no value could be read from the page
itself. The "verified yes" rows below rest on the **search-result excerpts of the
help.topstep.com / topstep.com pages**, which carry the article text. Rows marked `no` were
only seen on third-party sites, or not seen at all, and keep their current value.

Verified column:

* `yes`: stated in an excerpt of a help.topstep.com or topstep.com page.
* `no (secondary)`: only third-party sites agree (they are listed). The value is kept.
* `no`: not seen anywhere. The value is kept and is the cautious assumption.

## Account parameters (Trading Combine and Express Funded Account)

| Value | 50K | 100K | 150K | Verified | Source |
| --- | --- | --- | --- | --- | --- |
| Profit target (Combine) | 3,000 | 6,000 | 9,000 | no (secondary) | Not in a help.topstep.com excerpt. Agreeing: https://proptradingvibes.com/blog/topstep-trading-combine-rules, https://blog.traderspost.io/article/how-to-get-funded-with-topstep (6% of the account size). Page to confirm: https://help.topstep.com/en/articles/8284197-trading-combine-parameters |
| Daily Loss Limit | 1,000 | 2,000 | 3,000 | yes | https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account |
| Maximum Loss Limit | 2,000 | 3,000 | 4,500 | yes | https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit |
| Max position, Combine (minis) | 5 | 10 | 15 | yes | https://help.topstep.com/en/articles/11748475-dynamic-live-risk-expansion (states 5/10/15 as the maximum for each account size) |
| Micro : mini ratio (Combine, XFA) | 10:1 | 10:1 | 10:1 | yes | https://help.topstep.com/en/articles/8284197-trading-combine-parameters. The ratio does not apply to the Live Funded Account. |
| Consistency target (Combine) | 55 % | 55 % | 55 % | yes | https://help.topstep.com/en/articles/8284208-what-is-the-consistency-target and https://help.topstep.com/en/articles/8284197-trading-combine-parameters |
| MLL type | trailing, end-of-day balance, breached in real time including unrealized P&L | | | yes | https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit |
| MLL lock, XFA | locks at $0 once the balance reaches the MLL size | | | yes | same page. The XFA balance starts at $0. |
| MLL lock, Combine | stays unlocked in the preset (`mll_lock_balance: null`) | | | no | The same page says in general terms that the MLL locks once it reaches the starting balance, but the excerpts only show the lock for the XFA. The unlocked floor is higher, which is the cautious side. Set `mll_lock_balance` to the account size to model the lock. |
| Scaling plan, XFA 50K | 0: 2, 1,500: 3, 2,000: 5 | | | no (secondary) | https://proptradingvibes.com/blog/topstep-maximum-contracts, https://h2tfunding.com/topstep-scaling-plan/. Official page: https://help.topstep.com/en/articles/8284223-what-is-the-scaling-plan (tiers not readable). Tiers apply to the balance at the start of the session. |
| Scaling plan, XFA 100K | | 0: 3, 1,500: 4, 2,000: 6, 3,000: 10 | | no | Not seen anywhere. Kept. |
| Scaling plan, XFA 150K | | | 0: 3, 1,500: 4, 2,000: 5, 3,000: 10, 4,500: 15 | no | Not seen anywhere. Kept. |
| Scaling plan, Live Funded Account | uses the XFA table | | | no | LFA has its own "Dynamic Live Risk Expansion" tiers (https://help.topstep.com/en/articles/11748475-dynamic-live-risk-expansion). The preset for `live_funded` reuses the XFA table, which is the tighter one. |
| Daily Loss Limit in the XFA | preset applies it | | | yes | The XFA parameters page (https://help.topstep.com/en/articles/8284215-express-funded-account-parameters) lists the DLL as optional and fixed at checkout, so an XFA without a DLL needs `daily_loss_limit: false`. |

## Changes made because of this check

* `consistency_pct` default for the evaluation phase: 50 -> **55** (`rules.js`, `backtest_guard.py`,
  both example configs). All three help.topstep.com excerpts say 55 %. Third-party pages that say 50 %
  are out of date.
* Consistency in the Combine is a **target, not a rule you fail**: when the best day is above 55 % of
  the Profit Target, the target rises to `best day / 0.55`. That is the new `consistency_mode: "raise_target"`.
  The default stays `cap_day` (entries stop for the day at 55 % of the target), which keeps the best day
  under the limit so the target never rises. `off` ignores consistency.
* No other preset value changed.

## Session times

| Value | Source | Verified |
| --- | --- | --- |
| Positions must be flat by 3:10 PM CT (4:10 PM ET) every weekday, trading resumes 5:00 PM CT (6:00 PM ET) | https://help.topstep.com/en/articles/8284206-when-and-what-products-can-i-trade | yes |
| On holidays all account types must close positions 15 minutes before any early close; positions still open are auto-liquidated; Topstep emails the details before each holiday | https://help.topstep.com/en/articles/13350348-topstep-holiday-trading-hours | yes |

## Holiday and early-close table (`src/holidays.js`, `projectx/holidays.py`)

The CME page https://www.cmegroup.com/trading-hours.html is an interactive calendar. The version that
could be fetched on 2026-10-25 was the BrokerTec U.S. Actives calendar (rates, not equity index
futures), so it was used only to cross-check dates. The equity index, metals and energy hours come
from third-party summaries and are **not verified** against CME:

* https://crosstrade.io/blog/cme-trading-hours-2026 (fetched 2026-10-25, lists the 2026 CME Globex holidays)
* https://damnpropfirms.com/trading-guides/cme-holiday-schedule/ (search excerpt: most holidays are early closes at about 1:00 PM ET, not full closures)
* https://calendarhours.com/cme-holiday-hours/ (Thanksgiving window, 26 to 28 Nov 2026)
* https://www.cmegroup.com/trading-hours.html (BrokerTec 2026 calendar, cross-check of dates)

How the table is used (all of it is cautious on purpose):

* **Early close**: every product is treated as halting at the earliest time seen, 1:00 PM ET
  (12:00 PM CT). Some equity products halt at 1:15 PM ET on the day after Thanksgiving and on
  24 Dec; metals, energy and rates differ by a few minutes. Topstep's own cutoff is 15 minutes
  before the close (verified above). The guard stops entries 35 minutes before the close and
  flattens 20 minutes before it, so there is a 5 minute margin before Topstep's cutoff. These
  offsets never move a configured time later.
* **Closed day**: the whole trading day named by that date is treated like a weekend (entries
  blocked, positions flattened). That is the session that opens at 6:00 PM ET the evening before
  and ends at 6:00 PM ET on the date. Good Friday 2026 has a special CME arrangement because of the
  jobs report; it is treated as closed.
* 2026 dates were taken from the sources above. **2027 dates are derived** from the U.S. holiday
  rules (third Monday of January and February, last Monday of May, first Monday of September,
  fourth Thursday of November, Easter for Good Friday, Saturday holidays observed on the Friday,
  Sunday holidays on the Monday). CME had not published them when this was written, so every 2027
  row is `verified: false`. The Juneteenth observance in 2027 (Friday 18 June) is a guess.
* Agricultural products often close on holidays when equity products do not. The table does not
  model that; ags are not in the default whitelist.

Each row in the table carries `source` and `verifiedOn`. `verified: false` means "not confirmed
against CME". Re-check the table when CME publishes the next year's calendar.
