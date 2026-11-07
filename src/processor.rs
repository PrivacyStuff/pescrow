use crate::error::EscrowError;
use crate::state::{Escrow, Ring, Wallets, ACCOUNT_LEN};

/// Devnet permissionless pool, `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW`.
/// `fund_side`, `release`, and `reclaim` accept only this id. The account layout is unchanged.
pub const SPP_ID: [u8; 32] = [
    12, 188, 181, 120, 174, 97, 37, 129, 50, 238, 175, 106, 193, 33, 192, 164, 43, 136, 162, 232,
    79, 177, 30, 126, 45, 91, 160, 175, 209, 39, 49, 99,
];

/// Seeds of the PDA that owns a locked note. The second seed is the escrow address.
pub const LOCK_SEED: &[u8] = b"escrow-lock";

pub const CREATE_IX_LEN: usize = 51;

/// Escrow address and deadline, in the order the lock circuit's public inputs hash.
pub fn binding_limbs(escrow: &[u8; 32], start_at: i64) -> Result<[u64; 5], EscrowError> {
    let limb = |offset: usize| {
        let bytes: [u8; 8] = escrow[offset..offset + 8]
            .try_into()
            .map_err(|_| EscrowError::BadAccount)?;
        Ok(u64::from_le_bytes(bytes))
    };
    let start = u64::try_from(start_at).map_err(|_| EscrowError::BadAccount)?;
    Ok([limb(0)?, limb(8)?, limb(16)?, limb(24)?, start])
}

/// Lock public inputs, read from this account. `side` is the party sealing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProvedLock {
    pub limbs: [u64; 5],
    pub side: u8,
    pub a_approved: u8,
    pub b_approved: u8,
}

/// Swap public inputs. Both seal bytes come from the account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProvedSwap {
    pub limbs: [u64; 5],
    pub a_sealed: u8,
    pub b_sealed: u8,
}

/// Return public inputs. `now` is the clock, not a client byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProvedReturn {
    pub limbs: [u64; 5],
    pub now: u64,
    pub other_sealed: u8,
}

/// `start_at` from the account. A short buffer is `BadAccount`.
fn account_start(data: &[u8]) -> Result<i64, EscrowError> {
    if data.len() != ACCOUNT_LEN {
        return Err(EscrowError::BadAccount);
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[8..16]);
    Ok(i64::from_le_bytes(bytes))
}

/// Lock public inputs taken from this account, not from the client proof.
pub fn proved_lock(data: &[u8], escrow: &[u8; 32], side: u8) -> Result<ProvedLock, EscrowError> {
    if side > 1 {
        return Err(EscrowError::BadAccount);
    }
    Ok(ProvedLock {
        limbs: binding_limbs(escrow, account_start(data)?)?,
        side,
        a_approved: data[2],
        b_approved: data[3],
    })
}

/// Swap public inputs. Both seal bytes are the account's, not the proof's.
pub fn proved_swap(data: &[u8], escrow: &[u8; 32]) -> Result<ProvedSwap, EscrowError> {
    Ok(ProvedSwap {
        limbs: binding_limbs(escrow, account_start(data)?)?,
        a_sealed: data[4],
        b_sealed: data[5],
    })
}

/// Return public inputs. `now` is the clock. `other_sealed` is the other party.
pub fn proved_return(
    data: &[u8],
    escrow: &[u8; 32],
    side: u8,
    now: i64,
) -> Result<ProvedReturn, EscrowError> {
    if side > 1 {
        return Err(EscrowError::BadAccount);
    }
    let now = u64::try_from(now).map_err(|_| EscrowError::BadAccount)?;
    let other_sealed = if side == 0 { data[5] } else { data[4] };
    Ok(ProvedReturn {
        limbs: binding_limbs(escrow, account_start(data)?)?,
        now,
        other_sealed,
    })
}

pub const LOCK_HEADER: usize = 32 + 1 + 32;
/// Compressed Groth16 proof: 32-byte A, 64-byte B, 32-byte C. It sits after the header and before the pool payload.
pub const CIRCUIT_PROOF_LEN: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Instruction {
    Create = 0,
    Approve = 1,
    Decline = 2,
    FundSide = 3,
    Release = 4,
    Reclaim = 5,
    Close = 6,
}

