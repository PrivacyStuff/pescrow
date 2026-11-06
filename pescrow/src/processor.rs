use crate::error::EscrowError;
use crate::state::{Escrow, Ring, Wallets, ACCOUNT_LEN};

/// Devnet Solana Privacy Program. `fund_side` accepts only this id.
pub const SPP_ID: [u8; 32] = [
    13, 5, 27, 223, 81, 46, 238, 38, 11, 21, 75, 117, 129, 42, 173, 235, 128, 207, 186, 54, 100,
    214, 57, 55, 88, 166, 92, 51, 242, 53, 239, 61,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Instruction {
    Create = 0,
    Approve = 1,
    Decline = 2,
    FundSide = 3,
    Release = 4,
    Reclaim = 5,
}

pub struct CreateArgs {
    pub party_a: [u8; 32],
    pub party_a_is_signer: bool,
    pub party_b: [u8; 32],
    pub start_at: i64,
    pub approval_deadline: i64,
    pub ring: Ring,
    pub wallets: Wallets,
}

pub fn process(
    instruction: Instruction,
    escrow_owned_by_program: bool,
    escrow_data: &mut [u8],
    ix: &[u8],
    signer: &[u8; 32],
    signer_is_signer: bool,
    now: i64,
    privacy_program: Option<&[u8; 32]>,
) -> Result<(), EscrowError> {
    if !escrow_owned_by_program || escrow_data.len() != ACCOUNT_LEN {
        return Err(EscrowError::BadAccount);
    }
    match instruction {
        Instruction::Create => {
            let args = parse_create(ix, signer, signer_is_signer)?;
            create(escrow_data, &args)
        }
        Instruction::Approve => {
            require_signer(signer_is_signer)?;
            approve(escrow_data, signer, now)
        }
        Instruction::Decline => {
            require_signer(signer_is_signer)?;
            decline(escrow_data, signer, now)
        }
        Instruction::FundSide => {
            require_signer(signer_is_signer)?;
            fund_side(escrow_data, signer, now, privacy_program)
        }
        Instruction::Release => release(escrow_data, now),
        Instruction::Reclaim => {
            require_signer(signer_is_signer)?;
            reclaim(escrow_data, signer, now)
        }
    }
}

pub fn create(data: &mut [u8], args: &CreateArgs) -> Result<(), EscrowError> {
    if !args.party_a_is_signer {
        return Err(EscrowError::NotAParty);
    }
    let mut escrow = Escrow::load(data)?;
    escrow.create(
        &args.party_a,
        &args.party_b,
        args.start_at,
        args.approval_deadline,
        args.ring,
        args.wallets,
    )
}

pub fn approve(data: &mut [u8], signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
    Escrow::load(data)?.approve(signer, now)
}

pub fn decline(data: &mut [u8], signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
    Escrow::load(data)?.decline(signer, now)
}

pub fn fund_side(
    data: &mut [u8],
    signer: &[u8; 32],
    now: i64,
    privacy_program: Option<&[u8; 32]>,
) -> Result<(), EscrowError> {
    let program = privacy_program.ok_or(EscrowError::WrongPrivacyProgram)?;
    if program != &SPP_ID {
        return Err(EscrowError::WrongPrivacyProgram);
    }
    // Checks run before the closed door. Nothing is sealed.
    let _ = Escrow::load(data)?.side_ready_to_seal(signer, now)?;
    Err(EscrowError::PrivateLockNotWired)
}

pub fn release(data: &mut [u8], now: i64) -> Result<(), EscrowError> {
    Escrow::load(data)?.release(now)
}

pub fn reclaim(data: &mut [u8], signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
    Escrow::load(data)?.reclaim(signer, now)
}

fn require_signer(is_signer: bool) -> Result<(), EscrowError> {
    if is_signer {
        Ok(())
    } else {
        Err(EscrowError::NotAParty)
    }
}

fn parse_create(ix: &[u8], party_a: &[u8; 32], party_a_is_signer: bool) -> Result<CreateArgs, EscrowError> {
    if ix.len() != 50 {
        return Err(EscrowError::BadAccount);
    }
    let mut party_b = [0u8; 32];
    party_b.copy_from_slice(&ix[0..32]);
    let start_at = i64_from(&ix[32..40])?;
    let approval_deadline = i64_from(&ix[40..48])?;
    let ring = match ix[48] {
        1 => Ring::Permissionless,
        2 => Ring::Custom,
        _ => return Err(EscrowError::BadAccount),
    };
    let wallets = match ix[49] {
        1 => Wallets::Public,
        2 => Wallets::Private,
        _ => return Err(EscrowError::BadAccount),
    };
    Ok(CreateArgs {
        party_a: *party_a,
        party_a_is_signer,
        party_b,
        start_at,
        approval_deadline,
        ring,
        wallets,
    })
}

fn i64_from(bytes: &[u8]) -> Result<i64, EscrowError> {
    let sized: [u8; 8] = bytes.try_into().map_err(|_| EscrowError::BadAccount)?;
    Ok(i64::from_le_bytes(sized))
}
