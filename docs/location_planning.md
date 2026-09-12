# Location planning — controlled relocation scenarios

The Next.js Scenario Planning page exposes **Plan a site move**. Python evaluates
the scenario against the selected project snapshot; the map never mutates the
uploaded baseline. Production persistence remains Azure Blob.

## Workflow

1. Select an existing operating plant, DC or warehouse. Drag the purple marker,
   click the map, enter coordinates, or use the demand centre as a starting point.
2. Examine the demand heatmap and, optionally, nearby publicly mapped warehouses.
   Each lookup requires consent. Selecting a building tests its map coordinates;
   it is not a statement that the property is available or suitable.
3. Select the tariff/transit assumption and inspect every affected lane. Supply
   recurring and one-time cost assumptions with their source and date where known.
4. Calculate and save. Compare the actual optimization result with the unchanged
   baseline, then open **See calculations / Download Word** for the saved audit.

This version moves one existing facility per scenario. It does not open a new
warehouse, add lanes, change capacity, obtain verified truck routes, select land,
or automatically find a globally optimal facility location.

## Demand and location screening

Demand is summed from the uploaded customer/market, product and period records.
It is not forecast demand or inferred individual customer addresses. Missing
coordinates are omitted explicitly and coverage is shown. The heatmap uses
quantity-weighted radial kernels of 28 screen pixels, normalized to the highest
visible density. Colour is a display aid, not an optimization input.

The demand centre is a spherical quantity-weighted vector mean. The saved trace
includes each market's radians, unit vector, weighted vector, vector sums and the
formula. An ambiguous or zero-weight centre is unavailable, not an invented point.
Candidate screening uses `sum(quantity × great-circle distance) / sum(quantity)`
over all mapped demand. This is not the selected facility's allocated demand and
is not a total-cost optimum. Each term is preserved in the calculation sources.

## Freight, operations and implementation cost

Every affected road lane is transformed explicitly:

- New estimated distance = uploaded lane distance × new straight-line distance /
  original straight-line distance. This retains the uploaded detour ratio.
- **Scale baseline**: rate and transit time scale by the same distance ratio. This
  assumes they are entirely distance-variable; it does not infer a fixed charge.
- **Uploaded components**: rate = fixed leg cost + rate/km × estimated distance;
  transit days = terminal days + distance / speed (in km/day). Required components must
  exist in the upload. Missing values, manual-quote lanes, unsupported modes,
  degenerate coordinates or inconsistent distances stop the move with an error.

The network is then solved again using the existing objective, constraints,
inventory and planning horizon. Capacity and lane connectivity remain unchanged.
New distances are labelled estimates, not verified road routes. The audit retains
the exact pre-solve transformed inputs and the resulting solver calculation trace.

An optional new annual fixed operating cost replaces the old complete annual
fixed cost; it is not an incremental rent surcharge. The existing model allocates
this cost across its actual planning periods. Fit-out/equipment, moving/transition,
lease exit and other implementation costs are added once to the modeled horizon.
Every category must be explicitly entered (including an explicit zero) and have a
source/assumption note before an implementation-inclusive total is available.
Blank means unknown, never zero. Net impact = scenario operating network cost −
baseline operating network cost + one-time implementation costs. No annualized
payback, financing, tax, working capital, ramp-up or downtime value is fabricated.

## External data, provenance and privacy

The default public source is the [Private.coffee Overpass endpoint](https://overpass.private.coffee/),
using OpenStreetMap warehouse tags. Operators can set `NETGRAVITY_OVERPASS_URL`
to another HTTPS Overpass-compatible service. Requests send only coordinates,
radius and fixed public tag filters—not project IDs, facility names, demand,
costs or user credentials. Lookups are bounded to 1–25 km, 100 returned buildings,
30 provider requests/hour across the application, and 3 requests/minute per user.
Scoped results cache for six hours. Provider failures are shown as failures, not
empty or synthetic results. Public services provide no availability guarantee.

The UI displays retrieval time **and the provider's source-data timestamp**;
the latter can be substantially older. Records link to the original OSM object.
A saved scenario retains the actual query, result set, ranking inputs and chosen
record, tied to the project snapshot. Candidate coordinates are verified against
that stored record before a scenario can claim it as its source.

[OSM warehouse tags](https://wiki.openstreetmap.org/wiki/Tag:building%3Dwarehouse)
describe mapped buildings, not verified distribution-centre operations, rentable
inventory, title, zoning, truck access, capacity or current rent. OSM polygon
centres can be bounding-box centres rather than entrances or points inside the
building. No property cost is inferred from these records. Brokerage/listings,
local cost sheets and a verified routing provider are future integrations.

The default geographic context is local Natural Earth vector data. Optional
**Street detail (external)** loads OSM tiles only after the user turns it on,
sharing the viewed map area but no business values. Attribution is visible and
normal browser caching applies. No offline or bulk tile fetching is performed;
see the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Verification

`netgravity/tests/integration/test_location_scenarios.py` exercises real solves,
unchanged-baseline and no-move controls, per-lane reconstruction, component and
fixed-cost models, missing/invalid inputs, unknown implementation costs, demand
coverage, date-line centres, authenticated project isolation, snapshot conflicts,
research caching and forged-candidate rejection. External results are mocked in
repeatable tests; separate opt-in smoke checks use synthetic coordinates only.

`scripts/test-location-workspace.mjs` tests heat weighting and numerical edge cases
and checks snapshot/selection guards. `scripts/run-kpi-review.py
--with-location-data --port 5056` serves an explicitly synthetic, local-only QA
network for browser testing; that fixture is not production data.
