#![cfg_attr(feature = "bpf-entrypoint", no_std)]

//! Two-sided escrow. Each party locks an asset. Once both are locked, either side can release.
//!
//! A lock, a swap, and a return each verify a circuit, then the program PDA
//! signs `SppTransactAccounts::invoke`. The seal is written after that invoke.
//! `zolana build-zk-program` writes the verifying keys. A public test setup does not compile into the program.

#[cfg(feature = "circuits")]
mod circuits;
mod error;
mod processor;
mod state;

#[cfg(feature = "circuits")]
pub use circuits::{
    GiveBack, GiveBackPrivate, GiveBackPublic, Lock, LockPrivate, LockPublic, Swap, SwapPrivate,
    SwapPublic,
};

pub use error::EscrowError;
pub use processor::{
    approve, binding_limbs, create, decline, fund_side, process, proved_lock, proved_return,
    proved_swap, reclaim, release, CreateArgs, Instruction, LockMove, PoolMove, ProvedLock,
    ProvedReturn, ProvedSwap, CIRCUIT_PROOF_LEN, CREATE_IX_LEN, LOCK_HEADER, LOCK_SEED, SPP_ID,
};
pub use state::{Escrow, Ring, Status, Wallets, ACCOUNT_LEN, ESCROW_TAG};

#[cfg(all(feature = "bpf-entrypoint", not(feature = "r1cs-export")))]
mod verifier;

#[cfg(feature = "bpf-entrypoint")]
mod entrypoint;
