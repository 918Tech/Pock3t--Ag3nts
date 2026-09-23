# Skill Buy + Export — PA-SKILL-COMMERCE/1

## Skill buy

A skill sale is one Git checkpoint.

That checkpoint simultaneously:

1. debits buyer CRT,
2. credits seller CRT minus the platform fee,
3. credits the treasury fee,
4. removes the SkillInstance from seller inventory,
5. adds it to buyer inventory,
6. updates SkillInstance.ownerId,
7. closes the listing,
8. appends token and commerce journal entries.

There is no checkpoint in which payment happened without ownership, or ownership
changed without payment.

Only CRT is accepted by the internal skill marketplace. HVT is hardware-coupled
and cannot be used as a free-floating purchase currency.

## Skill export

Export is an ownership state transition, not a file copy.

```text
ACTIVE under agent
      |
      | export checkpoint
      v
EXPORTED / ownerId=null
      |
      +--> open export escrow record
      |
      +--> portable .paskill.json carrier package
```

The portable package contains:

- export ID,
- SkillInstance snapshot,
- originating checkpoint SHA,
- world state root.

The package does **not** become an independent duplicate of the skill. The
Git-backed world remains canonical. While an export record is open, the skill is
absent from every agent inventory.

Import consumes the open export escrow and moves that same SkillInstance back
into exactly one destination inventory.

## UI contract

The UI may call:

```js
await POCKET.skillCommerce.buySkill({
  listingId: "LIST-918",
  buyerAgentId: "GHOST-918",
  paymentClaimId: "PAY-918"
});

const saved = await POCKET.skillCommerce.exportSkill({
  exportId: "EXP-918",
  ownerAgentId: "GHOST-918",
  skillInstanceId: "RFG-00821"
});

POCKET.skillCommerce.downloadExportPackage({
  state: saved.state,
  checkpoint: saved.checkpoint,
  exportId: "EXP-918"
});
```

The downloaded file is a carrier/receipt. Canonical ownership is determined by
the Git checkpoint and export escrow state, not possession of the file.
