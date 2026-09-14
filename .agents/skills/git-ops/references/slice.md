# slice — what one unit of work is

Everything in this bundle is measured in **units**: one commit per unit, one issue per unit, one
delegated subagent per unit. This skill defines the unit. Get it wrong and every downstream rule
degrades into paperwork.

A unit is a **vertical slice** — a narrow but *complete* path through every layer the change touches (schema, API, UI, tests), which works and is demoable on its own. Also called a **tracer bullet**: you fire one all the way to the target to see where it lands, then fire the next one having learned something.

## The test

A slice is correctly sized when all four hold:

1. **It goes all the way through.** Someone can *see* it do something — run it, hit it, watch a test
   go green. Not "the types are in place".
2. **It stands alone.** Landing only this slice leaves the codebase working. Not necessarily
   feature-complete — working.
3. **It fits one fresh context window.** If you'd need to compact partway, it's two slices.
4. **It taught you something.** The next slice is chosen *after* this one lands, informed by it.

If a chunk of work fails (1) or (2), it isn't a slice — it's a layer.

## Why this is the whole game

**Horizontal work is what produces fake commits.** Build all the schema, then all the API, then all the UI, and at the end you have one large diff and a rule that says commit incrementally. So you chop the diff into pieces that look like units. Every one of those commits is a fiction: none of them ever ran, none of them stands alone, and the history records an order that never happened.

Working in vertical slices means **the commit is a by-product, not a task.** You finish a slice; the commit already describes itself. Nobody has to be reminded.

Horizontal work also verifies the wrong thing. Tests written across a whole layer at once assert the *shape* you imagined before building it, so they go quietly insensitive to whether the thing actually works. A slice's test asserts behavior you just watched happen.

## Sequencing slices

- **Prefactor first.** If the change is awkward against the current structure, make the structure
  easy first, as its own slice — *make the change easy, then make the easy change*. A prefactor slice changes no behavior and says so in its commit (`refactor: …`).
- **Order by what you'll learn.** Take the slice that resolves the most uncertainty first, not the easiest one. If a slice's *purpose* is to resolve uncertainty and its code is disposable, that's a spike`, different rules.
- **Declare what blocks what.** When slices become issues, each one names the slices that must land first. Work the frontier: anything whose blockers are all done.

## Wide refactors — the exception

A **wide refactor** is one mechanical change whose blast radius fans across the codebase: rename a column, retype a shared symbol, swap a library. There is no vertical slice, because the smallest correct edit breaks every call site at once and nothing is green until all of it lands.

Don't force it into tracer bullets. Sequence it as **expand → migrate → contract**:

| Phase | What lands | Green? |
|---|---|---|
| **Expand** | Add the new form *beside* the old one. Nothing calls it yet, nothing breaks. | Yes |
| **Migrate** | Move call sites over in batches sized by blast radius — per package, per directory. One batch per unit, each blocked by expand. The old form still exists, so every batch lands green. | Yes, per batch |
| **Contract** | Delete the old form once no caller remains. Blocked by every migrate batch. | Yes |

The property that makes this work is that **expand and contract are individually safe**, and the
risky part is split into batches you can stop between. Each batch is still a commit; the cadence rule holds unchanged.

When even a single batch can't be green alone (a truly atomic cutover), keep the sequence but let the batches share an integration branch, and promise green only at a final integrate-and-verify unit.

Say so explicitly — a lane where CI is red by design needs the operator to know.

## Slices, commits, issues, and agents

The unit is the same object at every level, which is the point:

- **Commit** — one per slice as it lands..
- **Issue** — one per slice when the work is tracked, with its blocking edges named.
- **Delegated subagent** — one per slice.
- **PR** — *not* one per slice. One per branch, carrying however many slices the task needed.
