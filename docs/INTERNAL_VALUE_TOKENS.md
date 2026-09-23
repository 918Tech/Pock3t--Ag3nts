# Pocket Agents Internal Value Tokens — PA-VALUE/1

## Purpose

Pocket Agent Value (**PAV**) is the closed-loop accounting unit for the Pocket
Agents game economy.

PAV is intentionally **not** a blockchain asset. PA-VALUE/1 has no external
wallet, withdrawal, cash-redemption, token contract, or independent chain state.
Its canonical balances live inside the same Git-backed Pocket Agents world state
as agents, skills, encounters, and provenance.

A PAV balance is therefore checkpointed by Git exactly like skill ownership.

## Unit model

- Display code: `PAV`
- Name: Pocket Agent Value
- Minor unit: `100`
- 100 minor units = 1.00 PAV
- All authoritative calculations use integer minor units.
- Floating point values are never stored in canonical state.

Example:

```text
18.00 PAV = 1800 minor units
```

## Closed-loop rules

PA-VALUE/1 ships with:

- `internalOnly = true`
- `withdrawable = false`
- `redeemableForCash = false`

Those properties are protocol invariants, not UI labels.

PAV can represent rewards, marketplace settlement, event fees, crafting sinks,
cosmetic purchases, and other game-native value flows without turning skill
ownership into an unlimited purchase mechanic.

## State

```json
{
  "economy": {
    "schema": "PA-VALUE/1",
    "currency": {
      "code": "PAV",
      "name": "Pocket Agent Value",
      "minorUnit": 100,
      "internalOnly": true,
      "withdrawable": false,
      "redeemableForCash": false
    },
    "policy": {
      "issuerAccountId": "SYS:TREASURY",
      "mintAuthority": "SYSTEM",
      "marketplaceFeeBps": 500,
      "maxSupplyMinor": null
    },
    "totalSupplyMinor": 0,
    "journalSequence": 0,
    "accounts": {
      "SYS:TREASURY": {
        "id": "SYS:TREASURY",
        "ownerType": "system",
        "ownerId": "POCKET",
        "balanceMinor": 0
      }
    },
    "journal": {}
  }
}
```

Agent account IDs are deterministic:

```text
AGENT:GHOST-918
AGENT:VOID-221
```

Accounts are permanent ledger identities. Zero-balance accounts may remain in
state so historical journal entries never reference a deleted account.

## Journal operations

Every PAV mutation appends one ordered journal entry.

### MINT

Creates new internal value.

Requirements:

- positive integer amount,
- target agent exists,
- authority matches `policy.mintAuthority`,
- optional max-supply policy remains satisfied.

Supply increases by the minted amount.

### BURN

Permanently removes PAV from circulation.

Supply decreases by the burned amount.

### TRANSFER

Moves PAV between two agent accounts.

Total supply is unchanged.

### MARKETPLACE

Atomically settles a purchase:

```text
buyer pays price
      |
      +---- seller receives price - fee
      |
      +---- SYS:TREASURY receives fee
```

The default marketplace fee is 500 basis points (5%). The fee is transferred,
not minted.

For a price of 18.00 PAV:

```text
price             1800 minor
5% fee              90 minor
seller receives   1710 minor
treasury receives   90 minor
```

## Git checkpoint law

PAV never mutates independently of the game world.

A durable value operation is:

```text
load world/live HEAD
       |
validate state/action
       |
construct next world
       |
apply PA-VALUE mutation
       |
append value journal
       |
run world invariants
       |
compute stateRoot
       |
Git commit
       |
new commit SHA = checkpoint
```

A token transfer and a skill transfer may be composed into the **same**
Git checkpoint. This is required for marketplace settlement so there is no
checkpoint where payment happened but the asset did not move, or vice versa.

## Marketplace atomicity

The marketplace domain should compose both engines:

```js
await POCKET.gitWorld.checkpoint({
  type: "MARKET_SALE",
  payload: { listingId },
  mutate(next) {
    POCKET.transfers.applyValidatedTransition(next, skillClaim);

    POCKET.valueTokens.applyMarketplaceSettlement(next, {
      buyerAgentId,
      sellerAgentId,
      priceMinor,
      listingId
    });

    // listing -> sold in the same next-state snapshot
  }
});
```

The UI may request this operation. It may not directly edit balances.

## Supply invariant

For every valid checkpoint:

```text
totalSupplyMinor
==
sum(all account.balanceMinor)
==
sum(MINT amounts) - sum(BURN amounts)
```

Transfers and marketplace settlements do not alter total supply.

The integrity validator replays the complete PAV journal from zero and compares
the replayed balances with the canonical account balances.

## Security boundary

The static browser can construct a proposed PAV transition, but mint authority is
not secured merely by the string `"SYSTEM"`.

For multiplayer, the GitHub App-backed world writer must authorize privileged
operations before creating a world commit. The repository integrity gate then
verifies the resulting accounting state.

No GitHub credential belongs in the Pages application or CYD firmware.

## Monetization boundary

PAV is deliberately separate from real-money payment processing.

External payment systems may later authorize specific closed-loop game actions,
but they must not:

- rewrite historical balances,
- duplicate scarce SkillInstances,
- reverse legitimate skill losses,
- bypass the Git checkpoint sequence,
- create PAV without an authorized MINT journal entry.

Money may purchase access, cosmetics, services, or other approved products.
Scarce skill ownership remains governed by the Pocket Agents ownership protocol.
