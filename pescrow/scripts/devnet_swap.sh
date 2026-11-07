#!/usr/bin/env bash
# Two funded wallets. Two locks, one release, then a second escrow with one
# lock and a reclaim after the deadline.
#
# A passing run asserts note owners:
#   after each lock, the output note is owned by the program PDA
#     seeds: "escrow-lock" || escrow address
#   after release, each note is owned by the other party
#   after reclaim, the abandoned note is owned by the party who locked it
# The sealed byte on the escrow account is not the check.
#
# This script does not send. The verifying keys are not in the program yet,
# and a send would not move a note. It exits before any RPC call while the
# program id or a key file is missing.

set -euo pipefail

missing=0
require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing ${name}" >&2
    missing=1
  fi
}

require PESROW_PROGRAM_ID
require VK_LOCK
require VK_SWAP
require VK_RETURN
require WALLET_A
require WALLET_B

if [[ "${missing}" -ne 0 ]]; then
  echo "refusing to send: set the program id, both wallets, and the three verifying keys" >&2
  exit 2
fi

for key in "${VK_LOCK}" "${VK_SWAP}" "${VK_RETURN}"; do
  if [[ ! -f "${key}" ]]; then
    echo "refusing to send: verifying key file not found: ${key}" >&2
    exit 2
  fi
done

echo "refusing to send: note-owner assertions are not run until zolana build-zk-program emits these keys into the deployed program" >&2
echo "expected owners: PDA after each lock, the counterparty after release, the locker after reclaim" >&2
exit 2
