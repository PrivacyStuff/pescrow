use pinocchio::error::ProgramError;
use pinocchio::{no_allocator, nostd_panic_handler, program_entrypoint, AccountView, Address, ProgramResult};

use crate::error::EscrowError;
use crate::processor::{process, Instruction, SPP_ID};
use crate::state::ACCOUNT_LEN;

program_entrypoint!(process_instruction);
no_allocator!();
nostd_panic_handler!();

/// Accounts: 0 escrow, 1 party, 2 clock (every instruction except create), 3 privacy program (fund only).
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
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    let escrow = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !escrow.is_writable() || !escrow.owned_by(program_id) || escrow.data_len() != ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let party = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let signer_bytes = *party.address().as_array();
    let signer_is_signer = party.is_signer();

    let needs_clock = !matches!(instruction, Instruction::Create);
    let now = if needs_clock {
        read_clock(accounts.get(2).ok_or(ProgramError::NotEnoughAccountKeys)?)?
    } else {
        0
    };

    let privacy = if instruction == Instruction::FundSide {
        let program = accounts.get(3).ok_or(ProgramError::IncorrectProgramId)?;
        let id = *program.address().as_array();
        if id != SPP_ID {
            return Err(ProgramError::IncorrectProgramId);
        }
        Some(id)
    } else {
        None
    };

    let mut data = accounts[0].try_borrow_mut()?;
    process(
        instruction,
        true,
        &mut data,
        rest,
        &signer_bytes,
        signer_is_signer,
        now,
        privacy.as_ref(),
    )
    .map_err(map_error)
}

fn read_clock(clock: &AccountView) -> Result<i64, ProgramError> {
    let data = clock.try_borrow()?;
    if data.len() < 40 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut ts = [0u8; 8];
    ts.copy_from_slice(&data[32..40]);
    Ok(i64::from_le_bytes(ts))
}

fn map_error(error: EscrowError) -> ProgramError {
    ProgramError::Custom(error.code())
}
