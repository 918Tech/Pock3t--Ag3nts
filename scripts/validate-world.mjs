#!/usr/bin/env node
/**
 * Pocket Agents world integrity validator.
 * Stdlib-only. No npm dependencies.
 *
 * Usage:
 *   node scripts/validate-world.mjs [world/state.json]
 */
import fs from "node:fs";
import crypto from "node:crypto";

const file = process.argv[2] || "world/state.json";
const raw = fs.readFileSync(file, "utf8");
const state = JSON.parse(raw);

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
  const hex = crypto
    .createHash("sha256")
    .update(canonicalJSONString(projected), "utf8")
    .digest("hex");
  return "sha256:" + hex;
}

if (state.schema !== "PA-WORLD/1") {
  fail("schema must be PA-WORLD/1", { schema: state.schema });
}

if (!Number.isInteger(state.world?.sequence) || state.world.sequence < 0) {
  fail("world.sequence must be a non-negative integer");
}

if (state.integrity?.algorithm !== "SHA-256") {
  fail("integrity.algorithm must be SHA-256");
}

if (!state.integrity?.stateRoot) {
  fail("integrity.stateRoot is required");
}

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
  }

  if (["destroyed", "retired"].includes(lifecycle)) {
    if (ownerFromInventory) {
      fail("destroyed/retired skill remains in inventory", {
        uid,
        lifecycle,
        inventoryOwner: ownerFromInventory,
      });
    }
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
  if (["destroyed", "retired"].includes(skill.state)) {
    fail("listing references non-circulating skill", {
      listingId,
      uid,
      state: skill.state,
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
      stateRoot: state.integrity.stateRoot,
    },
    null,
    2
  )
);
