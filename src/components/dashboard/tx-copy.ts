import type { TxCopy } from "@/lib/tx-log";

export const TX_COPY = {
  fundRingKey: {
    step: "Fund the ring key",
    explanation: "Sends SOL from your wallet to the ring key. The ring key pays the fees of private transactions and holds any SOL you are about to shield.",
  },
  shield: {
    step: "Shield",
    explanation: "Moves the asset from the ring key into a new private note. The note joins your private balance.",
  },
  moveToken: {
    step: "Move the token to the ring key",
    explanation: "Transfers the token from your wallet to the ring key's token account, so the next step can shield it.",
  },
  redeem: {
    step: "Redeem",
    explanation: "Sends the amount you chose from a private note to your public wallet. The rest of the note stays private.",
  },
  carve: {
    step: "Carve the note",
    explanation: "Splits a shielded note into the exact escrow amount and a change note. The change note stays spendable.",
  },
  openEscrow: {
    step: "Open the escrow",
    explanation: "Creates the escrow account, pays its rent, and records your approval in one transaction.",
  },
  lock: {
    step: "Lock into the escrow",
    explanation: "Spends your shielded note into the escrow and seals your side. The program does not store the amount.",
  },
  split: {
    step: "Split the note",
    explanation: "The note was larger than the lock, so the desk split off the locked chunk. The remainder stays in the private balance.",
  },
  approveEscrow: {
    step: "Approve the escrow",
    explanation: "Records your approval on the escrow. No asset moves.",
  },
  declineEscrow: {
    step: "Decline the escrow",
    explanation: "Voids the proposal. This only works while neither side is sealed.",
  },
  swap: {
    step: "Swap",
    explanation: "Sends each locked note to the other party's shielded address. Both seals have to be set.",
  },
  closeEscrow: {
    step: "Close the escrow",
    explanation: "Closes the escrow account. Its rent goes back to the opener.",
  },
  returnFees: {
    step: "Return ring key SOL",
    explanation: "Sends the SOL left on the ring key back to your wallet.",
  },
  openBudget: {
    step: "Open the budget",
    explanation: "Creates the budget account that payrolls draw from. It holds no shielded note yet.",
  },
  lookupTable: {
    step: "Open an address table",
    explanation: "Creates an address lookup table so the private transaction that follows fits in one transaction.",
  },
  depositBudget: {
    step: "Put the note in the budget",
    explanation: "Moves a shielded note from your private balance into the budget.",
  },
  withdrawBudget: {
    step: "Close the budget",
    explanation: "Moves the budget's shielded note back into your private balance.",
  },
  openPayroll: {
    step: "Open the payroll",
    explanation: "Creates the payroll account for the destinataire. The roll amount stays hidden in the account.",
  },
  approvePayroll: {
    step: "Approve the payroll",
    explanation: "Records your approval on the payroll. No asset moves.",
  },
  fundPayroll: {
    step: "Fund the payroll",
    explanation: "Moves the budget note onto the payroll. The remainder stays in the budget.",
  },
  crankPayroll: {
    step: "Pay a roll",
    explanation: "Pays one due roll from the payroll to the destinataire.",
  },
} as const satisfies Record<string, TxCopy>;
