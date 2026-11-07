use pinocchio::cpi::Signer;
use pinocchio::error::ProgramError;
use pinocchio::{
    default_allocator, default_panic_handler, program_entrypoint, AccountView, Address, ProgramResult,
};
use spr_interface::instruction::TransactIxDataRef;
use spr_program::cpi::SppTransactAccounts;
use spr_program::CompressedProof;

use crate::error::EscrowError;
use crate::processor::{
    process, proved_lock, proved_return, proved_swap, Instruction, CIRCUIT_PROOF_LEN, LOCK_HEADER,
    LOCK_SEED, SPP_ID,
};
use crate::state::ACCOUNT_LEN;
use crate::verifier::{give_back, lock, swap};

program_entrypoint!(process_instruction);
default_allocator!();
default_panic_handler!();

/// Create, approve, and decline never move a note. The other three go to `move_note`.
fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (tag, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    let instruction = match tag {
        0 => Instruction::Create,
        1 => Instruction::Approve,
        2 => Instruction::Decline,
        3 => Instruction::FundSide,
        4 => Instruction::Release,
        5 => Instruction::Reclaim,
        6 => return close_escrow(program_id, accounts),
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    let moves_a_note = matches!(
        instruction,
        Instruction::FundSide | Instruction::Release | Instruction::Reclaim
    );
    if moves_a_note {
        return move_note(program_id, accounts, instruction, rest);
    }

    let escrow = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !escrow.is_writable() || !escrow.owned_by(program_id) || escrow.data_len() != ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let party = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let signer_bytes = *party.address().as_array();
    let signer_is_signer = party.is_signer();
    let account = *escrow.address().as_array();
    let now = if instruction == Instruction::Create {
        0
    } else {
        read_clock(accounts.get(2).ok_or(ProgramError::NotEnoughAccountKeys)?)?
    };
    let mut scratch = [0u8; ACCOUNT_LEN];
    scratch.copy_from_slice(&escrow.try_borrow()?);
    process(
        instruction,
        true,
        &mut scratch,
        &account,
        rest,
        &signer_bytes,
        signer_is_signer,
        now,
        None,
        &mut |_| Err(EscrowError::PrivateLockNotWired),
    )
    .map_err(map_error)?;
    accounts[0].try_borrow_mut()?.copy_from_slice(&scratch);
    Ok(())
}

/// Escrow, party, clock, then the pool accounts. Index 2 of that tail must be SPP.
fn move_note(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction: Instruction,
    rest: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, spp_accounts) = accounts.split_at_mut(3);
    let escrow = &head[0];
    if !escrow.is_writable() || !escrow.owned_by(program_id) || escrow.data_len() != ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let party = &head[1];
    let signer_bytes = *party.address().as_array();
    let signer_is_signer = party.is_signer();
    let account = *escrow.address().as_array();
    let now = read_clock(&head[2])?;
    let privacy = *spp_accounts
        .get(2)
        .ok_or(ProgramError::IncorrectProgramId)?
        .address()
        .as_array();
    if privacy != SPP_ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut scratch = [0u8; ACCOUNT_LEN];
    scratch.copy_from_slice(&escrow.try_borrow()?);
    let stored_bump = scratch[88];
    let before_invoke = scratch;
    process(
        instruction,
        true,
        &mut scratch,
        &account,
        rest,
        &signer_bytes,
        signer_is_signer,
        now,
        Some(&privacy),
        &mut |transact| {
            verify_circuit(
                instruction,
                &before_invoke,
                &account,
                &signer_bytes,
                now,
                rest,
                transact,
            )?;
            let pda_spends = matches!(instruction, Instruction::Release | Instruction::Reclaim);
            invoke_pool(
                program_id,
                &account,
                stored_bump,
                spp_accounts,
                transact,
                pda_spends,
            )
        },
    )
    .map_err(map_error)?;
    head[0].try_borrow_mut()?.copy_from_slice(&scratch);
    Ok(())
}

