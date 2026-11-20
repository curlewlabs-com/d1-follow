# d1-follow

Keep a Cloudflare Worker's Durable Objects beside its D1 database's primary as
the primary moves, without a redeploy.

## What it is

A TypeScript library for a Worker that does its D1 work from Durable Objects. It
keeps those objects in the same Cloudflare colo as the database's primary, and
follows the primary when it moves:

- **Observers** that learn the object's own colo and the primary's colo as a
  side effect of the object's ordinary D1 queries.
- **A router** for stateless objects: forward a request once to an object beside
  the primary, and tell the caller to go there next time.
- **A lane** for singleton objects: admit work only while a D1 record names this
  object, and hand the record to an object beside the primary inside the
  object's own lock.
- **A creator**: a separate cron-driven Worker that keeps a verified object of
  each class waiting in each colo Cloudflare places objects in, so nothing has
  to be created at the moment the primary moves. It comes with its own D1
  schema, a ledger of every act, and a dry-run mode for each class, lane and
  router.
- **A census** that reconciles every stored object with the creator's records.

Decisions are pure functions of observations, records and an injected clock.
Your app supplies its own RPCs, its D1 handles and its `fetch`; the package has
no runtime dependency.

**The primary's colo comes from a field Cloudflare does not document.** A D1
result's `meta` carries `served_by_primary`, which is documented, and
`served_by_colo`, which Cloudflare returns but does not document (the documented
fields name only the region:
[D1 result](https://developers.cloudflare.com/d1/worker-api/return-object/)). If
`served_by_colo` is missing or malformed, the package learns nothing: there is
no observation, every object serves where it is, no request is forwarded and no
lane hands off. The creator still probes and keeps its slots, but makes no
attempts at the primary's colo, because it does not know where that is. Your app
keeps working; it just stops following the primary.

**Status: 0.x, partly built.** Section [Status](#status) lists what exists and
what is still design. 0.x releases make no compatibility promise to earlier 0.x
releases.

## Why it exists

A Worker that makes several D1 round trips for each unit of work can run that
work in a Durable Object placed in the primary's colo, one hop from the
database. That arrangement decays on its own:

- Cloudflare documents relocation of existing Durable Objects as planned
  ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)),
  and objects and D1 primaries have been seen to change colo with no deploy and
  no code change.
- No caller can move an existing object: `get()` reaches it wherever it is, and
  a new object is created close to where its first `get()` is made (same page).

So an object placed beside the primary stays behind when the primary leaves, and
from then on every unit of work pays several cross-colo round trips where it
paid none. Cloudflare's placement documentation covers each product on its own;
this package keeps the two together.

## How to use it

### Install

The package is published as a GitHub release asset, not on the npm registry. It
ships TypeScript source, so it needs a bundler or test runner that compiles
TypeScript, as Wrangler and `@cloudflare/vitest-plugin` do:

```sh
bun add https://github.com/curlewlabs-com/d1-follow/releases/download/v0.4.0/curlewlabs-com-d1-follow-0.4.0.tgz
```

The lockfile records the tarball's integrity, and each release is immutable.

The package has two schemas, exported as files:

- `@curlewlabs-com/d1-follow/schema/lane.sql`: the lane tables. Apply them to
  **your app's** database, through your own migrations, even if you use no lane:
  the creator reads them on every pass, for the lane holders it must never
  release.
- `@curlewlabs-com/d1-follow/schema/creator.sql`: the creator's database. Every
  statement is idempotent (`IF NOT EXISTS`, `INSERT OR IGNORE`), so the
  creator's deploy can apply it whole every time (for example
  `wrangler d1 execute <creator-db> --remote --file node_modules/@curlewlabs-com/d1-follow/schema/creator.sql`).

### Observe, in every object

Keep one `SelfColoCache` and one `PrimaryObserver` per isolate, in memory. Never
persist them: an isolate cannot change colo, and a stored colo goes stale
silently when Cloudflare moves the object.

