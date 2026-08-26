# HostPitCrew and PitCrew

**Two surfaces of one product.** Not two products, and not a migration.

| | HostPitCrew | PitCrew |
|---|---|---|
| Role | The demand engine | The transaction |
| Holds | SEO surface, metro × service pages, captured searches and leads, the mechanic directory | Bookings, availability, rates, payments, payouts |
| Supply | Thousands of scraped listings, mostly phone-only | Only mechanics who onboarded themselves and can take a job today |
| Answers | *Where is the work?* | *Who does it, when, and for how much?* |
| Keeps running | **Yes — indefinitely** | Launches metro by metro |

HostPitCrew is not deprecated and is not a legacy system. It is the half of a
marketplace that is normally hardest and most expensive to build: organic
demand, in metros, segmented by lane. PitCrew launching does not replace that —
it monetises it.

---

## Why both

A marketplace has two cold starts. Supply is solvable with a phone and a
founder's time; demand is not. HostPitCrew already ranks, already captures, and
already tells us which metro wants which service and how much of that demand
comes from verified fleets.

PitCrew launching into a metro is therefore a *supply* problem only, because
HostPitCrew already proved the demand is there. That is the entire reason to
keep both running.

## What crosses the seam

Exactly two things. Everything else stays where it is.

### 1. Verification, so nobody proves themselves twice

A host who verified on HostPitCrew — by Turo CSV or by FK Command Center link —
is verified on PitCrew. Asking twice is how an ecosystem becomes two apps that
share a logo.

The mechanism is a short-lived signed claim (`lib/handoff.js`), spent exactly
once (`host_verifications.handoff_jti`, unique). The claim carries an opaque
subject and the method, and **no personal data at all** — it travels through a
browser, so a host's email must not be in it.

`hostpitcrew` is a third verification *method*, not a parallel table. One badge,
three ways to earn it, one place to ask whether it is held.

### 2. Demand, in aggregate, and only in aggregate

HostPitCrew exports counts: metro × service × lane × period → searches, leads.
No email, no host id, no vehicle, no visitor id. `lib/demand.js` **rejects** rows
carrying any of those rather than stripping them, because quietly accepting PII
is how it ends up in a log.

Individual host data never leaves HostPitCrew's admin surface. That is a
standing rule in both systems, not a preference.

---

## The mistake worth naming

> **Imported demand must never reach the pricing engine's demand multiplier.**

The multiplier stays pinned at 1.000 until a metro has enough **completed
PitCrew bookings** to trust its own numbers. That gate is not about how much
interest exists — it is about whether we can measure *our own supply*.

A thousand HostPitCrew searches say a metro wants mechanics. They say nothing
about whether our mechanics are busy, because on day one we have none. Feed
search volume in as `observations` and the engine concludes the metro is hot and
surge-prices the very first customer, against a supply of zero, on evidence that
has nothing to do with supply.

So the split is enforced in three places:

- `demand.toLaunchSignal()` returns **no** `observations`, `utilization`, or
  `demandRatio` field. Imported data cannot unlock the multiplier even by
  accident.
- `imported_demand` is a separate table, and no pricing or rating view joins to
  it. `metro_launch_signal` reads it; nothing in the pricing path does.
- `test/ecosystem.test.js` proves it end to end: a metro with 150,000 imported
  searches still quotes at exactly 1.000×.

Seasonality is the one exception, and it is deliberate: air conditioning fails
in July in Phoenix whoever takes the booking, so `seasonal` transfers. It still
unlocks nothing on its own.

**What imported demand IS for:** deciding which metro to launch next, and what
opening rate to *suggest* a mechanic — never to set one.

---

## Launch sequence per metro

1. HostPitCrew demand crosses the bar (`metro_launch_signal`): searches, leads,
   and weighted leads, where verified-fleet leads count 4× because a fleet
   operator is repeat work across several vehicles.
2. Founder recruits ~12 bookable mechanics — rate set, hours declared, payouts
   connected, insurance verified. Phone, not email: the directory is ~13%
   email-covered.
3. PitCrew opens in that metro. The demand multiplier sits at 1.000 until real
   bookings accumulate.
4. HostPitCrew starts routing that metro's bookable demand to PitCrew. Metros
   without bookable supply keep the directory experience — a call button and a
   real listing, never a dead end.

## Rules that hold in both systems

- **The badge is sacred.** Public reviews exist, are labelled plainly, never
  wear gold, and never rank above one that does. The two averages are never
  merged into a single star rating.
- **Verification is free and instant, forever.** It is the acquisition hook, not
  a tier.
- **Every search and lead is captured, with its lane.** Public volume proves a
  metro is worth a mechanic's time; verified-host volume proves it is worth
  their best rate. The v2 negotiation needs both numbers.
- **The public lane is never a downgrade.** No blurred results, no "verify to
  see prices". The badge adds; it never withholds.
- **Lane never reaches a price.** A verified host is quoted exactly what the
  public is quoted for the same job, in both systems.
- **Individual host data stays internal.** Aggregate-only in anything that
  leaves the admin surface.