/// Reads the circuit proof that sits in front of the pool payload, checks it against this account, then the caller invokes.
fn verify_circuit(
    instruction: Instruction,
    data: &[u8],
    account: &[u8; 32],
    signer: &[u8; 32],
    now: i64,
    rest: &[u8],
    transact: &[u8],
) -> Result<(), EscrowError> {
    let header = match instruction {
        Instruction::FundSide => LOCK_HEADER,
        Instruction::Release | Instruction::Reclaim => 32,
        _ => return Err(EscrowError::BadAccount),
    };
    let proof_at = header
        .checked_add(CIRCUIT_PROOF_LEN)
        .ok_or(EscrowError::BadAccount)?;
    let proof_bytes = rest
        .get(header..proof_at)
        .ok_or(EscrowError::BadAccount)?;
    if rest.get(proof_at..) != Some(transact) {
        return Err(EscrowError::ProofMismatch);
    }
    let tx = TransactIxDataRef::from_bytes(transact).map_err(|_| EscrowError::BadAccount)?;
    if !tx.interface_transfers.is_empty() {
        return Err(EscrowError::ProofMismatch);
    }
    let proof = compressed_proof(proof_bytes)?;
    match instruction {
        Instruction::FundSide => {
            let side = *rest.get(32).ok_or(EscrowError::BadAccount)?;
            let public = proved_lock(data, account, side)?;
            lock::Verifier {
                proof: &proof,
                public_inputs: lock::PublicInputs {
                    escrow_0: public.limbs[0],
                    escrow_1: public.limbs[1],
                    escrow_2: public.limbs[2],
                    escrow_3: public.limbs[3],
                    start_at: public.limbs[4],
                    side: u64::from(public.side),
                    a_approved: u64::from(public.a_approved),
                    b_approved: u64::from(public.b_approved),
                },
                private_tx_hash: tx.private_tx_hash,
                transfers: &[],
            }
            .verify()
            .map_err(|_| EscrowError::ProofRejected)
        }
        Instruction::Release => {
            let public = proved_swap(data, account)?;
            swap::Verifier {
                proof: &proof,
                public_inputs: swap::PublicInputs {
                    escrow_0: public.limbs[0],
                    escrow_1: public.limbs[1],
                    escrow_2: public.limbs[2],
                    escrow_3: public.limbs[3],
                    start_at: public.limbs[4],
                    a_sealed: u64::from(public.a_sealed),
                    b_sealed: u64::from(public.b_sealed),
                },
                private_tx_hash: tx.private_tx_hash,
                transfers: &[],
            }
            .verify()
            .map_err(|_| EscrowError::ProofRejected)
        }
        Instruction::Reclaim => {
            let side = if signer.as_slice() == &data[24..56] {
                0
            } else if signer.as_slice() == &data[56..88] {
                1
            } else {
                return Err(EscrowError::NotAParty);
            };
            let public = proved_return(data, account, side, now)?;
            give_back::Verifier {
                proof: &proof,
                public_inputs: give_back::PublicInputs {
                    escrow_0: public.limbs[0],
                    escrow_1: public.limbs[1],
                    escrow_2: public.limbs[2],
                    escrow_3: public.limbs[3],
                    start_at: public.limbs[4],
                    now: public.now,
                    other_sealed: u64::from(public.other_sealed),
                },
                private_tx_hash: tx.private_tx_hash,
                transfers: &[],
            }
            .verify()
            .map_err(|_| EscrowError::ProofRejected)
        }
        _ => Err(EscrowError::BadAccount),
    }
}

fn compressed_proof(bytes: &[u8]) -> Result<CompressedProof, EscrowError> {
    if bytes.len() != CIRCUIT_PROOF_LEN {
        return Err(EscrowError::BadAccount);
    }
    let mut a = [0u8; 32];
    let mut b = [0u8; 64];
    let mut c = [0u8; 32];
    a.copy_from_slice(&bytes[0..32]);
    b.copy_from_slice(&bytes[32..96]);
    c.copy_from_slice(&bytes[96..128]);
    Ok(CompressedProof { a, b, c })
}