pub struct CreateArgs {
    pub party_a: [u8; 32],
    pub party_a_is_signer: bool,
    pub party_b: [u8; 32],
    pub start_at: i64,
    pub approval_deadline: i64,
    pub ring: Ring,
    pub wallets: Wallets,
    pub bump: u8,
}

/// Public inputs of a lock, plus the opaque shielded-pool payload.
pub struct LockMove<'a> {
    pub escrow: [u8; 32],
    pub side: u8,
    pub commitment: [u8; 32],
    pub transact: &'a [u8],
}

/// Public inputs of a swap or a return. The payload is not parsed here.
pub struct PoolMove<'a> {
    pub escrow: [u8; 32],
    pub transact: &'a [u8],
}

/// One instruction. The account must be ours and 160 bytes. `invoke` runs the pool.
pub fn process(
    instruction: Instruction,
    escrow_owned_by_program: bool,
    escrow_data: &mut [u8],
    account: &[u8; 32],
    ix: &[u8],
    signer: &[u8; 32],
    signer_is_signer: bool,
    now: i64,
    privacy_program: Option<&[u8; 32]>,
    invoke: &mut dyn FnMut(&[u8]) -> Result<(), EscrowError>,
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
            fund_side(
                escrow_data,
                account,
                signer,
                now,
                privacy_program,
                parse_lock(ix)?,
                invoke,
            )
        }
        Instruction::Release => release(escrow_data, account, now, parse_pool(ix)?, invoke),
        Instruction::Reclaim => {
            require_signer(signer_is_signer)?;
            reclaim(escrow_data, account, signer, now, parse_pool(ix)?, invoke)
        }
        Instruction::Close => {
            require_signer(signer_is_signer)?;
            Escrow::load(escrow_data)?.close_ready(signer)
        }
    }
}

/// Party A must be the signer. Writes nothing if `create` rejects the pair.
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
        args.bump,
    )
}

/// Records one party's approval. No proof.
pub fn approve(data: &mut [u8], signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
    Escrow::load(data)?.approve(signer, now)
}

/// Voids an unsealed proposal. No proof.
pub fn decline(data: &mut [u8], signer: &[u8; 32], now: i64) -> Result<(), EscrowError> {
    Escrow::load(data)?.decline(signer, now)
}

/// Checks the privacy program id, then the lock inputs, then invokes. Seals after.
pub fn fund_side(
    data: &mut [u8],
    account: &[u8; 32],
    signer: &[u8; 32],
    now: i64,
    privacy_program: Option<&[u8; 32]>,
    lock: Option<LockMove<'_>>,
    invoke: &mut dyn FnMut(&[u8]) -> Result<(), EscrowError>,
) -> Result<(), EscrowError> {
    let program = privacy_program.ok_or(EscrowError::WrongPrivacyProgram)?;
    if program != &SPP_ID {
        return Err(EscrowError::WrongPrivacyProgram);
    }
    Escrow::load(data)?.side_ready_to_seal(signer, now)?;
    let Some(lock) = lock else {
        return Err(EscrowError::PrivateLockNotWired);
    };
    if &lock.escrow != account || !side_matches(data, signer, lock.side)? {
        return Err(EscrowError::ProofMismatch);
    }
    if lock.commitment == [0u8; 32] {
        return Err(EscrowError::BadAccount);
    }
    if lock.transact.is_empty() {
        return Err(EscrowError::PrivateLockNotWired);
    }
    let _public = proved_lock(data, account, lock.side)?;
    invoke(lock.transact)?;
    Escrow::load(data)?.seal_note(signer, now, &lock.commitment)
}

/// Both commitments must exist. Status stays `Proposed` until the invoke returns.
pub fn release(
    data: &mut [u8],
    account: &[u8; 32],
    now: i64,
    swap: Option<PoolMove<'_>>,
    invoke: &mut dyn FnMut(&[u8]) -> Result<(), EscrowError>,
) -> Result<(), EscrowError> {
    {
        let escrow = Escrow::load(data)?;
        escrow.release_ready()?;
        if !escrow.has_both_commitments() {
            return Err(EscrowError::MissingCommitment);
        }
    }
    let Some(swap) = swap else {
        return Err(EscrowError::PrivateLockNotWired);
    };
    if &swap.escrow != account {
        return Err(EscrowError::ProofMismatch);
    }
    if swap.transact.is_empty() {
        return Err(EscrowError::PrivateLockNotWired);
    }
    let _public = proved_swap(data, account)?;
    invoke(swap.transact)?;
    Escrow::load(data)?.release(now)
}

