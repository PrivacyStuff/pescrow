use crate::error::EscrowError;

pub const ESCROW_TAG: u8 = 1;
/// Layout break: 88 bytes had no bump and no note commitments. Nothing is deployed.
/// 0 tag, 1 status, 2 a_approved, 3 b_approved, 4 a_sealed, 5 b_sealed,
/// 6 ring, 7 wallets, 8 start, 16 deadline, 24 party_a, 56 party_b,
/// 88 bump, 89..96 pad, 96 commitment_a, 128 commitment_b.
pub const ACCOUNT_LEN: usize = 160;
pub const COMMITMENT_LEN: usize = 32;

const OFF_TAG: usize = 0;
const OFF_STATUS: usize = 1;
const OFF_A_APPROVED: usize = 2;
const OFF_B_APPROVED: usize = 3;
const OFF_A_SEALED: usize = 4;
const OFF_B_SEALED: usize = 5;
const OFF_RING: usize = 6;
const OFF_WALLETS: usize = 7;
const OFF_START: usize = 8;
const OFF_DEADLINE: usize = 16;
const OFF_PARTY_A: usize = 24;
const OFF_PARTY_B: usize = 56;
const OFF_BUMP: usize = 88;
const OFF_COMMIT_A: usize = 96;
const OFF_COMMIT_B: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Proposed = 1,
    Void = 2,
    Exchanged = 3,
    Reclaimed = 4,
}

/// Which pool the locks use. Independent of whether the wallets are public.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Ring {
    Permissionless = 1,
    Custom = 2,
}

/// Public stores the two wallets. Private stores commitments of the same size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Wallets {
    Public = 1,
    Private = 2,
}

pub struct Escrow<'a> {
    data: &'a mut [u8],
}

impl<'a> Escrow<'a> {
    /// Rejects any buffer that is not the 160-byte account.
    pub fn load(data: &'a mut [u8]) -> Result<Self, EscrowError> {
        if data.len() != ACCOUNT_LEN {
            return Err(EscrowError::BadAccount);
        }
        Ok(Self { data })
    }

    /// Opens permissionless plus public wallets only. A second create fails.
    pub fn create(
        &mut self,
        party_a: &[u8; 32],
        party_b: &[u8; 32],
        start_at: i64,
        approval_deadline: i64,
        ring: Ring,
        wallets: Wallets,
        bump: u8,
    ) -> Result<(), EscrowError> {
        if self.data[OFF_TAG] != 0 {
            return Err(EscrowError::AlreadyInitialized);
        }
        if approval_deadline > start_at {
            return Err(EscrowError::DeadlineAfterRelease);
        }
        if party_a == party_b {
            return Err(EscrowError::SameParty);
        }
        // Both wallet options exist on both rings. Two of the four cannot be
        // opened yet without publishing a wallet the caller asked to hide.
        match (ring, wallets) {
            (Ring::Permissionless, Wallets::Private) => {
                return Err(EscrowError::PermissionlessPublishesWallets);
            }
            (Ring::Custom, Wallets::Public | Wallets::Private) => {
                return Err(EscrowError::CustomRingUnset);
            }
            (Ring::Permissionless, Wallets::Public) => {}
        }
        self.data[OFF_TAG] = ESCROW_TAG;
        self.data[OFF_STATUS] = Status::Proposed as u8;
        self.data[OFF_RING] = ring as u8;
        self.data[OFF_WALLETS] = wallets as u8;
        self.data[OFF_BUMP] = bump;
        self.data[OFF_START..OFF_START + 8].copy_from_slice(&start_at.to_le_bytes());
        self.data[OFF_DEADLINE..OFF_DEADLINE + 8].copy_from_slice(&approval_deadline.to_le_bytes());
        self.data[OFF_PARTY_A..OFF_PARTY_A + 32].copy_from_slice(party_a);
        self.data[OFF_PARTY_B..OFF_PARTY_B + 32].copy_from_slice(party_b);
        Ok(())
    }

    /// One party signs, once, strictly before the approval deadline and `start_at`.
    pub fn approve(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        self.require_proposed(now)?;
        match self.side(signer)? {
            Side::A => self.data[OFF_A_APPROVED] = 1,
            Side::B => self.data[OFF_B_APPROVED] = 1,
        }
        Ok(())
    }

    /// Either party may close when no note is still locked. Rent is recovered by the entrypoint.
    /// A `Proposed` escrow with a seal stays open. `Exchanged` and `Reclaimed` may close.
    pub fn close_ready(&self, signer: &[u8; 32]) -> Result<(), EscrowError> {
        if self.data[OFF_TAG] != ESCROW_TAG {
            return Err(EscrowError::NotInitialized);
        }
        let _ = self.side(signer)?;
        let status = self.data[OFF_STATUS];
        if status == Status::Proposed as u8 {
            if self.a_sealed() || self.b_sealed() {
                return Err(EscrowError::Frozen);
            }
            return Ok(());
        }
        if status == Status::Void as u8
            || status == Status::Exchanged as u8
            || status == Status::Reclaimed as u8
        {
            return Ok(());
        }
        Err(EscrowError::BadAccount)
    }