```ts
import {
  currentObservation,
  placementOf,
  PrimaryObserver,
  readTraceColo,
  SelfColoCache,
} from "@curlewlabs-com/d1-follow";

const selfColo = new SelfColoCache();
const primary = new PrimaryObserver();

// After every D1 call, hand over its metas, a batch's included.
const result = await env.DB.prepare(sql)
  .bind(...args)
  .all();
primary.note([result.meta], Date.now);

// Before deciding anything:
const reading = await selfColo.resolve(() => readTraceColo(fetch));
const self = reading.kind === "colo" ? reading.colo : null;
const placement = placementOf(
  currentObservation(self, primary.latest(), Date.now()),
);
// placement.kind is "unobserved", "beside" or "apart".
```

### Route a stateless object

Before any of the request's own D1 work, call `routeRequest` with the placement,
the object's own name, the request's hop count, and a lookup of verified slots
from the object's cached copy of the registry (`readSlots` against the creator's
database; `registryReadDue` says when to read it again). A `forward` decision
means calling that slot with a hop count of one and returning its answer, with
its name as the hint. `hintAfter` gives the hint for a request served here.
After a failed forward, `forwardCoolingDown` keeps the object serving locally
for `ROUTE_FORWARD_COOLDOWN_MS`.

### Hold a singleton lane

