/*
 * Pocket Agents Internal Value Tokens
 * PA-VALUE/1
 *
 * PAV is a closed-loop game accounting unit. It is not a blockchain asset,
 * is not cash-redeemable, and has no withdrawal path. Durable mutations are
 * committed through PA-GITWORLD/1 checkpoints.
 */
(function (global) {
  "use strict";

  const SCHEMA = "PA-VALUE/1";
  const CODE = "PAV";
  const TREASURY = "SYS:TREASURY";
  const DEFAULT_FEE_BPS = 500;

  class ValueTokenError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "ValueTokenError";
      this.details = details;
    }
  }

  function assertInt(value, name, { min = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < min) {
      throw new ValueTokenError(`${name} must be a safe integer >= ${min}`, {
        [name]: value,
      });
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function agentAccountId(agentId) {
    if (!agentId || typeof agentId !== "string") {
      throw new ValueTokenError("agentId is required.");
    }
    return `AGENT:${agentId}`;
  }

  function requireEconomy(state) {
    const economy = state?.economy;
    if (!economy || economy.schema !== SCHEMA) {
      throw new ValueTokenError("PA-VALUE/1 economy is not initialized.");
    }
    if (economy.currency?.code !== CODE) {
      throw new ValueTokenError("Unexpected internal currency code.", {
        code: economy.currency?.code,
      });
    }
    return economy;
  }

  function ensureSystemTreasury(economy) {
    economy.accounts ||= {};
    if (!economy.accounts[TREASURY]) {
      economy.accounts[TREASURY] = {
        id: TREASURY,
        ownerType: "system",
        ownerId: "POCKET",
        balanceMinor: 0,
      };
    }
    return economy.accounts[TREASURY];
  }

  function ensureAgentAccount(state, agentId) {
    const economy = requireEconomy(state);
    if (!state.agents?.[agentId]) {
      throw new ValueTokenError("Cannot create value account for missing agent.", {
        agentId,
      });
    }
    const id = agentAccountId(agentId);
    economy.accounts ||= {};
    if (!economy.accounts[id]) {
      economy.accounts[id] = {
        id,
        ownerType: "agent",
        ownerId: agentId,
        balanceMinor: 0,
      };
    }
    return economy.accounts[id];
  }

  function getAccount(economy, accountId) {
    const account = economy.accounts?.[accountId];
    if (!account) {
      throw new ValueTokenError("Value account does not exist.", { accountId });
    }
    return account;
  }

  function nextJournalId(economy) {
    const next = Number(economy.journalSequence || 0) + 1;
    assertInt(next, "journalSequence", { min: 1 });
    economy.journalSequence = next;
    return {
      seq: next,
      id: `VAL-${String(next).padStart(10, "0")}`,
    };
  }

  function appendJournal(economy, entry) {
    economy.journal ||= {};
    const { seq, id } = nextJournalId(economy);
    if (economy.journal[id]) {
      throw new ValueTokenError("Duplicate value journal id.", { id });
    }
    economy.journal[id] = {
      id,
      seq,
      ...entry,
    };
    return economy.journal[id];
  }

  function enforceMaxSupply(economy, candidateSupply) {
    assertInt(candidateSupply, "candidateSupply");
    const cap = economy.policy?.maxSupplyMinor;
    if (cap !== null && cap !== undefined) {
      assertInt(cap, "maxSupplyMinor");
      if (candidateSupply > cap) {
        throw new ValueTokenError("Internal value token max supply exceeded.", {
          candidateSupply,
          maxSupplyMinor: cap,
        });
      }
    }
  }

  function applyMint(state, {
    agentId,
    amountMinor,
    reason,
    authorityId = "SYSTEM",
    related = {},
    at = new Date().toISOString(),
  }) {
    assertInt(amountMinor, "amountMinor", { min: 1 });
    const economy = requireEconomy(state);
    const expectedAuthority = economy.policy?.mintAuthority || "SYSTEM";
    if (authorityId !== expectedAuthority) {
      throw new ValueTokenError("Unauthorized PAV mint authority.", {
        authorityId,
        expectedAuthority,
      });
    }

    const account = ensureAgentAccount(state, agentId);
    const candidateSupply = Number(economy.totalSupplyMinor || 0) + amountMinor;
    enforceMaxSupply(economy, candidateSupply);

    account.balanceMinor += amountMinor;
    economy.totalSupplyMinor = candidateSupply;

    return appendJournal(economy, {
      kind: "MINT",
      amountMinor,
      fromAccountId: null,
      toAccountId: account.id,
      authorityId,
      reason: reason || "reward",
      related: clone(related),
      at,
    });
  }

  function applyBurn(state, {
    agentId,
    amountMinor,
    reason,
    related = {},
    at = new Date().toISOString(),
  }) {
    assertInt(amountMinor, "amountMinor", { min: 1 });
    const economy = requireEconomy(state);
    const account = ensureAgentAccount(state, agentId);

    if (account.balanceMinor < amountMinor) {
      throw new ValueTokenError("Insufficient PAV balance to burn.", {
        agentId,
        balanceMinor: account.balanceMinor,
        amountMinor,
      });
    }

    account.balanceMinor -= amountMinor;
    economy.totalSupplyMinor -= amountMinor;

    return appendJournal(economy, {
      kind: "BURN",
      amountMinor,
      fromAccountId: account.id,
      toAccountId: null,
      reason: reason || "sink",
      related: clone(related),
      at,
    });
  }

  function applyTransfer(state, {
    fromAgentId,
    toAgentId,
    amountMinor,
    reason,
    related = {},
    at = new Date().toISOString(),
  }) {
    assertInt(amountMinor, "amountMinor", { min: 1 });
    if (fromAgentId === toAgentId) {
      throw new ValueTokenError("PAV transfer requires distinct agents.");
    }

    const economy = requireEconomy(state);
    const from = ensureAgentAccount(state, fromAgentId);
    const to = ensureAgentAccount(state, toAgentId);

    if (from.balanceMinor < amountMinor) {
      throw new ValueTokenError("Insufficient PAV balance.", {
        fromAgentId,
        balanceMinor: from.balanceMinor,
        amountMinor,
      });
    }

    from.balanceMinor -= amountMinor;
    to.balanceMinor += amountMinor;

    return appendJournal(economy, {
      kind: "TRANSFER",
      amountMinor,
      fromAccountId: from.id,
      toAccountId: to.id,
      reason: reason || "peer-transfer",
      related: clone(related),
      at,
    });
  }

  function applyMarketplaceSettlement(state, {
    buyerAgentId,
    sellerAgentId,
    priceMinor,
    listingId,
    feeBps,
    related = {},
    at = new Date().toISOString(),
  }) {
    assertInt(priceMinor, "priceMinor", { min: 1 });
    if (buyerAgentId === sellerAgentId) {
      throw new ValueTokenError("Buyer and seller must be distinct agents.");
    }

    const economy = requireEconomy(state);
    ensureSystemTreasury(economy);

    const buyer = ensureAgentAccount(state, buyerAgentId);
    const seller = ensureAgentAccount(state, sellerAgentId);
    const treasury = getAccount(economy, economy.policy?.issuerAccountId || TREASURY);

    const appliedFeeBps =
      feeBps === undefined || feeBps === null
        ? Number(economy.policy?.marketplaceFeeBps ?? DEFAULT_FEE_BPS)
        : Number(feeBps);

    assertInt(appliedFeeBps, "feeBps");
    if (appliedFeeBps > 10000) {
      throw new ValueTokenError("feeBps cannot exceed 10000.", {
        feeBps: appliedFeeBps,
      });
    }

    if (buyer.balanceMinor < priceMinor) {
      throw new ValueTokenError("Buyer has insufficient PAV.", {
        buyerAgentId,
        balanceMinor: buyer.balanceMinor,
        priceMinor,
      });
    }

    const feeMinor = Math.floor((priceMinor * appliedFeeBps) / 10000);
    const sellerAmountMinor = priceMinor - feeMinor;

    buyer.balanceMinor -= priceMinor;
    seller.balanceMinor += sellerAmountMinor;
    treasury.balanceMinor += feeMinor;

    return appendJournal(economy, {
      kind: "MARKETPLACE",
      amountMinor: priceMinor,
      sellerAmountMinor,
      feeMinor,
      feeBps: appliedFeeBps,
      fromAccountId: buyer.id,
      toAccountId: seller.id,
      feeAccountId: treasury.id,
      reason: "marketplace-settlement",
      related: {
        listingId: listingId || null,
        ...clone(related),
      },
      at,
    });
  }

  function balanceMinor(state, agentId) {
    const economy = requireEconomy(state);
    return economy.accounts?.[agentAccountId(agentId)]?.balanceMinor || 0;
  }

  function formatMinor(amountMinor, stateOrEconomy) {
    assertInt(amountMinor, "amountMinor");
    const economy = stateOrEconomy?.economy || stateOrEconomy;
    const minorUnit = Number(economy?.currency?.minorUnit || 100);
    const digits = Math.max(0, Math.round(Math.log10(minorUnit)));
    return `${(amountMinor / minorUnit).toFixed(digits)} ${CODE}`;
  }

  function requireGitWorld() {
    const gitWorld = global.POCKET?.gitWorld;
    if (!gitWorld?.checkpoint) {
      throw new ValueTokenError(
        "PA-GITWORLD/1 is required for durable PAV mutations."
      );
    }
    return gitWorld;
  }

  function createEngine() {
    return {
      schema: SCHEMA,
      code: CODE,
      accountIdForAgent: agentAccountId,
      balanceMinor,
      formatMinor,

      // Domain mutators for composing larger atomic checkpoints.
      applyMint,
      applyBurn,
      applyTransfer,
      applyMarketplaceSettlement,

      async reward({ agentId, amountMinor, reason = "reward", related = {} }) {
        const gitWorld = requireGitWorld();
        const at = new Date().toISOString();
        return gitWorld.checkpoint({
          type: "VALUE_MINT",
          summary: `${amountMinor} PAV-minor rewarded to ${agentId}`,
          payload: { agentId, amountMinor, reason, related },
          mutate(next) {
            applyMint(next, {
              agentId,
              amountMinor,
              reason,
              related,
              authorityId: "SYSTEM",
              at,
            });
          },
        });
      },

      async burn({ agentId, amountMinor, reason = "sink", related = {} }) {
        const gitWorld = requireGitWorld();
        const at = new Date().toISOString();
        return gitWorld.checkpoint({
          type: "VALUE_BURN",
          summary: `${amountMinor} PAV-minor burned from ${agentId}`,
          payload: { agentId, amountMinor, reason, related },
          mutate(next) {
            applyBurn(next, { agentId, amountMinor, reason, related, at });
          },
        });
      },

      async transfer({
        fromAgentId,
        toAgentId,
        amountMinor,
        reason = "peer-transfer",
        related = {},
      }) {
        const gitWorld = requireGitWorld();
        const at = new Date().toISOString();
        return gitWorld.checkpoint({
          type: "VALUE_TRANSFER",
          summary: `${amountMinor} PAV-minor ${fromAgentId} -> ${toAgentId}`,
          payload: { fromAgentId, toAgentId, amountMinor, reason, related },
          mutate(next) {
            applyTransfer(next, {
              fromAgentId,
              toAgentId,
              amountMinor,
              reason,
              related,
              at,
            });
          },
        });
      },

      async settleMarketplace({
        buyerAgentId,
        sellerAgentId,
        priceMinor,
        listingId,
        related = {},
      }) {
        const gitWorld = requireGitWorld();
        const at = new Date().toISOString();
        return gitWorld.checkpoint({
          type: "VALUE_MARKETPLACE",
          summary: `${buyerAgentId} settled ${priceMinor} PAV-minor with ${sellerAgentId}`,
          payload: {
            buyerAgentId,
            sellerAgentId,
            priceMinor,
            listingId,
            related,
          },
          mutate(next) {
            applyMarketplaceSettlement(next, {
              buyerAgentId,
              sellerAgentId,
              priceMinor,
              listingId,
              related,
              at,
            });
          },
        });
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
    CODE,
    TREASURY,
    ValueTokenError,
    createEngine,
    install,
  });
})(typeof window !== "undefined" ? window : globalThis);
