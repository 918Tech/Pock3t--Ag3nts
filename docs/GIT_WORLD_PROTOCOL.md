# Pocket Agents Git World Protocol — PA-GITWORLD/1

## Canonical rule

Pocket Agents does not merely back up game state to GitHub. The repository is the
durable game universe.

- Repository = universe
- `main` = source code
- `world/live` = canonical live timeline
- Git commit = durable checkpoint
- Commit SHA = continue code
- Commit parent = previous checkpoint
- Branch = alternate timeline
- Diff = exact durable state transition

Transient rendering, animation, touch feedback, and radio retries are not
checkpoints. Every durable gameplay transition is.

## V1 canonical state

PA-GITWORLD/1 intentionally uses one authoritative file:

`world/state.json`

Keeping the complete snapshot in one file makes each checkpoint a single atomic
GitHub Contents write and gives the file blob SHA a compare-and-swap guard.
Derived indexes can be regenerated later.

A world branch MUST NOT change any other path in a checkpoint commit.

## Snapshot schema

The top-level contract is:

```json
{
  "schema": "PA-WORLD/1",
  "world": {
    "universeId": "pocket-agents",
    "sequence": 0,
    "parentCheckpoint": null,
    "lastEvent": {}
  },
  "agents": {},
  "skills": {},
  "inventories": {},
  "encounters": {},
  "listings": {},
  "ledger": {
    "events": {},
    "tips": []
  },
  "genesis": {},
  "integrity": {
    "algorithm": "SHA-256",
    "stateRoot": "sha256:..."
  }
}
```

The current commit SHA is deliberately not embedded in its own snapshot. The
new commit cannot know its own SHA before Git creates it. The snapshot stores
the *parent* checkpoint SHA instead.

## State root

`integrity.stateRoot` is SHA-256 over deterministic canonical JSON after
setting `integrity.stateRoot` to `null`.

Canonicalization recursively sorts object keys. Array ordering is preserved.

## Continue

1. Resolve `world/live` HEAD.
2. Load `world/state.json` at that exact ref.
3. Verify `PA-WORLD/1`.
4. Verify `stateRoot`.
5. Run Pocket invariants.
6. Render.

The resolved HEAD SHA is the continue/checkpoint ID.

## Durable transition

A game action advances the world only through this sequence:

1. Fetch `world/live` HEAD and state blob SHA.
2. Validate the player/device action against that state.
3. Construct the complete next state in memory.
4. Increment `world.sequence`.
5. Set `world.parentCheckpoint` to the fetched HEAD SHA.
6. Record `world.lastEvent`.
7. Run all ownership/provenance invariants.
8. Compute the next `stateRoot`.
9. Commit the complete snapshot.
10. Advance `world/live`.
11. Treat the returned commit SHA as the new checkpoint.

There is no half-transfer checkpoint.

## Ownership law

HTML, CYD renderers, Arena games, Marketplace UI, and radio callbacks may
request a transition. They may not directly mutate authoritative ownership.

A transfer checkpoint must contain all of these changes in the same snapshot:

- sender inventory no longer contains the instance,
- receiver inventory contains the instance,
- SkillInstance.ownerId points to the receiver,
- transfer/provenance counters are updated,
- Proof-of-Encounter / ledger evidence is present,
- roots/revisions are updated.

If any invariant fails, no commit is created.

## Concurrency

All writers use optimistic concurrency.

The writer receives:

- expected HEAD commit SHA,
- expected `world/state.json` blob SHA.

If the world has advanced, the write is rejected. The client reloads the new
checkpoint and revalidates its intended action.

For PA-GITWORLD/1, world branches are restricted to `world/state.json`, so
the file blob SHA is also an effective world-state CAS token.

## Historical checkpoint

Any previous commit SHA can be loaded read-only:

`PocketGitWorld.loadCheckpoint(<sha>)`

A historical load never moves `world/live`.

To continue from an old checkpoint, create another branch from that SHA, e.g.

`world/timeline-002`

History is never rewritten to simulate a rewind.

## Security boundary

Never embed a GitHub personal access token in:

- `cover.html`,
- committed JavaScript,
- GitHub Pages assets,
- ESP32 firmware,
- LittleFS,
- checked-in configuration,
- localStorage.

The included direct writer accepts a runtime token only for controlled
development. Multiplayer should use a GitHub App-backed write service that
validates signed Pocket Agent commands and performs Git writes with short-lived
installation credentials.

The repository remains the source of truth regardless of the write transport.

## Integrity workflow

`.github/workflows/pocket-world-integrity.yml` enforces:

- world branch commits mutate only `world/state.json`,
- schema validity,
- SHA-256 stateRoot,
- one-owner inventory consistency,
- destroyed/retired instances absent from inventories,
- genesis supply caps,
- marketplace seller ownership,
- parentCheckpoint linkage to Git history.

## Browser integration

Load `web/js/git-world.js`, then:

```js
const gitWorld = PocketGitWorld.install();

const checkpoint = await gitWorld.continueGame();
console.log(checkpoint.checkpoint); // continue code
```

For a durable transition:

```js
await POCKET.gitWorld.checkpoint({
  type: "SKILL_TRANSFER",
  summary: "RFG-00821 moved from GHOST-918 to VOID-221",
  payload: { skillInstanceId: "RFG-00821" },
  mutate(next) {
    // Call the domain transfer engine here.
    // Do not mutate ownership from UI code.
    POCKET.transfers.applyValidatedTransition(next, /* validated claim */);
  }
});
```

The adapter calls Pocket invariants before any write.

## Physical CYD

The CYD uses the same command/state contract. It may cache the latest checkpoint
and state in NVS/LittleFS for offline rendering, but cached data is not the
canonical network world.

When connectivity returns, the device resolves the Git checkpoint, verifies it,
then either:

- resumes from canonical HEAD, or
- submits a signed pending action for revalidation.

Offline actions must never silently overwrite a newer world checkpoint.