In the first query of each unit of work, read the lane's row from `follow_lane`,
then call `admit(record, selfName)`: `work`, `redirect` (refuse and name the
holder) or `seed` (insert the default holder with `INSERT OR IGNORE` and decide
again). After each unit of work, still inside the object's lock, advance the run
with `nextLaneRun`; `handoffColo` names the colo to hand off to once the run
reaches `LANE_HANDOFF_THRESHOLD`, and `readSlotsIn` finds the target slot there.
The swap of the record itself is not built yet ([Status](#status)).

### Run the creator

Deploy a second Worker beside your app, on an hourly cron, with its own D1
database (`schema/creator.sql`), bindings to your app's Durable Object classes
and a binding to your app's database. Each cron calls `runCreatorPass` with a
`CreatorConfig`: your classes (each with its own code, name form, and the
observe, place, mark-in-place and release calls your objects expose), the region
hint to start from, and the bounds that size the pass's cost. Everything starts
in dry-run, which logs what it would do; switch a class to act with `setMode`
once its log looks right.

The place, mark-in-place and release calls each receive a `deadlineMs`, and each
must refuse once the object's own clock reads past it, before it touches
storage. The deadline ends inside the creator's pass lease. A call that arrives
later belongs to a pass that may no longer hold the lease, and acting on it
could undo the work of the pass that does. Placement and release also enforce the
[placement guard](#guard-placement-and-release) at the object.

The design below says what each of those calls must do. The test that a feature
belongs in this package is whether it stays useful with your app swapped for
another.

## Status

Built:

- the observers in [Concepts](#concepts);
- the lane's admission decision and its run toward a handoff (`admit`,
  `nextLaneRun`, `handoffColo`, and `readSlotsIn` for the target slot);
- the schemas and store statements in
  [Where the state lives](#where-the-state-lives);
- the creator's pass (`runCreatorPass`), including spares in the primary's colo;
- the [standby lookup](#discover-a-standby-after-a-missed-accept) for a caller
  whose serving object has not accepted;
- the [census](#census) (`takeCensus`);
- the stateless router's decisions (`routeRequest`, `hintAfter`).

Still design:

- the lane's swap of its record to the new holder, and the operator's handoff
  call;
- the app's selection and execution of a standby request, and its audit of the
  standby's registration at the time it served.

The rest of this README is the design, built parts and unbuilt alike.

## The idea

- **Ask the object, not the database.** A caller addresses the object it last
  learned of, or the default its deployment was built with. That object does D1
  work anyway, and the result of a query the primary served says so
  (`served_by_primary`), so the object learns where the primary is as a side
  effect. A caller that asked D1 first would pay the long round trip this exists
  to avoid, or reach a replica, which cannot say where the primary is.
- **Keep an object waiting in each colo Cloudflare places objects in.** A slot
  is an object of your class that landed in one of those colos, holding a
  placement marker so it does not cease when idle, and verified by its own
  answer, never by its name. A separate creator learns the colos from where its
  own creations land, makes the slots through a region hint and keeps them, so
  none is created at the moment of need.
- **A stateless object forwards once and teaches its caller.** An object that
  finds itself away from the primary hands the request to the slot beside it,
  and the answer tells the caller where to go next time.
- **A singleton changes hands only inside its own lock.** An object that must be
  the only one acting, such as a serialization lane, is named by one D1 record.
  It admits work only while the record names it, and it hands the record to the
  slot beside the primary while it holds its own lock, so the old holder's last
  unit of work and the new holder's first cannot overlap.

## Concepts

- **Observation**: an object's own colo, from a fresh `/cdn-cgi/trace` read
  cached per isolate, and the primary's colo, from a D1 result whose
  `served_by_primary` is true. The colo comes from the result's `served_by_colo`
  field, which Cloudflare returns but does not document - the documented fields
  name only the region
  ([D1 result](https://developers.cloudflare.com/d1/worker-api/return-object/)).
  Without it there is no observation, and every object serves where it is. A
  replica's result is no observation of the primary, and an observation older
  than ten minutes counts as none.
- **Slot**: one object of a class in one colo, listed in the registry with when
  it last answered from its colo. It is verified while that answer is less than
  two hours old.
- **Candidate colo**: a colo the creator keeps a slot of each class in: one a
  creation of its own has landed in, or one a slot was registered in. The
  creator starts knowing none.
- **Region hint**: the `locationHint` a creation names: a region such as `enam`,
  not a colo. Without one, a Durable Object is created near the code that first
  addresses it; with one, it is created in the hinted region, and Cloudflare
  picks the colo there
  ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
  [where.durableobjects.live](https://where.durableobjects.live/) creates
  objects this way and tracks which colos each hint lands in. Creating through a
  hint needs no code already running in the target colo.
- **Launch point**: code already running in a colo that can create an object
  there, such as an anchor object whose own fresh observation matches the colo.
  It is the manual fallback for a colo the region hint does not reach.
- **Hint**: the object name an answer tells its caller to use next time.
- **Lane record**: the row naming a singleton's current holder, with a sequence
  number every change compares and swaps, and a change log the same write
  appends to.

## Stateless objects: route, forward once, hint

The caller addresses the name in its isolate's cache, or the deployment's
default, and sends the request with a hop count of zero. It stores any hint the
answer carries, and drops its cached name when a call fails, so the next request
falls back to the default.

The object decides before any D1 work, so a forward can never repeat a write it
already made:

- **Forward**: when its observation is fresh, the primary is in another colo,
  the registry has a verified slot of its class there, and the hop count is
  zero, it hands the request to that slot with a hop count of one and returns
  the slot's answer, with the slot's name as the hint.
- **Serve**: otherwise it serves the request. If the request's own D1 results
  put the primary in another colo that has a slot, the answer still carries the
  hint; if that colo has none, it reports the gap.
- **Never twice**: a request whose hop count is one is served where it lands,
  even by a slot that finds itself away from the primary too, so no request
  bounces between objects.
- **A failed forward fails its request**, since the slot may have run it, and
  holds the object back for `ROUTE_FORWARD_COOLDOWN_MS`, during which it serves
  and hints nothing toward that slot. The object then tries the slot again, so a
  slot that stays dead costs what each object has in flight once per cooldown
  until the registry drops it, instead of failing everything sent its way that
  whole time.

Nothing here decides "the primary has moved". Each request goes where the latest
fresh observation says, so a primary that moves back and forth costs forwards
and cache updates, not a relocation.

## Singleton lanes: admit, redirect, hand off under the lock

The caller addresses its cached name, or the deployment default. On a redirect
it caches the named holder and calls it once; a second redirect in the same
attempt is logged and dropped, and the next attempt starts again.

The object, holding its own serialization lock, reads the lane record in its
first D1 query:

- **The record names it**: it does the work.
- **It names another object**: it refuses without doing any work and answers
  with a redirect to that holder.
- **There is no record**: it inserts one naming the deployment default with
  `INSERT OR IGNORE`, reads it back, and goes on as above.

After each unit of work, still holding the lock, the holder counts consecutive
observations that put the primary in the same other colo. When the count reaches
the threshold - five by default, about five minutes for a lane that works once a
minute - and a verified slot of its class is in that colo, it swaps the record
to that slot. Its next caller is redirected. The threshold is also the lane's
rate limit: a new holder has to see the primary elsewhere that many times before
it hands off again, so a lane changes hands at most once per threshold. The swap
happens while the old holder holds its lock with nothing else in flight, and the
new holder admits work only after reading the swapped record, so the two never
overlap. A change of holder from outside, such as an operator's, goes through
the holder's own handoff call for the same reason.

## The creator: making and keeping slots

The slots are a standing substrate that the router and the lanes assume: a
verified object of each class in each candidate colo. Moving is cheap because
nothing has to be created at the moment of need. The creator keeps that true,
with no operator step.

The creator is a separate Worker that the app deploys beside itself in each
environment. It runs on a cron trigger and has its own D1 database. It binds the
app's object classes, through Durable Object bindings that name the app's
Worker, and the app's database, which it reads only for where its primary is and
for its lane records. It serves no route.

Each pass, once an hour, runs under a lease in the creator's database, so
invocations that overlap never fill the same gap twice:

- **Locate the primary.** It reads where the app database's primary is, from the
  meta of a read that names no table and carries no session, so the primary
  serves it. A primary in a region none of the creator's hints names adds the
  hint for that region, read from the result's `served_by_region`; the hint
  stays from then on, since the primary may return there. A failed read costs
  the pass only what it would have done for the primary's gap.
- **Observe.** It asks each registered slot where it is, through the app's
  observe call, which only observes and never changes storage, and records the
  answer. A slot that answers from its colo stays verified. One that answers
  from another colo is kept there, in act mode, when that colo is a candidate
  where its class has no slot: the app's mark-in-place call has it mark itself
  where it is, and its registry row moves, recorded as out of the old colo and
  seeded in the new. Otherwise, or when the object does not take the mark, it
  leaves the registry at once; one that does not answer leaves once its last
  answer from its colo is older than the verified window, since a single missed
  answer is not a move.
- **Probe.** In act mode each class makes one creation through each region hint
  every pass, whatever its gaps, intent before act. It takes the class's next
  name number, then writes a creation intent under the exact name that number
  makes; an attempt whose intent cannot be written does not run, and its number
  stays taken. Then it addresses the name with the hint and asks the new object
  where it is. An object that landed in a colo where its class has no slot
  becomes a slot: the creator has it write its placement marker, then registers
  it with the intent's outcome in one batch. Any other object holds no storage,
  so it ceases on its own, and the outcome records its name as spent. An intent
  left without an outcome, by an answer lost on the way back, is resolved on a
  later pass by observing the name. A pass that cannot resolve a class's open
  attempt makes no creation for that class, probes included, so an outage cannot
  grow the open attempts past what one pass opens, its probes and attempts; its
  learning and refilling wait with it. The pass whose creations first fail still
  makes the rest of them.
- **Fill the gap beside the primary.** When a class that acts has no slot in the
  primary's colo, or fewer spares there than it keeps, the pass spends the rest
  of the class's attempts there, through the hint for the primary's region,
  until the colo holds its slot and its spares. A primary whose region names no
  hint gets none of these attempts: the probes are all that reach its colo.
  Attempts per class per pass are bounded, and a class whose attempts there fill
  nothing waits longer between attempting passes, so a colo the hint seldom
  reaches costs a few attempts a day. The probes do not wait on that backoff.
- **Report gaps.** It reports each candidate colo with no verified slot of a
  class, and the primary's colo while it is no candidate.
- **Release.** A slot is released only when it is out of the registry, is no
  lane's holder, is not the deployment default, and, for a stateless class, has
  been out of the registry for a day. A release that fails is retried on later
  passes, no more per class per pass than the attempts bound, least recently
  attempted first, so releases that keep failing never hold back the rest.

A pass renews its lease before each step that acts, and checks it again after
every call that acts on an object (a creation, a placement, a release, or the
observe that resolves an attempt), whether the call answered or failed, before
it records anything about it. It stops if another pass has taken the lease. An
object it placed is left as it is, with its attempt open for a later pass to
resolve. Observing a registered slot acts on nothing, so the pass does not renew
the lease around it: the stamp an answer leads to never moves a slot's
verification back, and the pass renews the lease before it takes a slot out of
the registry, which it does only while the slot carries the verification the
pass read, and a stamp matches a slot only in the colo its answer came from. It
reads the registry once a pass and applies its own changes to that copy.

A check after a call cannot undo a call that takes effect late, after the lease
lapsed and another pass took over. So each call that writes to an object (a
placement, a mark in place, a release) carries a deadline a tenth of the lease
before the lease lapses, and the object refuses the call once its own clock
reads past it. The margin leaves room for the creator's clock and the object's
to disagree. A refused call is a failed one: its attempt stays open for the pass
that holds the lease. A call that failed may still land before its deadline, so
a pass with one keeps its lease until the lease lapses, and empties no object it
made such a call to; a later pass does. Every path that empties an object, the
cleanups included, first checks the names the creator must keep: the app's
protected names and each lane's holder.

**Candidate colos.** The creator assumes nothing about which colos host Durable
Objects or how many there are. Its probes are at most a fixed number a pass, and
most land beside a slot their class has. The day one lands where no creation has
landed before, the colo joins the candidates and the probe is its class's first
slot there: Cloudflare places objects there, so the primary could move there.
The slots registered when the creator first runs are landings too, so their
colos are the set it starts from. A colo stays a candidate once added, since the
primary may come back to a colo it left; retiring one is an operator's decision.
The ledger records the colo each creation landed in, which is what a colo's
share of the landings, and a colo none has reached in a long time, are measured
from.

**Names.** The creator names an object before it exists, so a name cannot say
which colo it will land in. Each class's names are the adopting app's to choose:
its configuration gives the creator, for each class, how the class's next number
and the hint it is born through become a name (the store takes it as
`beginCreation`'s `nameOf`). The form this tool recommends is a prefix the app
configures per class, then the hint's region, then the number, such as
`scheduler-primary-enam-7`: the prefix says what the object is and anything else
the app wants a name to carry, such as which deployment's creator made it, and
the rest says how it was born, never where it is. A name is never reused, so
each class's numbers come from one counter.

A primary's colo that no creation reaches stays a gap, reported each pass. The
fallback is a launch point there, which takes an operator request entering
Cloudflare in that colo.

### Spare slots in a table of their own

Built: the table, the identity table beside it and the store's statements for
registering, verifying, unregistering and promoting a spare
(`src/spare-store.ts`); the [placement guard](#guard-placement-and-release), whose claim lookup covers
spares; the census, which counts them
(`src/census.ts`); and the creator's pass, which keeps each class's spares in
the primary's colo, verifies them by their marker, marks one again where it is
when it answers there without it, takes them out when the primary moves,
promotes one when the primary's colo loses its base slot, and takes out any
beyond the class's count, keeping verified ones first; a spare counts against
the count once registered and toward the class's readiness only once verified
(`src/creator-spares.ts`). An app sets each class's count
(`CreatorClass.spares`). A caller can discover a verified standby as described
below. The caller owns execution and its placement audit. An app may keep spares
of a class beside the base slot in the colo its primary is in, and only there:
that is where a request is served and where a lane hands off, so it is where a
colo-mate is worth its observe call. `follow_slot`'s key is
`(class_code, colo)`, which gives every slot of a class in a colo the same
identity, so a spare cannot be a row there, and re-keying that table would need
every reader cut over behind rollback floors. So the registry stays as it is,
holding the base slots, and the spares go in a table of their own, keyed by
name, keeping `object_id` and its uniqueness, which the census reconciles
objects by, with the class, the colo and the stamps as columns and an index on
class and colo. It is a new table, so the change is additive under the rules
below.

- **Where spares live.** The app sets how many spares each class keeps; the
  creator keeps them in the primary's colo, filling them through the attempts
  beside the primary as it fills a gap there. When the primary moves, the spares
  in its old colo leave the spare table and are released by the rule above, and
  the new colo's spares are filled the same way. The number of spares never
  grows with the candidate colos.
- **A name and an object id are each held once.** `follow_slot_name` holds every
  registered slot's name and object id, base slot or spare, each unique.
  Registering a slot writes its row in the batch that registers it, so a name or
  id the other table holds fails the batch whole with no ledger record;
  unregistering removes it the same way, and a promotion leaves it alone.
- **A spare can be promoted.** When the primary colo's base slot leaves the
  registry, a verified spare of the class there moves into `follow_slot` in one
  batch, with its ledger record, so the colo keeps a base slot with no creation.
- **Who reads the new table.** Every reader whose job is to protect or account
  for slots: the [placement guard](#guard-placement-and-release), which protects
  spares through release; the creator's pass, which observes and releases spares as it
  does base slots, and verifies one only while it answers from its colo holding
  the marker placed for that colo; the census; and, once a spare can serve as
  the failover standby, the placement audit. An app's failover reads it too,
  since its standby is a verified spare beside the primary. A lane's handoff
  reads it, because the object a lane must leave can be the colo's base slot: an
  object Cloudflare moved keeps its row until the creator's next pass, and a
  lane that stopped at that row would wait for the pass beside a verified spare.
  A forward keeps reading the base slots alone: a stale row costs it a request
  served no closer, which the next pass mends.
- **The order, and what a rollback does.** The store's reads of the new table,
  and each reader above, deploy first, while the table is empty and nothing
  changes. Only then does the creator register a spare. A Worker rolled back to
  a build that does not read the table leaves the spares exactly as they are: an
  older creator neither observes nor releases them, so they keep their markers
  and sit idle, costing nothing, until a creator that reads the table runs again
  and takes them up; an older census accounts for each by its settled ledger
  record; and an older codec does not refuse a spare's name, which only an
  operator's explicit placement call would send, and a spare emptied that way
  still answers from its colo but holds no marker, so the next spare-aware pass
  marks it again where it is, in act mode, or takes it out of the spare table
  for release when it does not take the mark, and the creator fills its place as
  it fills any spare. An older creator writes no identity rows: each deploy of
  this schema fills in the base slots it registered, and a slot it unregistered
  leaves its identity row behind, which holds a name never reused and an id
  derived from that name.
- **Restores.** The table lives in the creator's database beside the registry,
  so a Time Travel restore rewinds the registry and the spares together. Like a
  restored registry row, a restored spare row can name an object whose marker
  was released after the restore point, so a restore checks each spare row
  against its object's marker before the creator acts again.

### Discover a standby after a missed accept

An edge that has never received a response can ask a separate, read-only service
for a standby. The service calls `readPrimary(appDb, reportFailure)` to observe
the app primary. If the observation succeeds, it calls
`readVerifiedStandby(creatorDb, input)` with that colo, the class, the name the
edge attempted, its own configured serving name, the time immediately before the
registry read and the class's verification and release intervals.

For the exact configured name, a verified spare stays eligible even after the
unreachable base is unregistered. Load that configured name from trusted
deployment configuration independently of the caller. For a different attempted
name the same registry snapshot must also hold its fresh base registration. The
target always comes from the spare table, in the observed primary colo, and
differs from the attempted name. The read returns null when no candidate
qualifies. A database failure rejects the read.

Use the returned name only for the request that triggered discovery. Validate
its class and environment naming convention and check its expiry immediately
before addressing it and before dispatch at the receiver, allowing for clock
skew. The spare's last verification anchors its release bound because a creator
can decide to unregister before the registry write becomes visible. A release
delay must outlast outstanding answers, including through restores and
configuration changes. Apply the [placement guard](#guard-placement-and-release).
During a restore, stop issuance, drain outstanding
answers and reverify restored markers before resuming. This lookup does not make
a timed-out write safe to retry. An abandonable attempt must return a target
that starts route work only when its caller selects it. Once execution has been
sent, losing its result cannot authorize another execution.

**Measuring the accept window.** In an adopting deployment, each side recorded
its own elapsed time, joined offline by a per-attempt ID. Subtracting the
object's handler time from the caller's full RPC time gave a proxy for the
accept round trip. The residual was 68 ms at the median, 249 ms at p99 and 571
ms at p99.9. The object's entry counters separated its first serving call on an
isolate that had run nothing else from calls on a warmed isolate. Full cold
starts had a median of 144 ms and p99 of 505 ms, with 0.40% exceeding 1,500 ms.
Later calls had a median residual of 64 ms. Some original calls started 2.361 to
8.694 seconds after their caller's 10-second timeout. This proxy includes
returning the result. Measure direct time to the prepare target and count calls
that never return one before choosing a window for a deployment. The shortest
client wait must accommodate the accept window, discovery, and the standby's
cold start and execution before the caller gives up.

### Guard placement and release

At the mutation receiver, refuse a serving name or current lane holder. Read
`readPlacementClaim(creatorDb, name)` from the primary without caching and
refuse the operation if the read fails. A registered base or spare is in use.
A pending name belongs to the releaser: only explicit cleanup is eligible once
the class's release delay has elapsed since `unregisteredAtMs`. Use a fresh
name for placement. A later creator pass can still clear a pending name.

A null result describes the registry and release queue at the time of the
read. A creator may already hold an open placement intent for an unregistered
name. Use a separate operator naming namespace, or coordinate mutations of
creator-managed names with the creator's pass. `registeredClassOf` answers
registration questions only.

## Where the state lives

The tool's state is split by who reads it on a hot path:

- **The app's database: lane records and their change log.** A lane reads its
  record from the primary in the first query of every unit of work. A stale
  replica read could let an old holder work beside the new one, and in another
  database every unit of work would pay a round trip to wherever that database's
  primary is. So the record lives beside the data the lane works on. A handoff
  appends to the change log in the batch that swaps the record.
- **The creator's database: the registry, its spares, the ledger, the modes, and
  the creator's own working state** (the candidate colos, the region hints it
  added, the name counter, the open creation intents, the objects waiting for
  release, each class's backoff, and the pass lease). An overdue accept can
  trigger a standby lookup. A stateless object reads the registry and its mode
  in the background, cached, at most once every ten minutes. A lane reads them
  only when its run reaches the threshold. The creator and the audit read them
  on their own schedules. The app binds the creator's database for those reads.
  Its mutation receivers enforce the [placement guard](#guard-placement-and-release).

The creator copies each lane change from the change log into the ledger on its
next pass, so the ledger stays the one account of every move. Keeping the
creator's state in its own database lets the tool own that schema and its
migrations, and an app adopts the tool by binding it rather than by carrying the
tool's tables.

## Modes

Each class, each lane, and each stateless class's forwarding has a mode, held in
the creator's database. A class's mode covers the creator's creations and
releases of its objects. Forwarding and a lane's handoffs move traffic, so each
has its own, and an app can keep slots before it lets anything move. Dry-run,
the default, logs every forward, hint, handoff, creation and release it would
make, and makes none. Act makes them. Admission and redirects run in either
mode, because they keep a lane single even when its record was changed by hand.
A stateless object sees a mode change within its registry cache window.

## Ledger

Every creation, spent name, verification change, lane change, release, seed and
mode change is a row in the ledger, in the creator's database. Lane changes
reach it from the lane change log, copied once per lane and sequence number.
Each kind's identity is in typed columns the schema requires for that kind, and
the free-text detail is for people only. Where an act can fail midway, its
intent is written first, so a creation whose answer is lost still leaves a
record to resolve. A lane's mode changes are the one history an app reads back
(`readLaneModeChanges`), to tell what a mode was during an interval the mode
table's current row cannot speak for.

## Census

The census (`src/census.ts`) reconciles every object of the app's placed classes
that holds stored data with the registry, the spares and the ledger, by object
id, and with the names the app can put to them. The app lists its namespaces,
reads the creator's tables and supplies the names it knows; the census accounts
for each object as a registered slot, a spare, one waiting for release, one the
ledger created or seeded and has not released, or one the app keeps alive under
its own name. An object nothing else accounts for whose latest ledger record is
an intent with no outcome is reported as unresolved, since an intent says
someone tried and not that the object is theirs. Whatever is left is reported,
as is an object the ledger released that still holds data, and a registered slot
or spare whose object no longer does. The census releases nothing.

## Schema changes

The tool's schemas change rarely, and only additively: a new table, a new
nullable or defaulted column, a new index. Nothing is renamed, dropped or
retyped, and no constraint is tightened on a table that holds rows. So every
deploy is windowless. A schema change lands ahead of the code that uses it, the
build before it keeps working against the new schema, and rolling code back
needs no database step. The app applies `lane.sql`'s changes through its own
schema process, and the creator's deploy applies `creator.sql` whole on every
deploy, which is why each statement in it is `IF NOT EXISTS`. A column added to
a table that already exists needs a step of its own that the deploy runs only
when the column is missing.

The ledger and the lane change log grow for the life of the environment, so no
statement may walk either. The store's tests read SQLite's plan for each store
statement and require every step on the ledger to search an index. A statement
on the change log, whether the app's or the creator's, searches it by its key,
the lane and then the sequence number. Its writers add a row per change of
holder: the seed, once; the lane's own handoff, at most once per threshold; and
an operator's, by hand.

## What this owns, and what the app supplies

This owns the decisions, as pure functions of observations, registry, lane
record, mode and an injected clock; the creator's logic and its database's
schema; the lane-record schema the app applies to its own database; the
observers; and reference implementations of an anchor and of the placement calls
a slot needs.

The app supplies its own RPCs and envelopes, which carry the hop count, the hint
and the redirect; the call that forwards a request to a slot; the observe and
placement calls the creator makes into its objects; the creator Worker's
configuration (which classes, which region hint it starts from, and how each
class names its objects) and its deploy; the launch points for the manual
fallback; and its D1 handle. The test for anything added here is whether it
stays useful with the app swapped for another.

## Operating it

- Choose the region hint for your primary's region. The creator learns the colos
  from where its creations land, starting from the colos of any slots already
  registered; [where.durableobjects.live](https://where.durableobjects.live/)
  tracks which colos each hint lands in, which its probes should rediscover.
- Deploy the creator beside the app in each environment, in dry-run. Once its
  log shows the slots it would create, set it to act.
- A colo the hint never reaches is a gap to fill by hand, through a launch point
  there.
- **After a Time Travel restore of the creator's database**, the registry, the
  spares, the modes, the lease and each class's name counter are all rewound.
  Keep the creator from acting for the whole recovery (stop its cron, since a
  rewound mode may say act). Before it acts again, set each class's counter in
  `follow_name_counter` at or above the highest number issued before the
  restore, read from a record the restore did not rewind, such as the creator's
  logs, so no name is issued twice; and check each registry and spare row
  against its object's marker.

## Development

Requires [Bun](https://bun.sh) 1.4.4.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The sources are pure functions and small classes with no package dependency: an
app passes in its own `fetch`, its D1 result metadata and its clock, and the
types the sources declare are shapes those values already satisfy. The tests run
the store's statements against real SQLite (`bun:sqlite`) and read SQLite's plan
for each, requiring every step on the ledger to search an index.

**Nothing here may depend on an app.** The tsconfig's `rootDir` makes the
typecheck refuse any source file the program reaches outside `src/`.

The test script runs `bun test` with `--no-install`, so a test run never fetches
a package, and with the per-test backstop from `src/test-timeout.ts`, whose
comment says why it is what it is.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Releases published under the MIT license alone may also be used
under either license.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it is
dual licensed as above, without any additional terms or conditions.

[where.durableobjects.live](https://where.durableobjects.live/) is cited above
only as evidence of where hinted creations land. Its source is GPL-3.0, so none
of it is copied or adapted here, and none may be.
