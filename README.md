# PitCrew

**Book a mobile mechanic who comes to the car.** The mechanic sets their own
rate, the platform brings the customer and handles the money, and the whole
transaction — quote, schedule, authorization, payment, payout — happens in one
place.

This is a marketplace, not a directory. The distinction is load-bearing: **the
supply side starts empty.** There is no imported or scraped listing, because a
listing that cannot take a booking is worse than no listing — it is a dead end
wearing the brand. A mechanic exists here only once they have set a rate,
declared working hours, connected a payout account, and been vetted.

## What is built

| | |
|---|---|
| `lib/pricing.js` | The price stack — rate, demand, modifiers, travel, parts, fee |
| `lib/availability.js` | Slot generation against the travel shadow |
| `lib/labor.js` | Labour estimates, seeded then learned from real jobs |
| `lib/money.js` | Line items, fee models, and a balanced double-entry ledger |
| `db/001`–`005` | Taxonomy, identity, rates and availability, bookings, money |

Every domain module is pure and I/O-free. Pricing and scheduling are the parts
of this product most likely to be argued about, so they have to be reproducible
from their inputs alone and testable without a database.

## Decisions worth knowing before you change anything

**The mechanic sets the rate.** The platform publishes a floor ($65/hr, against
a measured $85/hr mobile-mechanic average) and a suggestion, and never writes
the number. This is the load-bearing mitigation against worker misclassification
— a platform that sets prices attacks prong A of the ABC test directly — and
`mechanic_rates.is_platform_default` exists so we can prove, per mechanic, who
chose it.

**Urgent work is never surged.** Roadside and same-day breakdowns are exempt
from demand pricing entirely and meet a flat, published call-out fee instead.
Surging someone whose car has just died is the reputational end of a trust
business.

**The customer is not an input to the price.** No identity, history, or device
reaches `quote()`. A test asserts the function signature so a later change that
starts pricing people has to break it to land.

**Holds and bookings share one table.** A PostgreSQL exclusion constraint cannot
span two tables, so splitting them reopens exactly the double-booking race the
hold was invented to close.

**A booking occupies its travel shadow, not its duration.** The drive there and
the teardown after are part of the footprint. Reserving only `[start, end)`
produces a calendar that looks bookable and is not.

**The platform fee never touches parts.** Parts are a pass-through. Card
processing is charged on the full ticket including parts and tax, so a fee
levied only on labour while paying processing on everything goes negative on
exactly the high-value jobs worth having — `test/money.test.js` demonstrates it
in both directions.

**Insurance is coverage lines, not a boolean.** General Liability excludes
damage to the customer's vehicle in the mechanic's care, custody and control —
the most common claim in this trade. `mechanic_insurance` records
garagekeepers and completed-operations separately, with a real expiry.

## Running it

```bash
npm install
npm test                 # schema tests skip without a database

# with PostgreSQL:
createdb pitcrew
DATABASE_URL=postgres://localhost/pitcrew npm run db:apply
DATABASE_URL=postgres://localhost/pitcrew npm test
```

`btree_gist` is required — a GiST index cannot compare a bigint for equality
without it, so the exclusion constraints will not build. Supabase and RDS ship
it; a bare PostgreSQL needs contrib installed.

## Status

Domain modules and schema, with tests. No HTTP layer, no Stripe integration, no
UI yet. The economics — which fee model ships — is an open decision; all three
candidates are implemented and compared in `lib/money.js` so the choice can be
made against numbers rather than instinct.