/// Checks the stored bump, then invokes SPP.
///
/// A lock spends the party's note and pays a dataless note to the PDA, so the
/// PDA stays unsigned. A swap or a give-back spends that note, so the PDA is
/// the owner signer and `invoke_signed` must present it. Signing it on a lock
/// makes `ring1` reject the proof.
fn invoke_pool(
    program_id: &Address,
    escrow: &[u8; 32],
    stored_bump: u8,
    spp_accounts: &[AccountView],
    transact: &[u8],
    pda_spends: bool,
) -> Result<(), EscrowError> {
    let (pda, bump) = Address::find_program_address(&[LOCK_SEED, escrow], program_id);
    if bump != stored_bump {
        return Err(EscrowError::BadAccount);
    }
    if !pda_spends {
        return SppTransactAccounts::new(spp_accounts, &[])
            .map_err(|_| EscrowError::WrongPrivacyProgram)?
            .invoke::<16>(transact, &[])
            .map_err(|_| EscrowError::InvokeFailed);
    }
    let bump_byte = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(LOCK_SEED),
        pinocchio::cpi::Seed::from(escrow),
        pinocchio::cpi::Seed::from(&bump_byte),
    ];
    let signer = Signer::from(&seeds);
    SppTransactAccounts::new(spp_accounts, &[&pda])
        .map_err(|_| EscrowError::WrongPrivacyProgram)?
        .invoke::<16>(transact, &[signer])
        .map_err(|_| EscrowError::InvokeFailed)
}

/// Escrow, then the party who closes. Party A is account 2 when someone else signs.
/// Lamports go to party A. A sealed `Proposed` escrow cannot close.
fn close_escrow(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let escrow = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !escrow.is_writable() || !escrow.owned_by(program_id) || escrow.data_len() != ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let party = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !party.is_signer() {
        return Err(map_error(EscrowError::NotAParty));
    }
    let signer = *party.address().as_array();
    let mut data = [0u8; ACCOUNT_LEN];
    data.copy_from_slice(&escrow.try_borrow()?);
    let party_a = {
        let escrow_state = crate::state::Escrow::load(&mut data).map_err(map_error)?;
        escrow_state.close_ready(&signer).map_err(map_error)?;
        *escrow_state.party_a()
    };
    let recipient_index = if accounts[1].address().as_array() == &party_a {
        1
    } else {
        let recipient = accounts.get(2).ok_or(ProgramError::NotEnoughAccountKeys)?;
        if recipient.address().as_array() != &party_a || !recipient.is_writable() {
            return Err(map_error(EscrowError::NotAParty));
        }
        2
    };
    if !accounts[recipient_index].is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if accounts[recipient_index].address() == accounts[0].address() {
        return Err(map_error(EscrowError::BadAccount));
    }
    let (escrow, tail) = accounts
        .split_first_mut()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let recipient = if recipient_index == 1 {
        &mut tail[0]
    } else {
        tail.get_mut(1).ok_or(ProgramError::NotEnoughAccountKeys)?
    };
    let rent = escrow.lamports();
    let credited = recipient
        .lamports()
        .checked_add(rent)
        .ok_or(ProgramError::InvalidAccountData)?;
    recipient.set_lamports(credited);
    escrow.set_lamports(0);
    escrow.try_borrow_mut()?.fill(0);
    // SAFETY: this account is writable and owned by this program. Its lamports are already 0
    // and its data is zero, so assigning the system program id only releases the empty account.
    unsafe {
        escrow.assign(&Address::new_from_array([0u8; 32]));
    }
    Ok(())
}

/// Clock `unix_timestamp` at byte 32. A short sysvar is rejected.
fn read_clock(clock: &AccountView) -> Result<i64, ProgramError> {
    let data = clock.try_borrow()?;
    if data.len() < 40 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut ts = [0u8; 8];
    ts.copy_from_slice(&data[32..40]);
    Ok(i64::from_le_bytes(ts))
}

/// Our code becomes a program `Custom` error. The seal is unchanged on the way out.
fn map_error(error: EscrowError) -> ProgramError {
    ProgramError::Custom(error.code())
}
