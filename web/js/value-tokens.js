/*
 * Pocket Agents Internal Token Engine
 * PA-VALUE/2
 *
 * CRT = Code Rarity Token
 * HVT = Hardware Value Token
 *
 * Both are closed-loop game accounting units. They are not blockchain assets,
 * are not withdrawable, and are not cash-redeemable.
 */
(function (global) {
  "use strict";

  const SCHEMA = "PA-VALUE/2";
  const TOKENS = Object.freeze({
    CRT: Object.freeze({ code: "CRT", name: "Code Rarity Token", minorUnit: 100 }),
    HVT: Object.freeze({ code: "HVT", name: "Hardware Value Token", minorUnit: 100 }),
  });
  const TREASURY = "SYS:TREASURY";

  class InternalTokenError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "InternalTokenError";
      this.details = details;
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function assertInt(value, name, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) {
      throw new InternalTokenError(`${name} must be a safe integer >= ${min}`, {
        [name]: value,
      });
    }
  }

  function requireCode(code) {
    if (!TOKENS[code]) {
      throw new InternalTokenError("Unknown internal token.", { code });
    }
    return code;
  }

  function requireEconomy(state) {
    if (!state?.economy || state.economy.schema !== SCHEMA) {
      throw new InternalTokenError("PA-VALUE/2 economy is not initialized.");
    }
    return state.economy;
  }

  function agentAccountId(agentId) {
    if (!agentId || typeof agentId !== "string") {
      throw new InternalTokenError("agentId is required.");
    }
    return `AGENT:${agentId}`;
  }

  function ensureTreasury(economy) {
    economy.accounts ||= {};
    economy.accounts[TREASURY] ||= {
      id: TREASURY,
      ownerType: "system",
      ownerId: "POCKET",
      balancesMinor: { CRT: 0, HVT: 0 },
    };
    economy.accounts[TREASURY].balancesMinor ||= { CRT: 0, HVT: 0 };
    return economy.accounts[TREASURY];
  }

  function ensureAgentAccount(state, agentId) {
    const economy = requireEconomy(state);
    if (!state.agents?.[agentId]) {
      throw new InternalTokenError("Token account owner agent does not exist.", {
        agentId,
      });
    }

    const id = agentAccountId(agentId);
    economy.accounts ||= {};
    economy.accounts[id] ||= {
      id,
      ownerType: "agent",
      ownerId: agentId,
      balancesMinor: { CRT: 0, HVT: 0 },
    };
    economy.accounts[id].balancesMinor ||= { CRT: 0, HVT: 0 };

    for (const code of Object.keys(TOKENS)) {
      const value = economy.accounts[id].balancesMinor[code] ?? 0;
      assertInt(value, `${id}.${code}`);
      economy.accounts[id].balancesMinor[code] = value;
    }
    return economy.accounts[id];
  }

  function nextJournalId(economy) {
    const seq = Number(economy.journalSequence || 0) + 1;
    assertInt(seq, "journalSequence", 1);
    economy.journalSequence = seq;
    return { seq, id: `VAL-${String(seq).padStart(10, "0")}` };
  }

  function appendJournal(economy, entry) {
    economy.journal ||= {};
    const { seq, id } = nextJournalId(economy);
    if (economy.journal[id]) {
      throw new InternalTokenError("Duplicate value journal id.", { id });
    }
    economy.journal[id] = { id, seq, ...entry };
    return economy.journal[id];
  }

  function consumeClaim(economy, claimId, record) {
    if (!claimId || typeof claimId !== "string") {
      throw new InternalTokenError("claimId is required for token mutation.");
    }
    economy.claims ||= {};
    if (economy.claims[claimId]) {
      throw new InternalTokenError("Internal token claim already consumed.", {
        claimId,
      });
    }
    economy.claims[claimId] = clone(record);
  }

  function enforceSupply(economy, code, candidate) {
    assertInt(candidate, "candidateSupplyMinor");
    const token = economy.tokens?.[code];
    if (!token) throw new InternalTokenError("Token state missing.", { code });
    const cap = token.policy?.maxSupplyMinor;
    if (cap !== null && cap !== undefined) {
      assertInt(cap, "maxSupplyMinor");
      if (candidate > cap) {
        throw new InternalTokenError("Token supply cap exceeded.", {
          code,
          candidate,
          cap,
        });
      }
    }
  }

  function mint(state, {
    code,
    agentId,
    amountMinor,
    authorityId = "SYSTEM",
    claimId,
    reason,
    evidence,
    at,
  }) {
    requireCode(code);
    assertInt(amountMinor, "amountMinor", 1);
    const economy = requireEconomy(state);
    const token = economy.tokens[code];
    const expectedAuthority = token.policy?.mintAuthority || "SYSTEM";
    if (authorityId !== expectedAuthority) {
      throw new InternalTokenError("Unauthorized mint authority.", {
        code,
        authorityId,
        expectedAuthority,
      });
    }

    if (code === "CRT") {
      if (
        !evidence?.artifactId ||
        !evidence?.rarityClass ||
        !evidence?.rarityBasisHash
      ) {
        throw new InternalTokenError(
          "CRT mint requires code-rarity evidence."
        );
      }
    }

    if (code === "HVT") {
      if (
        !evidence?.hardwareId ||
        !evidence?.hardwareClass ||
        !evidence?.attestationHash
      ) {
        throw new InternalTokenError(
          "HVT mint requires hardware attestation evidence."
        );
      }
    }

    const account = ensureAgentAccount(state, agentId);
    const candidate = Number(token.totalSupplyMinor || 0) + amountMinor;
    enforceSupply(economy, code, candidate);

    consumeClaim(economy, claimId, {
      kind: "MINT",
      code,
      agentId,
      amountMinor,
      evidence: clone(evidence || {}),
      at,
    });

    account.balancesMinor[code] += amountMinor;
    token.totalSupplyMinor = candidate;

    return appendJournal(economy, {
      kind: "MINT",
      code,
      amountMinor,
      fromAccountId: null,
      toAccountId: account.id,
      authorityId,
      claimId,
      reason: reason || "authorized-mint",
      evidence: clone(evidence || {}),
      at,
    });
  }

  function applyCodeRarityAward(state, {
    agentId,
    artifactId,
    rarityClass,
    rarityBasisHash,
    claimId,
    authorityId = "SYSTEM",
    at = new Date().toISOString(),
  }) {
    const economy = requireEconomy(state);
    const amountMinor = Number(
      economy.tokens.CRT.policy?.rarityAwardMinor?.[rarityClass]
    );
    assertInt(amountMinor, "rarityAwardMinor", 1);

    return mint(state, {
      code: "CRT",
      agentId,
      amountMinor,
      authorityId,
      claimId,
      reason: `code-rarity:${rarityClass}`,
      evidence: { artifactId, rarityClass, rarityBasisHash },
      at,
    });
  }

  function applyTransfer(state, {
    code,
    fromAgentId,
    toAgentId,
    amountMinor,
    claimId,
    reason = "peer-transfer",
    evidence = {},
    at = new Date().toISOString(),
  }) {
    requireCode(code);
    assertInt(amountMinor, "amountMinor", 1);
    const economy = requireEconomy(state);

    if (code === "HVT") {
      throw new InternalTokenError(
        "HVT is hardware-coupled and cannot transfer independently."
      );
    }
    if (fromAgentId === toAgentId) {
      throw new InternalTokenError("Transfer requires distinct agents.");
    }

    const from = ensureAgentAccount(state, fromAgentId);
    const to = ensureAgentAccount(state, toAgentId);
    if (from.balancesMinor[code] < amountMinor) {
      throw new InternalTokenError("Insufficient token balance.", {
        code,
        fromAgentId,
        amountMinor,
        balanceMinor: from.balancesMinor[code],
      });
    }

    consumeClaim(economy, claimId, {
      kind: "TRANSFER",
      code,
      fromAgentId,
      toAgentId,
      amountMinor,
      evidence: clone(evidence),
      at,
    });

    from.balancesMinor[code] -= amountMinor;
    to.balancesMinor[code] += amountMinor;

    return appendJournal(economy, {
      kind: "TRANSFER",
      code,
      amountMinor,
      fromAccountId: from.id,
      toAccountId: to.id,
      claimId,
      reason,
      evidence: clone(evidence),
      at,
    });
  }

  function applyBurn(state, {
    code,
    agentId,
    amountMinor,
    claimId,
    reason = "sink",
    evidence = {},
    at = new Date().toISOString(),
  }) {
    requireCode(code);
    assertInt(amountMinor, "amountMinor", 1);
    const economy = requireEconomy(state);
    const account = ensureAgentAccount(state, agentId);
    const token = economy.tokens[code];

    if (account.balancesMinor[code] < amountMinor) {
      throw new InternalTokenError("Insufficient balance to burn.", {
        code,
        agentId,
        amountMinor,
        balanceMinor: account.balancesMinor[code],
      });
    }

    consumeClaim(economy, claimId, {
      kind: "BURN",
      code,
      agentId,
      amountMinor,
      evidence: clone(evidence),
      at,
    });

    account.balancesMinor[code] -= amountMinor;
    token.totalSupplyMinor -= amountMinor;

    return appendJournal(economy, {
      kind: "BURN",
      code,
      amountMinor,
      fromAccountId: account.id,
      toAccountId: null,
      claimId,
      reason,
      evidence: clone(evidence),
      at,
    });
  }

  function hardwareValueMinor(economy, hardwareClass, requestedValueMinor) {
    const scheduled =
      economy.tokens.HVT.policy?.hardwareClassValueMinor?.[hardwareClass];
    if (scheduled !== undefined) {
      assertInt(Number(scheduled), "hardwareClassValueMinor", 1);
      if (
        requestedValueMinor !== undefined &&
        requestedValueMinor !== null &&
        Number(requestedValueMinor) !== Number(scheduled)
      ) {
        throw new InternalTokenError(
          "Hardware value does not match canonical class value.",
          { hardwareClass, requestedValueMinor, scheduled }
        );
      }
      return Number(scheduled);
    }

    assertInt(Number(requestedValueMinor), "valueMinor", 1);
    return Number(requestedValueMinor);
  }

  function applyHardwareRegistration(state, {
    agentId,
    hardwareId,
    hardwareClass,
    attestationHash,
    valueMinor,
    claimId,
    authorityId = "SYSTEM",
    at = new Date().toISOString(),
  }) {
    const economy = requireEconomy(state);
    if (!hardwareId || !hardwareClass || !attestationHash) {
      throw new InternalTokenError(
        "Hardware registration requires id, class, and attestation."
      );
    }

    economy.hardware ||= {};
    if (economy.hardware[hardwareId]) {
      throw new InternalTokenError("Hardware already registered.", { hardwareId });
    }

    const canonicalValueMinor = hardwareValueMinor(
      economy,
      hardwareClass,
      valueMinor
    );

    economy.hardware[hardwareId] = {
      hardwareId,
      hardwareClass,
      ownerAgentId: agentId,
      attestationHash,
      valueMinor: canonicalValueMinor,
      status: "active",
      revision: 1,
      registeredAt: at,
    };

    mint(state, {
      code: "HVT",
      agentId,
      amountMinor: canonicalValueMinor,
      authorityId,
      claimId,
      reason: "hardware-registration",
      evidence: {
        hardwareId,
        hardwareClass,
        attestationHash,
        hardwareRevision: 1,
      },
      at,
    });

    return economy.hardware[hardwareId];
  }

  function applyHardwareOwnershipTransfer(state, {
    hardwareId,
    fromAgentId,
    toAgentId,
    attestationHash,
    claimId,
    at = new Date().toISOString(),
  }) {
    const economy = requireEconomy(state);
    const hardware = economy.hardware?.[hardwareId];
    if (!hardware || hardware.status !== "active") {
      throw new InternalTokenError("Active hardware record not found.", {
        hardwareId,
      });
    }
    if (hardware.ownerAgentId !== fromAgentId) {
      throw new InternalTokenError("Hardware owner mismatch.", {
        hardwareId,
        ownerAgentId: hardware.ownerAgentId,
        fromAgentId,
      });
    }
    if (!state.agents?.[toAgentId] || fromAgentId === toAgentId) {
      throw new InternalTokenError("Invalid hardware destination agent.");
    }
    if (!attestationHash) {
      throw new InternalTokenError("Hardware transfer needs attestationHash.");
    }

    const from = ensureAgentAccount(state, fromAgentId);
    const to = ensureAgentAccount(state, toAgentId);
    const amountMinor = hardware.valueMinor;

    if (from.balancesMinor.HVT < amountMinor) {
      throw new InternalTokenError("Coupled HVT balance is inconsistent.", {
        hardwareId,
        fromAgentId,
        amountMinor,
        balanceMinor: from.balancesMinor.HVT,
      });
    }

    consumeClaim(economy, claimId, {
      kind: "HARDWARE_TRANSFER",
      code: "HVT",
      hardwareId,
      fromAgentId,
      toAgentId,
      amountMinor,
      attestationHash,
      at,
    });

    from.balancesMinor.HVT -= amountMinor;
    to.balancesMinor.HVT += amountMinor;

    hardware.ownerAgentId = toAgentId;
    hardware.attestationHash = attestationHash;
    hardware.revision = Number(hardware.revision || 0) + 1;
    hardware.lastTransferredAt = at;

    return appendJournal(economy, {
      kind: "HARDWARE_TRANSFER",
      code: "HVT",
      amountMinor,
      fromAccountId: from.id,
      toAccountId: to.id,
      claimId,
      reason: "hardware-ownership-transfer",
      evidence: {
        hardwareId,
        hardwareClass: hardware.hardwareClass,
        attestationHash,
        hardwareRevision: hardware.revision,
      },
      at,
    });
  }

  function applyHardwareRetirement(state, {
    hardwareId,
    agentId,
    evidenceHash,
    claimId,
    at = new Date().toISOString(),
  }) {
    const economy = requireEconomy(state);
    const hardware = economy.hardware?.[hardwareId];
    if (!hardware || hardware.status !== "active") {
      throw new InternalTokenError("Active hardware record not found.", {
        hardwareId,
      });
    }
    if (hardware.ownerAgentId !== agentId) {
      throw new InternalTokenError("Hardware owner mismatch.", {
        hardwareId,
        ownerAgentId: hardware.ownerAgentId,
        agentId,
      });
    }

    applyBurn(state, {
      code: "HVT",
      agentId,
      amountMinor: hardware.valueMinor,
      claimId,
      reason: "hardware-retirement",
      evidence: {
        hardwareId,
        hardwareRevision: hardware.revision,
        evidenceHash: evidenceHash || null,
      },
      at,
    });

    hardware.status = "retired";
    hardware.revision = Number(hardware.revision || 0) + 1;
    hardware.retiredAt = at;
    return hardware;
  }

  function applyMarketplaceSettlement(state, {
    buyerAgentId,
    sellerAgentId,
    priceMinor,
    listingId,
    claimId,
    feeBps,
    at = new Date().toISOString(),
  }) {
    assertInt(priceMinor, "priceMinor", 1);
    if (buyerAgentId === sellerAgentId) {
      throw new InternalTokenError("Buyer and seller must be distinct agents.");
    }

    const economy = requireEconomy(state);
    const buyer = ensureAgentAccount(state, buyerAgentId);
    const seller = ensureAgentAccount(state, sellerAgentId);
    const treasury = ensureTreasury(economy);
    const fee = Number(
      feeBps ?? economy.tokens.CRT.policy?.marketplaceFeeBps ?? 500
    );
    assertInt(fee, "feeBps");
    if (fee > 10000) throw new InternalTokenError("feeBps cannot exceed 10000.");

    if (buyer.balancesMinor.CRT < priceMinor) {
      throw new InternalTokenError("Buyer has insufficient CRT.", {
        buyerAgentId,
        priceMinor,
        balanceMinor: buyer.balancesMinor.CRT,
      });
    }

    consumeClaim(economy, claimId, {
      kind: "MARKETPLACE",
      code: "CRT",
      buyerAgentId,
      sellerAgentId,
      priceMinor,
      listingId,
      at,
    });

    const feeMinor = Math.floor((priceMinor * fee) / 10000);
    const sellerAmountMinor = priceMinor - feeMinor;

    buyer.balancesMinor.CRT -= priceMinor;
    seller.balancesMinor.CRT += sellerAmountMinor;
    treasury.balancesMinor.CRT += feeMinor;

    return appendJournal(economy, {
      kind: "MARKETPLACE",
      code: "CRT",
      amountMinor: priceMinor,
      sellerAmountMinor,
      feeMinor,
      feeBps: fee,
      fromAccountId: buyer.id,
      toAccountId: seller.id,
      feeAccountId: treasury.id,
      claimId,
      reason: "marketplace-settlement",
      evidence: { listingId },
      at,
    });
  }

  function balanceMinor(state, agentId, code) {
    requireCode(code);
    const economy = requireEconomy(state);
    return (
      economy.accounts?.[agentAccountId(agentId)]?.balancesMinor?.[code] || 0
    );
  }

  function formatMinor(amountMinor, code) {
    requireCode(code);
    assertInt(amountMinor, "amountMinor");
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }

  function requireGitWorld() {
    const gitWorld = global.POCKET?.gitWorld;
    if (!gitWorld?.checkpoint) {
      throw new InternalTokenError(
        "PA-GITWORLD/1 is required for durable token mutations."
      );
    }
    return gitWorld;
  }

  function createEngine() {
    return {
      schema: SCHEMA,
      tokens: TOKENS,
      balanceMinor,
      formatMinor,
      applyCodeRarityAward,
      applyTransfer,
      applyBurn,
      applyHardwareRegistration,
      applyHardwareOwnershipTransfer,
      applyHardwareRetirement,
      applyMarketplaceSettlement,

      checkpoint(type, summary, payload, mutate) {
        return requireGitWorld().checkpoint({ type, summary, payload, mutate });
      },

      awardCodeRarity(args) {
        const at = new Date().toISOString();
        return this.checkpoint(
          "CRT_AWARD",
          `CRT award for ${args.artifactId}`,
          clone(args),
          (next) => applyCodeRarityAward(next, { ...args, at })
        );
      },

      registerHardware(args) {
        const at = new Date().toISOString();
        return this.checkpoint(
          "HVT_REGISTER",
          `HVT registration for ${args.hardwareId}`,
          clone(args),
          (next) => applyHardwareRegistration(next, { ...args, at })
        );
      },

      transferHardware(args) {
        const at = new Date().toISOString();
        return this.checkpoint(
          "HVT_TRANSFER",
          `HVT transfer for ${args.hardwareId}`,
          clone(args),
          (next) => applyHardwareOwnershipTransfer(next, { ...args, at })
        );
      },

      retireHardware(args) {
        const at = new Date().toISOString();
        return this.checkpoint(
          "HVT_RETIRE",
          `HVT retirement for ${args.hardwareId}`,
          clone(args),
          (next) => applyHardwareRetirement(next, { ...args, at })
        );
      },
    };
  }

  function install() {
    global.POCKET ||= {};
    const engine = createEngine();
    global.POCKET.valueTokens = engine;
    return engine;
  }

  global.PocketValueTokens = Object.freeze({
    SCHEMA,
    TOKENS,
    TREASURY,
    InternalTokenError,
    createEngine,
    install,
  });
})(typeof window !== "undefined" ? window : globalThis);
