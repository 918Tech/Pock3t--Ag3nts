#!/usr/bin/env node
import assert from "node:assert/strict";
import "../web/js/value-tokens.js";

function genesisEconomy() {
  return {
    schema: "PA-VALUE/1",
    currency: {
      code: "PAV",
      name: "Pocket Agent Value",
      minorUnit: 100,
      internalOnly: true,
      withdrawable: false,
      redeemableForCash: false,
    },
    policy: {
      issuerAccountId: "SYS:TREASURY",
      mintAuthority: "SYSTEM",
      marketplaceFeeBps: 500,
      maxSupplyMinor: null,
    },
    totalSupplyMinor: 0,
    journalSequence: 0,
    accounts: {
      "SYS:TREASURY": {
        id: "SYS:TREASURY",
        ownerType: "system",
        ownerId: "POCKET",
        balanceMinor: 0,
      },
    },
    journal: {},
  };
}

const state = {
  agents: {
    "GHOST-918": { id: "GHOST-918" },
    "VOID-221": { id: "VOID-221" },
  },
  economy: genesisEconomy(),
};

const engine = globalThis.PocketValueTokens.createEngine();

engine.applyMint(state, {
  agentId: "GHOST-918",
  amountMinor: 2500,
  reason: "selftest-reward",
  at: "2026-09-23T00:00:01Z",
});

assert.equal(engine.balanceMinor(state, "GHOST-918"), 2500);
assert.equal(state.economy.totalSupplyMinor, 2500);

engine.applyTransfer(state, {
  fromAgentId: "GHOST-918",
  toAgentId: "VOID-221",
  amountMinor: 500,
  at: "2026-09-23T00:00:02Z",
});

assert.equal(engine.balanceMinor(state, "GHOST-918"), 2000);
assert.equal(engine.balanceMinor(state, "VOID-221"), 500);
assert.equal(state.economy.totalSupplyMinor, 2500);

engine.applyMarketplaceSettlement(state, {
  buyerAgentId: "GHOST-918",
  sellerAgentId: "VOID-221",
  priceMinor: 1000,
  listingId: "LIST-1",
  at: "2026-09-23T00:00:03Z",
});

assert.equal(engine.balanceMinor(state, "GHOST-918"), 1000);
assert.equal(engine.balanceMinor(state, "VOID-221"), 1450);
assert.equal(state.economy.accounts["SYS:TREASURY"].balanceMinor, 50);
assert.equal(state.economy.totalSupplyMinor, 2500);

engine.applyBurn(state, {
  agentId: "VOID-221",
  amountMinor: 450,
  at: "2026-09-23T00:00:04Z",
});

assert.equal(engine.balanceMinor(state, "VOID-221"), 1000);
assert.equal(state.economy.totalSupplyMinor, 2050);
assert.equal(state.economy.journalSequence, 4);

assert.throws(
  () =>
    engine.applyTransfer(state, {
      fromAgentId: "GHOST-918",
      toAgentId: "VOID-221",
      amountMinor: 999999,
    }),
  /Insufficient PAV balance/
);

console.log(
  JSON.stringify({
    ok: true,
    schema: state.economy.schema,
    totalSupplyMinor: state.economy.totalSupplyMinor,
    journalSequence: state.economy.journalSequence,
    ghost: engine.balanceMinor(state, "GHOST-918"),
    void: engine.balanceMinor(state, "VOID-221"),
    treasury: state.economy.accounts["SYS:TREASURY"].balanceMinor,
  })
);
