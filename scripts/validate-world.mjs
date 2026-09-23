#!/usr/bin/env node
/**
 * Pocket Agents world integrity validator.
 * Validates skills, exports, marketplace state, CRT/HVT accounting and roots.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const file = process.argv[2] || "world/state.json";
const state = JSON.parse(fs.readFileSync(file, "utf8"));

function fail(message, details = undefined) {
  console.error("POCKET_WORLD_INVALID:", message);
  if (details !== undefined) console.error(JSON.stringify(details, null, 2));
  process.exit(1);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function canonicalJSONString(value) {
  return JSON.stringify(stableValue(value));
}

function computeStateRoot(world) {
  const projected = structuredClone(world);
  projected.integrity ||= {};
  projected.integrity.stateRoot = null;
  return (
    "sha256:" +
    crypto.createHash("sha256").update(canonicalJSONString(projected), "utf8").digest("hex")
  );
}

function safeInt(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail(label + " must be a safe integer >= " + min, { value });
  }
}

if (state.schema !== "PA-WORLD/1") fail("schema must be PA-WORLD/1");
safeInt(state.world?.sequence, "world.sequence");

if (state.integrity?.algorithm !== "SHA-256") fail("integrity.algorithm must be SHA-256");
if (!state.integrity?.stateRoot) fail("integrity.stateRoot is required");

const calculatedRoot = computeStateRoot(state);
if (calculatedRoot !== state.integrity.stateRoot) {
  fail("stateRoot mismatch", {
    stored: state.integrity.stateRoot,
    calculated: calculatedRoot,
  });
}

const agents = state.agents || {};
const skills = state.skills || {};
const inventories = state.inventories || {};
const listings = state.listings || {};
const exportsMap = state.exports || {};
const genesis = state.genesis || {};

for (const [agentId, agent] of Object.entries(agents)) {
  if (agent?.id && agent.id !== agentId) {
    fail("agent key/id mismatch", { agentId, embeddedId: agent.id });
  }
}

const inventoryOwners = new Map();

for (const [agentId, inventory] of Object.entries(inventories)) {
  if (!agents[agentId]) fail("inventory references missing agent", { agentId });
  const ids = Array.isArray(inventory)
    ? inventory
    : Array.isArray(inventory?.skills)
      ? inventory.skills
      : [];

  const seen = new Set();
  for (const uid of ids) {
    if (seen.has(uid)) fail("duplicate skill in one inventory", { agentId, uid });
    seen.add(uid);
    if (inventoryOwners.has(uid)) {
      fail("skill instance appears in multiple inventories", {
        uid,
        firstOwner: inventoryOwners.get(uid),
        secondOwner: agentId,
      });
    }
    inventoryOwners.set(uid, agentId);
  }
}

const countedByGenesis = new Map();

for (const [uid, skill] of Object.entries(skills)) {
  if (skill?.uid && skill.uid !== uid) {
    fail("skill key/uid mismatch", { uid, embeddedUid: skill.uid });
  }

  const lifecycle = skill?.state || "active";
  const ownerFromInventory = inventoryOwners.get(uid) || null;

  if (["active", "locked", "in_transfer"].includes(lifecycle)) {
    if (!skill.ownerId) fail("owned lifecycle skill has no ownerId", { uid, lifecycle });
    if (!agents[skill.ownerId]) {
      fail("skill ownerId references missing agent", { uid, ownerId: skill.ownerId });
    }
    if (ownerFromInventory !== skill.ownerId) {
      fail("skill ownerId and inventory disagree", {
        uid,
        ownerId: skill.ownerId,
        inventoryOwner: ownerFromInventory,
      });
    }
  } else if (["destroyed", "retired", "exported"].includes(lifecycle)) {
    if (ownerFromInventory) {
      fail("non-owned lifecycle skill remains in inventory", {
        uid,
        lifecycle,
        inventoryOwner: ownerFromInventory,
      });
    }
    if (lifecycle === "exported") {
      if (skill.ownerId !== null) fail("exported skill must have ownerId=null", { uid });
      const record = exportsMap[skill.exportId];
      if (!record || record.state !== "open" || record.skillInstanceId !== uid) {
        fail("exported skill does not have one open export escrow", {
          uid,
          exportId: skill.exportId,
        });
      }
    }
  } else {
    fail("unknown skill lifecycle", { uid, lifecycle });
  }

  if (skill.genesisId) {
    countedByGenesis.set(
      skill.genesisId,
      (countedByGenesis.get(skill.genesisId) || 0) + 1
    );
  }
}

for (const [genesisId, count] of countedByGenesis.entries()) {
  const record = genesis[genesisId];
  if (!record) fail("skill references missing genesis record", { genesisId });
  const cap = Number(record.supply ?? record.genesisCap ?? Infinity);
  if (Number.isFinite(cap) && count > cap) {
    fail("genesis supply exceeded", { genesisId, count, cap });
  }
}

for (const [listingId, listing] of Object.entries(listings)) {
  if (!["open", "reserved"].includes(listing?.state)) continue;
  const uid = listing.skillInstanceId || listing.uid;
  const skill = skills[uid];
  if (!skill) fail("active listing references missing skill", { listingId, uid });
  if (skill.ownerId !== listing.sellerAgentId) {
    fail("listing seller does not own skill", {
      listingId,
      uid,
      sellerAgentId: listing.sellerAgentId,
      ownerId: skill.ownerId,
    });
  }
  if (skill.state !== "locked") {
    fail("active listing skill must be locked", { listingId, uid, state: skill.state });
  }
  if (listing.currencyCode && listing.currencyCode !== "CRT") {
    fail("skill marketplace currency must be CRT", {
      listingId,
      currencyCode: listing.currencyCode,
    });
  }
}

const openExportBySkill = new Map();
for (const [exportId, record] of Object.entries(exportsMap)) {
  if (record?.exportId && record.exportId !== exportId) {
    fail("export key/id mismatch", { exportId, embeddedId: record.exportId });
  }
  if (!skills[record.skillInstanceId]) {
    fail("export references missing skill", { exportId, skillInstanceId: record.skillInstanceId });
  }
  if (record.state === "open") {
    if (openExportBySkill.has(record.skillInstanceId)) {
      fail("skill has multiple open exports", {
        skillInstanceId: record.skillInstanceId,
        exports: [openExportBySkill.get(record.skillInstanceId), exportId],
      });
    }
    openExportBySkill.set(record.skillInstanceId, exportId);
  }
}

const economy = state.economy;
if (!economy || economy.schema !== "PA-VALUE/2") {
  fail("economy.schema must be PA-VALUE/2");
}

const tokenCodes = ["CRT", "HVT"];
const replayBalances = new Map();
const replaySupply = { CRT: 0, HVT: 0 };
const seenClaims = new Set();

function addReplay(accountId, code, delta) {
  if (!accountId) return;
  const key = accountId + "::" + code;
  replayBalances.set(key, (replayBalances.get(key) || 0) + delta);
  if (replayBalances.get(key) < 0) {
    fail("token journal replay produces negative balance", {
      accountId,
      code,
      balanceMinor: replayBalances.get(key),
    });
  }
}

for (const code of tokenCodes) {
  const token = economy.tokens?.[code];
  if (!token || token.code !== code) fail("missing token definition", { code });
  if (
    token.internalOnly !== true ||
    token.withdrawable !== false ||
    token.redeemableForCash !== false
  ) {
    fail("internal token closed-loop flags invalid", { code });
  }
  safeInt(token.totalSupplyMinor, code + ".totalSupplyMinor");
}

const journalEntries = Object.values(economy.journal || {}).sort(
  (a, b) => Number(a.seq) - Number(b.seq)
);

let expectedSeq = 1;
for (const entry of journalEntries) {
  if (entry.seq !== expectedSeq) {
    fail("token journal sequence gap", { expectedSeq, actualSeq: entry.seq, id: entry.id });
  }
  expectedSeq += 1;

  const code = entry.code;
  if (!tokenCodes.includes(code)) fail("journal references unknown token", { code });

  if (entry.claimId) {
    if (seenClaims.has(entry.claimId)) {
      fail("token claim reused in journal", { claimId: entry.claimId });
    }
    seenClaims.add(entry.claimId);
    if (!economy.claims?.[entry.claimId]) {
      fail("journal claim is missing from claims registry", { claimId: entry.claimId });
    }
  }

  switch (entry.kind) {
    case "MINT":
      safeInt(entry.amountMinor, "MINT amountMinor", 1);
      replaySupply[code] += entry.amountMinor;
      addReplay(entry.toAccountId, code, entry.amountMinor);
      break;
    case "BURN":
      safeInt(entry.amountMinor, "BURN amountMinor", 1);
      replaySupply[code] -= entry.amountMinor;
      addReplay(entry.fromAccountId, code, -entry.amountMinor);
      break;
    case "TRANSFER":
    case "HARDWARE_TRANSFER":
      safeInt(entry.amountMinor, entry.kind + " amountMinor", 1);
      addReplay(entry.fromAccountId, code, -entry.amountMinor);
      addReplay(entry.toAccountId, code, entry.amountMinor);
      break;
    case "MARKETPLACE":
      if (code !== "CRT") fail("marketplace journal must use CRT");
      safeInt(entry.amountMinor, "MARKETPLACE amountMinor", 1);
      addReplay(entry.fromAccountId, "CRT", -entry.amountMinor);
      addReplay(entry.toAccountId, "CRT", entry.sellerAmountMinor);
      addReplay(entry.feeAccountId, "CRT", entry.feeMinor);
      if (entry.sellerAmountMinor + entry.feeMinor !== entry.amountMinor) {
        fail("marketplace settlement does not conserve CRT", { id: entry.id });
      }
      break;
    default:
      fail("unknown token journal kind", { kind: entry.kind, id: entry.id });
  }
}

if (Number(economy.journalSequence || 0) !== journalEntries.length) {
  fail("journalSequence does not match journal length", {
    journalSequence: economy.journalSequence,
    journalLength: journalEntries.length,
  });
}

for (const [accountId, account] of Object.entries(economy.accounts || {})) {
  if (account.id !== accountId) fail("token account key/id mismatch", { accountId });
  for (const code of tokenCodes) {
    const actual = Number(account.balancesMinor?.[code] || 0);
    safeInt(actual, accountId + "." + code);
    const replay = replayBalances.get(accountId + "::" + code) || 0;
    if (actual !== replay) {
      fail("token account balance differs from journal replay", {
        accountId,
        code,
        actual,
        replay,
      });
    }
  }
}

for (const code of tokenCodes) {
  if (replaySupply[code] !== economy.tokens[code].totalSupplyMinor) {
    fail("token total supply differs from journal replay", {
      code,
      actual: economy.tokens[code].totalSupplyMinor,
      replay: replaySupply[code],
    });
  }
}

let activeHardwareValue = 0;
const activeHardwareByOwner = new Map();
for (const [hardwareId, hardware] of Object.entries(economy.hardware || {})) {
  if (hardware.hardwareId !== hardwareId) {
    fail("hardware key/id mismatch", { hardwareId });
  }
  safeInt(hardware.valueMinor, hardwareId + ".valueMinor", 1);

  if (hardware.status === "active") {
    if (!agents[hardware.ownerAgentId]) {
      fail("active hardware references missing agent", {
        hardwareId,
        ownerAgentId: hardware.ownerAgentId,
      });
    }
    activeHardwareValue += hardware.valueMinor;
    activeHardwareByOwner.set(
      hardware.ownerAgentId,
      (activeHardwareByOwner.get(hardware.ownerAgentId) || 0) + hardware.valueMinor
    );
  } else if (hardware.status !== "retired") {
    fail("unknown hardware status", { hardwareId, status: hardware.status });
  }
}

if (activeHardwareValue !== economy.tokens.HVT.totalSupplyMinor) {
  fail("HVT supply must equal active registered hardware value", {
    activeHardwareValue,
    hvtSupply: economy.tokens.HVT.totalSupplyMinor,
  });
}

for (const [agentId, expectedHvt] of activeHardwareByOwner.entries()) {
  const account = economy.accounts?.["AGENT:" + agentId];
  const actualHvt = Number(account?.balancesMinor?.HVT || 0);
  if (actualHvt !== expectedHvt) {
    fail("agent HVT must equal value of active hardware owned", {
      agentId,
      expectedHvt,
      actualHvt,
    });
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      schema: state.schema,
      sequence: state.world.sequence,
      agents: Object.keys(agents).length,
      skills: Object.keys(skills).length,
      openExports: openExportBySkill.size,
      crtSupplyMinor: economy.tokens.CRT.totalSupplyMinor,
      hvtSupplyMinor: economy.tokens.HVT.totalSupplyMinor,
      stateRoot: state.integrity.stateRoot,
    },
    null,
    2
  )
);
