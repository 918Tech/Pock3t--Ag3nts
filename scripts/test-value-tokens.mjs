#!/usr/bin/env node
import assert from "node:assert/strict";
import "../web/js/value-tokens.js";

const engine = globalThis.PocketValueTokens.createEngine();

const state = {
  agents: {
    "A-1": { id: "A-1" },
    "B-1": { id: "B-1" }
  },
  economy: {
    schema: "PA-VALUE/2",
    tokens: {
      CRT: {
        code: "CRT",
        totalSupplyMinor: 0,
        policy: {
          mintAuthority: "SYSTEM",
          marketplaceFeeBps: 500,
          rarityAwardMinor: {
            common: 100,
            uncommon: 300,
            rare: 1000,
            legendary: 5000
          }
        }
      },
      HVT: {
        code: "HVT",
        totalSupplyMinor: 0,
        policy: {
          mintAuthority: "SYSTEM",
          transferMode: "hardware-coupled",
          hardwareClassValueMinor: {
            "CYD-2432S028R": 1000
          }
        }
      }
    },
    journalSequence: 0,
    accounts: {
      "SYS:TREASURY": {
        id: "SYS:TREASURY",
        ownerType: "system",
        ownerId: "POCKET",
        balancesMinor: { CRT: 0, HVT: 0 }
      }
    },
    claims: {},
    hardware: {},
    journal: {}
  }
};

engine.applyCodeRarityAward(state, {
  agentId: "A-1",
  artifactId: "CODE-1",
  rarityClass: "rare",
  rarityBasisHash: "sha256:code",
  claimId: "CRT-CLAIM-1",
  at: "2026-09-23T00:00:00Z"
});
assert.equal(engine.balanceMinor(state, "A-1", "CRT"), 1000);

engine.applyHardwareRegistration(state, {
  agentId: "A-1",
  hardwareId: "CYD-1",
  hardwareClass: "CYD-2432S028R",
  attestationHash: "sha256:attest-a",
  claimId: "HVT-CLAIM-1",
  at: "2026-09-23T00:01:00Z"
});
assert.equal(engine.balanceMinor(state, "A-1", "HVT"), 1000);

assert.throws(
  () => engine.applyTransfer(state, {
    code: "HVT",
    fromAgentId: "A-1",
    toAgentId: "B-1",
    amountMinor: 1000,
    claimId: "BAD-HVT"
  }),
  /hardware-coupled/
);

engine.applyHardwareOwnershipTransfer(state, {
  hardwareId: "CYD-1",
  fromAgentId: "A-1",
  toAgentId: "B-1",
  attestationHash: "sha256:attest-b",
  claimId: "HVT-XFER-1",
  at: "2026-09-23T00:02:00Z"
});

assert.equal(engine.balanceMinor(state, "A-1", "HVT"), 0);
assert.equal(engine.balanceMinor(state, "B-1", "HVT"), 1000);
assert.equal(state.economy.hardware["CYD-1"].ownerAgentId, "B-1");

engine.applyHardwareRetirement(state, {
  hardwareId: "CYD-1",
  agentId: "B-1",
  evidenceHash: "sha256:retire",
  claimId: "HVT-RETIRE-1",
  at: "2026-09-23T00:03:00Z"
});

assert.equal(engine.balanceMinor(state, "B-1", "HVT"), 0);
assert.equal(state.economy.tokens.HVT.totalSupplyMinor, 0);

console.log(JSON.stringify({
  ok: true,
  crtSupplyMinor: state.economy.tokens.CRT.totalSupplyMinor,
  hvtSupplyMinor: state.economy.tokens.HVT.totalSupplyMinor,
  journalSequence: state.economy.journalSequence
}));