    /// Voids the proposal. A sealed side cannot decline.
    pub fn decline(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        self.require_proposed(now)?;
        if self.a_sealed() || self.b_sealed() {
            return Err(EscrowError::Frozen);
        }
        let _ = self.side(signer)?;
        self.data[OFF_STATUS] = Status::Void as u8;
        Ok(())
    }

    /// Sets the seal byte only. Does not move a note. Tests use this for the rule.
    pub fn seal_side(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        let side = self.ready_side(signer, now)?;
        self.set_sealed(side);
        Ok(())
    }

    /// Writes the output commitment, then the seal. A zero commitment is rejected.
    pub fn seal_note(
        &mut self,
        signer: &[u8; 32],
        now: i64,
        commitment: &[u8; 32],
    ) -> Result<(), EscrowError> {
        if commitment == &[0u8; COMMITMENT_LEN] {
            return Err(EscrowError::BadAccount);
        }
        let side = self.ready_side(signer, now)?;
        self.write_commitment(side, commitment);
        self.set_sealed(side);
        Ok(())
    }

    /// Same checks as a seal, and writes nothing. Used before the pool invoke.
    pub fn side_ready_to_seal(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        let _ = self.ready_side(signer, now)?;
        Ok(())
    }

    /// Party A may seal after their own approval. Party B may seal only after A is sealed and B has approved.
    fn ready_side(&mut self, signer: &[u8; 32], now: i64) -> Result<Side, EscrowError> {
        self.require_proposed(now)?;
        let side = self.side(signer)?;
        match side {
            Side::A => {
                if self.data[OFF_A_APPROVED] != 1 {
                    return Err(EscrowError::NotBothApproved);
                }
            }
            Side::B => {
                if self.data[OFF_B_APPROVED] != 1 {
                    return Err(EscrowError::NotBothApproved);
                }
                if !self.a_sealed() {
                    return Err(EscrowError::OtherSideMissing);
                }
            }
        }
        if self.sealed(side) {
            return Err(EscrowError::SideAlreadySealed);
        }
        Ok(side)
    }

    /// Marks `Exchanged`. The clock is not checked. Call only after the invoke.
    pub fn release(&mut self, _now: i64) -> Result<(), EscrowError> {
        self.release_ready()?;
        self.data[OFF_STATUS] = Status::Exchanged as u8;
        Ok(())
    }

    /// Proposed, and both seals set. Does not look at the clock or commitments.
    pub fn release_ready(&self) -> Result<(), EscrowError> {
        self.require_open()?;
        if !(self.a_sealed() && self.b_sealed()) {
            return Err(EscrowError::OtherSideMissing);
        }
        Ok(())
    }

    /// Clears this side's seal and commitment, then marks `Reclaimed`.
    pub fn reclaim(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        let side = self.reclaim_side(signer, now)?;
        self.set_sealed_flag(side, false);
        self.write_commitment(side, &[0u8; COMMITMENT_LEN]);
        self.data[OFF_STATUS] = Status::Reclaimed as u8;
        Ok(())
    }

    /// Same checks as `reclaim`, and writes nothing.
    pub fn reclaim_ready(&self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        let _ = self.reclaim_side(signer, now)?;
        Ok(())
    }

    /// After `start_at`, this side sealed, the other side still open.
    fn reclaim_side(&self, signer: &[u8; 32], now: i64) -> Result<Side, EscrowError> {
        self.require_open()?;
        if now < self.start_at() {
            return Err(EscrowError::TooEarly);
        }
        let side = self.side(signer)?;
        if !self.sealed(side) {
            return Err(EscrowError::SideNotSealed);
        }
        if self.sealed(side.other()) {
            return Err(EscrowError::OtherSideSealed);
        }
        Ok(side)
    }

    /// Wallet that created the escrow. Public on this path.
    pub fn party_a(&self) -> &[u8; 32] {
        self.party(OFF_PARTY_A)
    }

    /// The other wallet. Public on this path.
    pub fn party_b(&self) -> &[u8; 32] {
        self.party(OFF_PARTY_B)
    }

    /// `ESCROW_TAG` once `create` has written the account.
    pub fn tag(&self) -> u8 {
        self.data[OFF_TAG]
    }

    /// `Proposed`, `Void`, `Exchanged`, or `Reclaimed`.
    pub fn status(&self) -> u8 {
        self.data[OFF_STATUS]
    }

