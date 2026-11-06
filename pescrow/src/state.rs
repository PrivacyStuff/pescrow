use crate::error::EscrowError;

pub const ESCROW_TAG: u8 = 1;
pub const ACCOUNT_LEN: usize = 88;

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
    pub fn load(data: &'a mut [u8]) -> Result<Self, EscrowError> {
        if data.len() != ACCOUNT_LEN {
            return Err(EscrowError::BadAccount);
        }
        Ok(Self { data })
    }

    pub fn create(
        &mut self,
        party_a: &[u8; 32],
        party_b: &[u8; 32],
        start_at: i64,
        approval_deadline: i64,
        ring: Ring,
        wallets: Wallets,
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
        self.data[OFF_START..OFF_START + 8].copy_from_slice(&start_at.to_le_bytes());
        self.data[OFF_DEADLINE..OFF_DEADLINE + 8].copy_from_slice(&approval_deadline.to_le_bytes());
        self.data[OFF_PARTY_A..OFF_PARTY_A + 32].copy_from_slice(party_a);
        self.data[OFF_PARTY_B..OFF_PARTY_B + 32].copy_from_slice(party_b);
        Ok(())
    }

    pub fn approve(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        self.require_proposed(now)?;
        match self.side(signer)? {
            Side::A => self.data[OFF_A_APPROVED] = 1,
            Side::B => self.data[OFF_B_APPROVED] = 1,
        }
        Ok(())
    }

    pub fn decline(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        self.require_proposed(now)?;
        if self.a_sealed() || self.b_sealed() {
            return Err(EscrowError::Frozen);
        }
        let _ = self.side(signer)?;
        self.data[OFF_STATUS] = Status::Void as u8;
        Ok(())
    }

    /// Records that this side's private note is now locked. Called only after a
    /// successful privacy-program CPI. Tests call it directly. The entrypoint
    /// does not, until that CPI exists.
    pub fn seal_side(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        let side = self.ready_side(signer, now)?;
        self.set_sealed(side);
        Ok(())
    }

    /// Same checks as `seal_side`, without writing the seal. `fund_side` uses
    /// this while the privacy-program CPI is still closed.
    pub fn side_ready_to_seal(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
        let _ = self.ready_side(signer, now)?;
        Ok(())
    }

    fn ready_side(&mut self, signer: &[u8; 32], now: i64) -> Result<Side, EscrowError> {
        self.require_proposed(now)?;
        if !self.both_approved() {
            return Err(EscrowError::NotBothApproved);
        }
        let side = self.side(signer)?;
        if self.sealed(side) {
            return Err(EscrowError::SideAlreadySealed);
        }
        Ok(side)
    }

    /// Both locks are enough. The deadline does not hold a completed swap.
    pub fn release(&mut self, _now: i64) -> Result<(), EscrowError> {
        self.require_open()?;
        if !(self.a_sealed() && self.b_sealed()) {
            return Err(EscrowError::OtherSideMissing);
        }
        self.data[OFF_STATUS] = Status::Exchanged as u8;
        Ok(())
    }

    pub fn reclaim(&mut self, signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
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
        self.set_sealed_flag(side, false);
        self.data[OFF_STATUS] = Status::Reclaimed as u8;
        Ok(())
    }

    pub fn tag(&self) -> u8 {
        self.data[OFF_TAG]
    }

    pub fn status(&self) -> u8 {
        self.data[OFF_STATUS]
    }

    pub fn a_sealed(&self) -> bool {
        self.data[OFF_A_SEALED] == 1
    }

    pub fn b_sealed(&self) -> bool {
        self.data[OFF_B_SEALED] == 1
    }

    fn require_open(&self) -> Result<(), EscrowError> {
        if self.data[OFF_TAG] != ESCROW_TAG {
            return Err(EscrowError::NotInitialized);
        }
        if self.data[OFF_STATUS] != Status::Proposed as u8 {
            return Err(EscrowError::AlreadyFinished);
        }
        Ok(())
    }

    fn require_proposed(&mut self, now: i64) -> Result<(), EscrowError> {
        self.require_open()?;
        if now >= self.approval_deadline() || now >= self.start_at() {
            return Err(EscrowError::TooLate);
        }
        Ok(())
    }

    fn both_approved(&self) -> bool {
        self.data[OFF_A_APPROVED] == 1 && self.data[OFF_B_APPROVED] == 1
    }

    fn side(&self, signer: &[u8; 32]) -> Result<Side, EscrowError> {
        if signer == self.party(OFF_PARTY_A) {
            Ok(Side::A)
        } else if signer == self.party(OFF_PARTY_B) {
            Ok(Side::B)
        } else {
            Err(EscrowError::NotAParty)
        }
    }

    fn party(&self, offset: usize) -> &[u8; 32] {
        self.data[offset..offset + 32]
            .try_into()
            .expect("party field is 32 bytes")
    }

    fn sealed(&self, side: Side) -> bool {
        match side {
            Side::A => self.a_sealed(),
            Side::B => self.b_sealed(),
        }
    }

    fn set_sealed(&mut self, side: Side) {
        self.set_sealed_flag(side, true);
    }

    fn set_sealed_flag(&mut self, side: Side, value: bool) {
        let byte = u8::from(value);
        match side {
            Side::A => self.data[OFF_A_SEALED] = byte,
            Side::B => self.data[OFF_B_SEALED] = byte,
        }
    }

    fn start_at(&self) -> i64 {
        i64_at(self.data, OFF_START)
    }

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
    fn other(self) -> Self {
        match self {
            Side::A => Side::B,
            Side::B => Side::A,
        }
    }
}

fn i64_at(data: &[u8], offset: usize) -> i64 {
    let bytes: [u8; 8] = data[offset..offset + 8]
        .try_into()
        .expect("i64 field is 8 bytes");
    i64::from_le_bytes(bytes)
}
