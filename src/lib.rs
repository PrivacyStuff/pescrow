#![cfg_attr(feature = "bpf-entrypoint", no_std)]

//! Two-sided escrow. Each party locks an asset. Once both are locked, either side can release.
//!
//! The private-note transfer into the Helius Default ring is not wired yet.
//! `fund_side` checks the Solana Privacy Program id and then fails closed.

mod error;
mod processor;
mod state;

pub use error::EscrowError;
pub use processor::{
    approve, create, decline, fund_side, process, reclaim, release, CreateArgs, Instruction, SPP_ID,
};
pub use state::{Escrow, Ring, Status, Wallets, ACCOUNT_LEN, ESCROW_TAG};

#[cfg(feature = "bpf-entrypoint")]
mod entrypoint;