/// Rules run before the invoke, so a failed return leaves the seal in place.
pub fn reclaim(
    data: &mut [u8],
    account: &[u8; 32],
    signer: &[u8; 32],
    now: i64,
    give_back: Option<PoolMove<'_>>,
    invoke: &mut dyn FnMut(&[u8]) -> Result<(), EscrowError>,
) -> Result<(), EscrowError> {
    {
        let _ = Escrow::load(data)?.reclaim_ready(signer, now)?;
    }
    let Some(give_back) = give_back else {
        return Err(EscrowError::PrivateLockNotWired);
    };
    if &give_back.escrow != account {
        return Err(EscrowError::ProofMismatch);
    }
    if give_back.transact.is_empty() {
        return Err(EscrowError::PrivateLockNotWired);
    }
    let side = {
        let escrow = Escrow::load(data)?;
        if signer == escrow.party_a() {
            0
        } else {
            1
        }
    };
    let _public = proved_return(data, account, side, now)?;
    invoke(give_back.transact)?;
    Escrow::load(data)?.reclaim(signer, now)
}

/// Side 0 is party A and side 1 is party B. Anything else is false.
fn side_matches(data: &mut [u8], signer: &[u8; 32], side: u8) -> Result<bool, EscrowError> {
    let escrow = Escrow::load(data)?;
    let party_a = signer == escrow.party_a();
    let party_b = signer == escrow.party_b();
    Ok((side == 0 && party_a) || (side == 1 && party_b))
}

/// The party account must have signed. A matching address is not enough.
fn require_signer(is_signer: bool) -> Result<(), EscrowError> {
    if is_signer {
        Ok(())
    } else {
        Err(EscrowError::NotAParty)
    }
}

/// 51 bytes: party B, two times, ring, wallets, bump. A short buffer fails.
fn parse_create(ix: &[u8], party_a: &[u8; 32], party_a_is_signer: bool) -> Result<CreateArgs, EscrowError> {
    if ix.len() != CREATE_IX_LEN {
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
        bump: ix[50],
    })
}

/// Empty means no pool move. Otherwise escrow, side, commitment, then opaque bytes.
fn parse_lock(ix: &[u8]) -> Result<Option<LockMove<'_>>, EscrowError> {
    if ix.is_empty() {
        return Ok(None);
    }
    let transact = proof_suffix(ix, LOCK_HEADER)?;
    let mut escrow = [0u8; 32];
    escrow.copy_from_slice(&ix[0..32]);
    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(&ix[33..65]);
    Ok(Some(LockMove {
        escrow,
        side: ix[32],
        commitment,
        transact,
    }))
}

/// Empty means no pool move. Otherwise this escrow address, then opaque bytes.
fn parse_pool(ix: &[u8]) -> Result<Option<PoolMove<'_>>, EscrowError> {
    if ix.is_empty() {
        return Ok(None);
    }
    let transact = proof_suffix(ix, 32)?;
    let mut escrow = [0u8; 32];
    escrow.copy_from_slice(&ix[0..32]);
    Ok(Some(PoolMove { escrow, transact }))
}

/// The pool payload follows the header and the circuit proof. A short buffer is `BadAccount`.
fn proof_suffix(ix: &[u8], header: usize) -> Result<&[u8], EscrowError> {
    let end = header
        .checked_add(CIRCUIT_PROOF_LEN)
        .ok_or(EscrowError::BadAccount)?;
    ix.get(end..).ok_or(EscrowError::BadAccount)
}

/// Eight little-endian bytes, or `BadAccount`.
fn i64_from(bytes: &[u8]) -> Result<i64, EscrowError> {
    let sized: [u8; 8] = bytes.try_into().map_err(|_| EscrowError::BadAccount)?;
    Ok(i64::from_le_bytes(sized))
}
