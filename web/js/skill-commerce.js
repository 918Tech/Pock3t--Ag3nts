/*
 * Pocket Agents Skill Commerce + Export
 * PA-SKILL-COMMERCE/1
 *
 * Buy: skill ownership + CRT settlement + listing close occur in ONE Git checkpoint.
 * Export: skill leaves agent inventory and enters a unique export escrow record.
 * A downloaded export package is a receipt/carrier, never a clone.
 */
(function (global) {
  "use strict";

  const SCHEMA = "PA-SKILL-COMMERCE/1";

  class SkillCommerceError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "SkillCommerceError";
      this.details = details;
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function requireAgent(state, agentId) {
    const agent = state.agents?.[agentId];
    if (!agent) throw new SkillCommerceError("Agent does not exist.", { agentId });
    return agent;
  }

  function requireSkill(state, uid) {
    const skill = state.skills?.[uid];
    if (!skill) {
      throw new SkillCommerceError("Skill instance does not exist.", { uid });
    }
    return skill;
  }

  function inventoryArray(state, agentId) {
    requireAgent(state, agentId);
    state.inventories ||= {};
    state.inventories[agentId] ||= { skills: [] };
    const inventory = state.inventories[agentId];
    if (Array.isArray(inventory)) return inventory;
    inventory.skills ||= [];
    return inventory.skills;
  }

  function activeListingForSkill(state, uid) {
    return Object.values(state.listings || {}).find(
      (listing) =>
        (listing.skillInstanceId || listing.uid) === uid &&
        ["open", "reserved"].includes(listing.state)
    );
  }

  function nextCommerceEvent(state) {
    state.commerce ||= { sequence: 0, events: {} };
    state.commerce.events ||= {};
    const seq = Number(state.commerce.sequence || 0) + 1;
    state.commerce.sequence = seq;
    return {
      seq,
      id: `COM-${String(seq).padStart(10, "0")}`,
    };
  }

  function appendCommerce(state, event) {
    const { seq, id } = nextCommerceEvent(state);
    state.commerce.events[id] = { id, seq, ...event };
    return state.commerce.events[id];
  }

  function removeOne(list, uid) {
    const index = list.indexOf(uid);
    if (index < 0) {
      throw new SkillCommerceError("Skill not present in expected inventory.", {
        uid,
      });
    }
    list.splice(index, 1);
  }

  function addUnique(list, uid) {
    if (list.includes(uid)) {
      throw new SkillCommerceError("Skill already exists in destination inventory.", {
        uid,
      });
    }
    list.push(uid);
  }

  function requireTokenEngine() {
    const engine =
      global.POCKET?.valueTokens ||
      global.PocketValueTokens?.createEngine?.();
    if (!engine?.applyMarketplaceSettlement) {
      throw new SkillCommerceError("PA-VALUE/2 token engine is required.");
    }
    return engine;
  }

  function applyListSkill(state, {
    listingId,
    sellerAgentId,
    skillInstanceId,
    priceMinor,
    currencyCode = "CRT",
    at = new Date().toISOString(),
  }) {
    if (!listingId) throw new SkillCommerceError("listingId is required.");
    if (currencyCode !== "CRT") {
      throw new SkillCommerceError("Skill marketplace currently settles in CRT.");
    }
    if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0) {
      throw new SkillCommerceError("priceMinor must be a positive integer.");
    }

    requireAgent(state, sellerAgentId);
    const skill = requireSkill(state, skillInstanceId);
    if (skill.ownerId !== sellerAgentId || (skill.state || "active") !== "active") {
      throw new SkillCommerceError("Seller does not own an active skill.", {
        sellerAgentId,
        skillInstanceId,
        ownerId: skill.ownerId,
        state: skill.state,
      });
    }

    const sellerInventory = inventoryArray(state, sellerAgentId);
    if (!sellerInventory.includes(skillInstanceId)) {
      throw new SkillCommerceError("Seller inventory/skill owner mismatch.");
    }

    if (activeListingForSkill(state, skillInstanceId)) {
      throw new SkillCommerceError("Skill already has an active listing.");
    }

    state.listings ||= {};
    if (state.listings[listingId]) {
      throw new SkillCommerceError("listingId already exists.", { listingId });
    }

    skill.state = "locked";
    skill.revision = Number(skill.revision || 0) + 1;

    state.listings[listingId] = {
      listingId,
      skillInstanceId,
      sellerAgentId,
      priceMinor,
      currencyCode,
      state: "open",
      createdAt: at,
    };

    appendCommerce(state, {
      kind: "SKILL_LISTED",
      listingId,
      skillInstanceId,
      sellerAgentId,
      priceMinor,
      currencyCode,
      at,
    });

    return state.listings[listingId];
  }

  function applyBuySkill(state, {
    listingId,
    buyerAgentId,
    paymentClaimId,
    at = new Date().toISOString(),
  }) {
    requireAgent(state, buyerAgentId);
    const listing = state.listings?.[listingId];
    if (!listing || listing.state !== "open") {
      throw new SkillCommerceError("Listing is not open.", { listingId });
    }
    if (listing.currencyCode !== "CRT") {
      throw new SkillCommerceError("Unsupported skill listing currency.", {
        currencyCode: listing.currencyCode,
      });
    }

    const sellerAgentId = listing.sellerAgentId;
    if (sellerAgentId === buyerAgentId) {
      throw new SkillCommerceError("Seller cannot buy their own skill.");
    }

    const uid = listing.skillInstanceId;
    const skill = requireSkill(state, uid);
    if (skill.ownerId !== sellerAgentId || skill.state !== "locked") {
      throw new SkillCommerceError("Listed skill ownership lock is invalid.", {
        uid,
        ownerId: skill.ownerId,
        state: skill.state,
      });
    }

    const sellerInventory = inventoryArray(state, sellerAgentId);
    const buyerInventory = inventoryArray(state, buyerAgentId);
    if (!sellerInventory.includes(uid)) {
      throw new SkillCommerceError("Seller inventory no longer contains listed skill.");
    }

    // Payment and ownership transfer are composed in this same next-state snapshot.
    const value = requireTokenEngine();
    const payment = value.applyMarketplaceSettlement(state, {
      buyerAgentId,
      sellerAgentId,
      priceMinor: listing.priceMinor,
      listingId,
      claimId: paymentClaimId,
      at,
    });

    removeOne(sellerInventory, uid);
    addUnique(buyerInventory, uid);

    skill.ownerId = buyerAgentId;
    skill.state = "active";
    skill.transfers = Number(skill.transfers || 0) + 1;
    skill.revision = Number(skill.revision || 0) + 1;
    skill.lastTransferAt = at;

    listing.state = "sold";
    listing.buyerAgentId = buyerAgentId;
    listing.soldAt = at;
    listing.paymentJournalId = payment.id;

    const event = appendCommerce(state, {
      kind: "SKILL_BOUGHT",
      listingId,
      skillInstanceId: uid,
      sellerAgentId,
      buyerAgentId,
      priceMinor: listing.priceMinor,
      currencyCode: "CRT",
      paymentJournalId: payment.id,
      at,
    });

    return { listing, skill, payment, event };
  }

  function applyExportSkill(state, {
    exportId,
    ownerAgentId,
    skillInstanceId,
    destination = "portable-package",
    at = new Date().toISOString(),
  }) {
    if (!exportId) throw new SkillCommerceError("exportId is required.");
    requireAgent(state, ownerAgentId);
    const skill = requireSkill(state, skillInstanceId);

    if (skill.ownerId !== ownerAgentId || (skill.state || "active") !== "active") {
      throw new SkillCommerceError("Only an active owned skill may be exported.", {
        ownerAgentId,
        skillInstanceId,
        ownerId: skill.ownerId,
        state: skill.state,
      });
    }
    if (activeListingForSkill(state, skillInstanceId)) {
      throw new SkillCommerceError("Listed skill cannot be exported.");
    }

    state.exports ||= {};
    if (state.exports[exportId]) {
      throw new SkillCommerceError("exportId already exists.", { exportId });
    }

    const inventory = inventoryArray(state, ownerAgentId);
    removeOne(inventory, skillInstanceId);

    skill.ownerId = null;
    skill.state = "exported";
    skill.exportId = exportId;
    skill.revision = Number(skill.revision || 0) + 1;
    skill.lastExportAt = at;

    state.exports[exportId] = {
      schema: "PA-SKILL-EXPORT/1",
      exportId,
      skillInstanceId,
      previousOwnerAgentId: ownerAgentId,
      destination,
      state: "open",
      createdAt: at,
      skillRevision: skill.revision,
    };

    appendCommerce(state, {
      kind: "SKILL_EXPORTED",
      exportId,
      skillInstanceId,
      previousOwnerAgentId: ownerAgentId,
      destination,
      at,
    });

    return state.exports[exportId];
  }

  function applyImportSkill(state, {
    exportId,
    toAgentId,
    packageCheckpoint,
    at = new Date().toISOString(),
  }) {
    requireAgent(state, toAgentId);
    const record = state.exports?.[exportId];
    if (!record || record.state !== "open") {
      throw new SkillCommerceError("Export is not open.", { exportId });
    }

    const skill = requireSkill(state, record.skillInstanceId);
    if (
      skill.state !== "exported" ||
      skill.ownerId !== null ||
      skill.exportId !== exportId
    ) {
      throw new SkillCommerceError("Exported skill state is inconsistent.", {
        exportId,
        skillInstanceId: record.skillInstanceId,
      });
    }

    const inventory = inventoryArray(state, toAgentId);
    addUnique(inventory, skill.uid || record.skillInstanceId);

    skill.ownerId = toAgentId;
    skill.state = "active";
    skill.exportId = null;
    skill.transfers = Number(skill.transfers || 0) + 1;
    skill.revision = Number(skill.revision || 0) + 1;
    skill.lastImportAt = at;

    record.state = "consumed";
    record.toAgentId = toAgentId;
    record.consumedAt = at;
    record.packageCheckpoint = packageCheckpoint || null;

    appendCommerce(state, {
      kind: "SKILL_IMPORTED",
      exportId,
      skillInstanceId: record.skillInstanceId,
      toAgentId,
      packageCheckpoint: packageCheckpoint || null,
      at,
    });

    return { record, skill };
  }

  function buildExportPackage({ state, checkpoint, exportId }) {
    if (!checkpoint) {
      throw new SkillCommerceError("Checkpoint SHA is required for export package.");
    }
    const record = state.exports?.[exportId];
    if (!record || record.state !== "open") {
      throw new SkillCommerceError("Open export record not found.", { exportId });
    }
    const skill = requireSkill(state, record.skillInstanceId);
    if (skill.state !== "exported" || skill.exportId !== exportId) {
      throw new SkillCommerceError("Skill is not held by this export escrow.");
    }

    return {
      schema: "PA-SKILL-PACKAGE/1",
      checkpoint,
      worldStateRoot: state.integrity?.stateRoot || null,
      export: clone(record),
      skill: clone(skill),
      notice:
        "Carrier record only. Canonical ownership remains in the Git-backed Pocket Agents world.",
    };
  }

  function downloadExportPackage(args) {
    const pkg = buildExportPackage(args);
    if (typeof document === "undefined") return JSON.stringify(pkg, null, 2);

    const blob = new Blob([JSON.stringify(pkg, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pkg.export.exportId}.paskill.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return pkg;
  }

  function requireGitWorld() {
    const gitWorld = global.POCKET?.gitWorld;
    if (!gitWorld?.checkpoint) {
      throw new SkillCommerceError("PA-GITWORLD/1 is required.");
    }
    return gitWorld;
  }

  function createEngine() {
    return {
      schema: SCHEMA,
      applyListSkill,
      applyBuySkill,
      applyExportSkill,
      applyImportSkill,
      buildExportPackage,
      downloadExportPackage,

      listSkill(args) {
        const at = new Date().toISOString();
        return requireGitWorld().checkpoint({
          type: "SKILL_LIST",
          summary: `List ${args.skillInstanceId} for CRT`,
          payload: clone(args),
          mutate: (next) => applyListSkill(next, { ...args, at }),
        });
      },

      buySkill(args) {
        const at = new Date().toISOString();
        return requireGitWorld().checkpoint({
          type: "SKILL_BUY",
          summary: `Buy listing ${args.listingId}`,
          payload: clone(args),
          mutate: (next) => applyBuySkill(next, { ...args, at }),
        });
      },

      exportSkill(args) {
        const at = new Date().toISOString();
        return requireGitWorld().checkpoint({
          type: "SKILL_EXPORT",
          summary: `Export ${args.skillInstanceId}`,
          payload: clone(args),
          mutate: (next) => applyExportSkill(next, { ...args, at }),
        });
      },

      importSkill(args) {
        const at = new Date().toISOString();
        return requireGitWorld().checkpoint({
          type: "SKILL_IMPORT",
          summary: `Import export ${args.exportId}`,
          payload: clone(args),
          mutate: (next) => applyImportSkill(next, { ...args, at }),
        });
      },
    };
  }

  function install() {
    global.POCKET ||= {};
    const engine = createEngine();
    global.POCKET.skillCommerce = engine;
    return engine;
  }

  global.PocketSkillCommerce = Object.freeze({
    SCHEMA,
    SkillCommerceError,
    createEngine,
    install,
  });
})(typeof window !== "undefined" ? window : globalThis);
