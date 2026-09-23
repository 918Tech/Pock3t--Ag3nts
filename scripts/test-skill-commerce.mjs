#!/usr/bin/env node
import assert from "node:assert/strict";
import "../web/js/value-tokens.js";
import "../web/js/skill-commerce.js";

const value = globalThis.PocketValueTokens.createEngine();
globalThis.POCKET = { valueTokens: value };
const commerce = globalThis.PocketSkillCommerce.createEngine();

const state = {
  agents: {
    "BUYER-1": { id: "BUYER-1" },
    "SELLER-1": { id: "SELLER-1" }
  },
  skills: {
    "SKILL-1": {
      uid: "SKILL-1",
      defId: "rf-ghost",
      ownerId: "SELLER-1",
      state: "active",
      revision: 1,
      transfers: 0
    }
  },
  inventories: {
    "BUYER-1": { skills: [] },
    "SELLER-1": { skills: ["SKILL-1"] }
  },
  listings: {},
  exports: {},
  commerce: { sequence: 0, events: {} },
  economy: {
    schema: "PA-VALUE/2",
    tokens: {
      CRT: {
        code: "CRT",
        totalSupplyMinor: 10000,
        policy: { mintAuthority: "SYSTEM", marketplaceFeeBps: 500 }
      },
      HVT: {
        code: "HVT",
        totalSupplyMinor: 0,
        policy: { mintAuthority: "SYSTEM", transferMode: "hardware-coupled" }
      }
    },
    journalSequence: 1,
    accounts: {
      "SYS:TREASURY": {
        id: "SYS:TREASURY",
        ownerType: "system",
        ownerId: "POCKET",
        balancesMinor: { CRT: 0, HVT: 0 }
      },
      "AGENT:BUYER-1": {
        id: "AGENT:BUYER-1",
        ownerType: "agent",
        ownerId: "BUYER-1",
        balancesMinor: { CRT: 10000, HVT: 0 }
      },
      "AGENT:SELLER-1": {
        id: "AGENT:SELLER-1",
        ownerType: "agent",
        ownerId: "SELLER-1",
        balancesMinor: { CRT: 0, HVT: 0 }
      }
    },
    claims: {
      "SEED-CRT": { kind: "MINT", code: "CRT", agentId: "BUYER-1", amountMinor: 10000 }
    },
    hardware: {},
    journal: {
      "VAL-0000000001": {
        id: "VAL-0000000001",
        seq: 1,
        kind: "MINT",
        code: "CRT",
        amountMinor: 10000,
        fromAccountId: null,
        toAccountId: "AGENT:BUYER-1",
        authorityId: "SYSTEM",
        claimId: "SEED-CRT",
        reason: "test-seed",
        evidence: {
          artifactId: "seed",
          rarityClass: "legendary",
          rarityBasisHash: "sha256:seed"
        },
        at: "2026-09-23T00:00:00Z"
      }
    }
  }
};

commerce.applyListSkill(state, {
  listingId: "LIST-1",
  sellerAgentId: "SELLER-1",
  skillInstanceId: "SKILL-1",
  priceMinor: 1800,
  at: "2026-09-23T00:01:00Z"
});
assert.equal(state.skills["SKILL-1"].state, "locked");

commerce.applyBuySkill(state, {
  listingId: "LIST-1",
  buyerAgentId: "BUYER-1",
  paymentClaimId: "PAY-1",
  at: "2026-09-23T00:02:00Z"
});

assert.equal(state.skills["SKILL-1"].ownerId, "BUYER-1");
assert.equal(state.skills["SKILL-1"].state, "active");
assert.deepEqual(state.inventories["BUYER-1"].skills, ["SKILL-1"]);
assert.deepEqual(state.inventories["SELLER-1"].skills, []);
assert.equal(value.balanceMinor(state, "BUYER-1", "CRT"), 8200);
assert.equal(value.balanceMinor(state, "SELLER-1", "CRT"), 1710);
assert.equal(state.economy.accounts["SYS:TREASURY"].balancesMinor.CRT, 90);

commerce.applyExportSkill(state, {
  exportId: "EXP-1",
  ownerAgentId: "BUYER-1",
  skillInstanceId: "SKILL-1",
  at: "2026-09-23T00:03:00Z"
});

assert.equal(state.skills["SKILL-1"].state, "exported");
assert.equal(state.skills["SKILL-1"].ownerId, null);
assert.deepEqual(state.inventories["BUYER-1"].skills, []);

const pkg = commerce.buildExportPackage({
  state: { ...state, integrity: { stateRoot: "sha256:test" } },
  checkpoint: "abc1234",
  exportId: "EXP-1"
});
assert.equal(pkg.schema, "PA-SKILL-PACKAGE/1");
assert.equal(pkg.export.exportId, "EXP-1");
assert.equal(pkg.skill.uid, "SKILL-1");

commerce.applyImportSkill(state, {
  exportId: "EXP-1",
  toAgentId: "SELLER-1",
  packageCheckpoint: "abc1234",
  at: "2026-09-23T00:04:00Z"
});

assert.equal(state.skills["SKILL-1"].state, "active");
assert.equal(state.skills["SKILL-1"].ownerId, "SELLER-1");
assert.deepEqual(state.inventories["SELLER-1"].skills, ["SKILL-1"]);
assert.equal(state.exports["EXP-1"].state, "consumed");

console.log(JSON.stringify({
  ok: true,
  owner: state.skills["SKILL-1"].ownerId,
  crtBuyer: value.balanceMinor(state, "BUYER-1", "CRT"),
  crtSeller: value.balanceMinor(state, "SELLER-1", "CRT"),
  treasury: state.economy.accounts["SYS:TREASURY"].balancesMinor.CRT,
  exportState: state.exports["EXP-1"].state
}));