    /// Party A locked a note. The byte alone is not custody.
    pub fn a_sealed(&self) -> bool {
        self.data[OFF_A_SEALED] == 1
    }

    /// Party B locked a note. The byte alone is not custody.
    pub fn b_sealed(&self) -> bool {
        self.data[OFF_B_SEALED] == 1
    }

    /// Bump of the PDA that owns locked notes. Stored at create.
    pub fn bump(&self) -> u8 {
        self.data[OFF_BUMP]
    }

    /// Output note from A's lock. Zero until that invoke succeeds.
    pub fn commitment_a(&self) -> [u8; COMMITMENT_LEN] {
        self.commitment_at(OFF_COMMIT_A)
    }

    /// Output note from B's lock. Zero until that invoke succeeds.
    pub fn commitment_b(&self) -> [u8; COMMITMENT_LEN] {
        self.commitment_at(OFF_COMMIT_B)
    }

    /// Both locks stored a non-zero output. Required before a swap.
    pub fn has_both_commitments(&self) -> bool {
        self.commitment_a() != [0u8; COMMITMENT_LEN] && self.commitment_b() != [0u8; COMMITMENT_LEN]
    }

    /// Tag is set and status is still `Proposed`.
    fn require_open(&self) -> Result<(), EscrowError> {
        if self.data[OFF_TAG] != ESCROW_TAG {
            return Err(EscrowError::NotInitialized);
        }
        if self.data[OFF_STATUS] != Status::Proposed as u8 {
            return Err(EscrowError::AlreadyFinished);
        }
        Ok(())
    }

    /// Open, and `now` is strictly before both the deadline and `start_at`.
    fn require_proposed(&mut self, now: i64) -> Result<(), EscrowError> {
        self.require_open()?;
        if now >= self.approval_deadline() || now >= self.start_at() {
            return Err(EscrowError::TooLate);
        }
        Ok(())
    }

    /// `A` or `B`. Any other signer is `NotAParty`.
    fn side(&self, signer: &[u8; 32]) -> Result<Side, EscrowError> {
        if signer == self.party(OFF_PARTY_A) {
            Ok(Side::A)
        } else if signer == self.party(OFF_PARTY_B) {
            Ok(Side::B)
        } else {
            Err(EscrowError::NotAParty)
        }
    }

    /// 32-byte wallet at a fixed offset. The layout makes a short read impossible.
    fn party(&self, offset: usize) -> &[u8; 32] {
        self.data[offset..offset + 32]
            .try_into()
            .expect("party field is 32 bytes")
    }

    /// That side's seal byte is 1.
    fn sealed(&self, side: Side) -> bool {
        match side {
            Side::A => self.a_sealed(),
            Side::B => self.b_sealed(),
        }
    }

    /// Sets that side's seal byte. Does not touch the commitment.
    fn set_sealed(&mut self, side: Side) {
        self.set_sealed_flag(side, true);
    }

    /// Stores the 32-byte note commitment for that side.
    fn write_commitment(&mut self, side: Side, commitment: &[u8; COMMITMENT_LEN]) {
        let offset = match side {
            Side::A => OFF_COMMIT_A,
            Side::B => OFF_COMMIT_B,
        };
        self.data[offset..offset + COMMITMENT_LEN].copy_from_slice(commitment);
    }

    /// Copies one commitment field out of the account.
    fn commitment_at(&self, offset: usize) -> [u8; COMMITMENT_LEN] {
        let mut commitment = [0u8; COMMITMENT_LEN];
        commitment.copy_from_slice(&self.data[offset..offset + COMMITMENT_LEN]);
        commitment
    }

    /// Writes 1 or 0 into that side's seal byte.
    fn set_sealed_flag(&mut self, side: Side, value: bool) {
        let byte = u8::from(value);
        match side {
            Side::A => self.data[OFF_A_SEALED] = byte,
            Side::B => self.data[OFF_B_SEALED] = byte,
        }
    }

    /// Unix time after which a lone lock can be reclaimed.
    fn start_at(&self) -> i64 {
        i64_at(self.data, OFF_START)
    }

    /// Last time a party may approve. Must be at or before `start_at`.
    fn approval_deadline(&self) -> i64 {
        i64_at(self.data, OFF_DEADLINE)
    }
}

#[derive(Clone, Copy)]
enum Side {
    A,
    B,
}

impl Side {
    /// The party that is not `self`.
    fn other(self) -> Self {
        match self {
            Side::A => Side::B,
            Side::B => Side::A,
        }
    }
}

/// Little-endian i64 at a fixed offset. The account length makes this in range.
fn i64_at(data: &[u8], offset: usize) -> i64 {
    let bytes: [u8; 8] = data[offset..offset + 8]
        .try_into()
        .expect("i64 field is 8 bytes");
    i64::from_le_bytes(bytes)
}
