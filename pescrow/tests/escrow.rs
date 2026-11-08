use pescrow::{
    approve, binding_limbs, create, decline, fund_side, process, proved_lock, reclaim, release,
    CreateArgs, Escrow, EscrowError, Instruction, LockMove, PoolMove, Ring, Status, Wallets,
    ACCOUNT_LEN, CIRCUIT_PROOF_LEN, CREATE_IX_LEN, ESCROW_TAG, LOCK_HEADER, SPP_ID,
};

/// A 32-byte wallet filled with one byte, so tests can tell parties apart.
fn party(byte: u8) -> [u8; 32] {
    [byte; 32]
}

/// An empty account. Create must be the first write.
fn fresh() -> Vec<u8> {
    vec![0u8; ACCOUNT_LEN]
}

/// Permissionless ring, public wallets, bump 1. The only create that succeeds.
fn opened(data: &mut [u8]) {
    create(
        data,
        &CreateArgs {
            party_a: party(1),
            party_a_is_signer: true,
            party_b: party(2),
            start_at: 1_000,
            approval_deadline: 900,
            ring: Ring::Permissionless,
            wallets: Wallets::Public,
            bump: 1,
        },
    )
    .unwrap();
}

/// Approval deadline after `start_at` is rejected and the account stays empty.
#[test]
fn rejects_a_deadline_after_the_release_time() {
    let err = create(
        &mut fresh(),
        &CreateArgs {
            party_a: party(1),
            party_a_is_signer: true,
            party_b: party(2),
            start_at: 100,
            approval_deadline: 101,
            ring: Ring::Permissionless,
            wallets: Wallets::Public,
            bump: 1,
        },
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::DeadlineAfterRelease);
}

/// A foreign owner never reaches create.
#[test]
fn rejects_an_account_this_program_does_not_own() {
    let err = process(
        Instruction::Create,
        false,
        &mut fresh(),
        &party(0),
        &[0u8; 48],
        &party(1),
        true,
        0,
        None,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::BadAccount);
}

/// A wallet that is neither party cannot approve.
#[test]
fn rejects_a_third_party_approval() {
    let mut data = fresh();
    opened(&mut data);
    let err = approve(&mut data, &party(9), 100).unwrap_err();
    assert_eq!(err, EscrowError::NotAParty);
}

/// Approval at the deadline is too late. The window is strict.
#[test]
fn rejects_approval_at_the_deadline() {
    let mut data = fresh();
    opened(&mut data);
    let err = approve(&mut data, &party(1), 900).unwrap_err();
    assert_eq!(err, EscrowError::TooLate);
}

/// Decline voids an open proposal and fails once either side is sealed.
#[test]
fn decline_voids_the_proposal_and_a_sealed_escrow_cannot_be_declined() {
    let mut data = fresh();
    opened(&mut data);
    decline(&mut data, &party(2), 100).unwrap();
    assert_eq!(Escrow::load(&mut data).unwrap().status(), Status::Void as u8);

    let mut sealed = fresh();
    opened(&mut sealed);
    approve(&mut sealed, &party(1), 100).unwrap();
    approve(&mut sealed, &party(2), 100).unwrap();
    Escrow::load(&mut sealed).unwrap().seal_side(&party(1), 100).unwrap();
    let err = decline(&mut sealed, &party(2), 100).unwrap_err();
    assert_eq!(err, EscrowError::Frozen);
    assert!(Escrow::load(&mut sealed).unwrap().a_sealed());
}

/// One seal cannot release. That party reclaims only at or after `start_at`.
#[test]
fn a_lone_lock_cannot_release_and_comes_back_only_after_the_deadline() {
    let mut data = fresh();
    opened(&mut data);
    approve(&mut data, &party(1), 100).unwrap();
    approve(&mut data, &party(2), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();

    let missing = Escrow::load(&mut data).unwrap().release(100).unwrap_err();
    assert_eq!(missing, EscrowError::OtherSideMissing);

    let early_reclaim = Escrow::load(&mut data).unwrap().reclaim(&party(1), 100).unwrap_err();
    assert_eq!(early_reclaim, EscrowError::TooEarly);

    let still_missing = Escrow::load(&mut data).unwrap().release(1_000).unwrap_err();
    assert_eq!(still_missing, EscrowError::OtherSideMissing);

    Escrow::load(&mut data).unwrap().reclaim(&party(1), 1_000).unwrap();
    let escrow = Escrow::load(&mut data).unwrap();
    assert_eq!(escrow.status(), Status::Reclaimed as u8);
    assert!(!escrow.a_sealed());
}

/// Both seals release immediately. The deadline does not hold the swap.
#[test]
fn release_swaps_only_after_both_sides_are_sealed() {
    let mut data = fresh();
    opened(&mut data);
    approve(&mut data, &party(1), 100).unwrap();
    approve(&mut data, &party(2), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(2), 100).unwrap();
    Escrow::load(&mut data).unwrap().release(100).unwrap();
    assert_eq!(Escrow::load(&mut data).unwrap().status(), Status::Exchanged as u8);
    assert_eq!(Escrow::load(&mut data).unwrap().tag(), ESCROW_TAG);
}

/// Any program id other than the privacy program fails and does not seal.
#[test]
fn fund_rejects_any_program_other_than_the_privacy_program_and_does_not_seal() {
    let mut data = fresh();
    opened(&mut data);
    approve(&mut data, &party(1), 100).unwrap();
    approve(&mut data, &party(2), 100).unwrap();

    let wrong = fund_side(
        &mut data,
        &party(7),
        &party(1),
        100,
        Some(&[9u8; 32]),
        None,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(wrong, EscrowError::WrongPrivacyProgram);

    let stranger = fund_side(
        &mut data,
        &party(7),
        &party(9),
        100,
        Some(&SPP_ID),
        None,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(stranger, EscrowError::NotAParty);

    let closed = fund_side(
        &mut data,
        &party(7),
        &party(1),
        100,
        Some(&SPP_ID),
        None,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(closed, EscrowError::PrivateLockNotWired);
    assert!(!Escrow::load(&mut data).unwrap().a_sealed());
}

/// The same wallet on both sides is rejected before any write.
#[test]
fn two_parties_cannot_be_the_same_wallet() {
    let err = create(
        &mut fresh(),
        &CreateArgs {
            party_a: party(1),
            party_a_is_signer: true,
            party_b: party(1),
            start_at: 1_000,
            approval_deadline: 900,
            ring: Ring::Permissionless,
            wallets: Wallets::Public,
            bump: 1,
        },
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::SameParty);
}

/// The other three create choices return an error and leave the account empty.
#[test]
fn wallet_privacy_is_an_option_on_both_rings_and_the_open_ones_do_not_initialize() {
    let mut permissionless_private = fresh();
    let err = create(
        &mut permissionless_private,
        &CreateArgs {
            party_a: party(1),
            party_a_is_signer: true,
            party_b: party(2),
            start_at: 1_000,
            approval_deadline: 900,
            ring: Ring::Permissionless,
            wallets: Wallets::Private,
            bump: 1,
        },
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::PermissionlessPublishesWallets);
    assert_eq!(permissionless_private[0], 0);

    for wallets in [Wallets::Public, Wallets::Private] {
        let mut custom = fresh();
        let err = create(
            &mut custom,
            &CreateArgs {
                party_a: party(1),
                party_a_is_signer: true,
                party_b: party(2),
                start_at: 1_000,
                approval_deadline: 900,
                ring: Ring::Custom,
                wallets,
                bump: 1,
            },
        )
        .unwrap_err();
        assert_eq!(err, EscrowError::CustomRingUnset);
        assert_eq!(custom[0], 0);
    }
}

/// Create arguments. `a_signs` is the missing-signer case.
fn args(a_signs: bool) -> CreateArgs {
    CreateArgs {
        party_a: party(1),
        party_a_is_signer: a_signs,
        party_b: party(2),
        start_at: 1_000,
        approval_deadline: 900,
        ring: Ring::Permissionless,
        wallets: Wallets::Public,
        bump: 1,
    }
}

/// Opens the account and records both approvals at time 100.
fn both_approved(data: &mut [u8]) {
    opened(data);
    approve(data, &party(1), 100).unwrap();
    approve(data, &party(2), 100).unwrap();
}

/// A lock of side A. `transact` empty means the invoke must not run.
fn lock_of<'a>(escrow: [u8; 32], transact: &'a [u8]) -> LockMove<'a> {
    LockMove {
        escrow,
        side: 0,
        commitment: party(4),
        transact,
    }
}

/// Missing signer, a short instruction, and an unknown ring byte all fail closed.
#[test]
fn create_rejects_a_missing_signer_a_short_instruction_and_an_unknown_ring() {
    let err = create(&mut fresh(), &args(false)).unwrap_err();
    assert_eq!(err, EscrowError::NotAParty);

    let err = process(
        Instruction::Create,
        true,
        &mut fresh(),
        &party(7),
        &[0u8; 10],
        &party(1),
        true,
        0,
        None,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::BadAccount);

    let mut ix = [0u8; CREATE_IX_LEN];
    ix[48] = 9;
    ix[49] = 1;
    let err = process(
        Instruction::Create,
        true,
        &mut fresh(),
        &party(7),
        &ix,
        &party(1),
        true,
        0,
        None,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::BadAccount);
}

/// A second create fails. The first one stored the bump.
#[test]
fn create_rejects_an_account_that_is_already_open_and_stores_the_bump() {
    let mut data = fresh();
    opened(&mut data);
    assert_eq!(Escrow::load(&mut data).unwrap().bump(), 1);
    let err = create(&mut data, &args(true)).unwrap_err();
    assert_eq!(err, EscrowError::AlreadyInitialized);
}

/// Party A seals after their own approval. Party B waits until that seal exists.
#[test]
fn party_a_seals_alone_and_party_b_waits_for_that_seal() {
    let mut early = fresh();
    opened(&mut early);
    let err = Escrow::load(&mut early).unwrap().seal_side(&party(1), 100).unwrap_err();
    assert_eq!(err, EscrowError::NotBothApproved);
    approve(&mut early, &party(1), 100).unwrap();
    Escrow::load(&mut early).unwrap().seal_side(&party(1), 100).unwrap();
    assert!(Escrow::load(&mut early).unwrap().a_sealed());
    assert!(!Escrow::load(&mut early).unwrap().b_sealed());

    let mut waiting = fresh();
    both_approved(&mut waiting);
    let err = Escrow::load(&mut waiting).unwrap().seal_side(&party(2), 100).unwrap_err();
    assert_eq!(err, EscrowError::OtherSideMissing);
    Escrow::load(&mut waiting).unwrap().seal_side(&party(1), 100).unwrap();
    Escrow::load(&mut waiting).unwrap().seal_side(&party(2), 100).unwrap();
    assert!(Escrow::load(&mut waiting).unwrap().b_sealed());

    let mut unapproved_b = fresh();
    opened(&mut unapproved_b);
    approve(&mut unapproved_b, &party(1), 100).unwrap();
    Escrow::load(&mut unapproved_b).unwrap().seal_side(&party(1), 100).unwrap();
    let err = Escrow::load(&mut unapproved_b)
        .unwrap()
        .seal_side(&party(2), 100)
        .unwrap_err();
    assert_eq!(err, EscrowError::NotBothApproved);
    assert!(!Escrow::load(&mut unapproved_b).unwrap().b_sealed());

    let mut data = fresh();
    both_approved(&mut data);
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();
    let err = Escrow::load(&mut data).unwrap().seal_side(&party(1), 200).unwrap_err();
    assert_eq!(err, EscrowError::SideAlreadySealed);

    let mut late = fresh();
    both_approved(&mut late);
    let err = Escrow::load(&mut late).unwrap().seal_side(&party(1), 900).unwrap_err();
    assert_eq!(err, EscrowError::TooLate);
}

/// The party who never locked cannot reclaim, and neither can a fully sealed pair.
#[test]
fn reclaim_rejects_the_unlocked_party_and_a_completed_pair() {
    let mut data = fresh();
    both_approved(&mut data);
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();
    let err = Escrow::load(&mut data).unwrap().reclaim(&party(2), 1_000).unwrap_err();
    assert_eq!(err, EscrowError::SideNotSealed);

    Escrow::load(&mut data).unwrap().seal_side(&party(2), 100).unwrap();
    let err = Escrow::load(&mut data).unwrap().reclaim(&party(1), 1_000).unwrap_err();
    assert_eq!(err, EscrowError::OtherSideSealed);
}

/// Release after `Exchanged`, and decline after `Void`, both fail.
#[test]
fn release_and_decline_reject_a_finished_escrow() {
    let mut data = fresh();
    both_approved(&mut data);
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(2), 100).unwrap();
    Escrow::load(&mut data).unwrap().release(100).unwrap();
    let err = Escrow::load(&mut data).unwrap().release(100).unwrap_err();
    assert_eq!(err, EscrowError::AlreadyFinished);

    let mut voided = fresh();
    opened(&mut voided);
    decline(&mut voided, &party(1), 100).unwrap();
    let err = decline(&mut voided, &party(2), 100).unwrap_err();
    assert_eq!(err, EscrowError::AlreadyFinished);
}

/// A skipped or failed invoke does not seal. A matching one stores the commitment.
#[test]
fn a_skipped_or_failed_invoke_does_not_seal_and_a_matching_invoke_does() {
    let account = party(7);
    let mut skipped = fresh();
    both_approved(&mut skipped);
    let mut called = false;
    let err = fund_side(
        &mut skipped,
        &account,
        &party(1),
        100,
        Some(&SPP_ID),
        Some(lock_of(account, &[])),
        &mut |_| {
            called = true;
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::PrivateLockNotWired);
    assert!(!called);
    assert!(!Escrow::load(&mut skipped).unwrap().a_sealed());

    let mut failed = fresh();
    both_approved(&mut failed);
    let err = fund_side(
        &mut failed,
        &account,
        &party(1),
        100,
        Some(&SPP_ID),
        Some(lock_of(account, &[1])),
        &mut |_| Err(EscrowError::InvokeFailed),
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::InvokeFailed);
    assert!(!Escrow::load(&mut failed).unwrap().a_sealed());

    let mut other = fresh();
    both_approved(&mut other);
    let err = fund_side(
        &mut other,
        &account,
        &party(1),
        100,
        Some(&SPP_ID),
        Some(lock_of(party(8), &[1])),
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::ProofMismatch);

    let mut locked = fresh();
    both_approved(&mut locked);
    fund_side(
        &mut locked,
        &account,
        &party(1),
        100,
        Some(&SPP_ID),
        Some(lock_of(account, &[9])),
        &mut |_| Ok(()),
    )
    .unwrap();
    let escrow = Escrow::load(&mut locked).unwrap();
    assert!(escrow.a_sealed());
    assert_eq!(escrow.commitment_a(), party(4));
    assert!(!escrow.b_sealed());
}

/// Release and reclaim stay unchanged until an invoke names this escrow.
#[test]
fn release_and_reclaim_wait_for_an_invoke_that_names_this_account() {
    let account = party(7);
    let mut data = fresh();
    both_approved(&mut data);
    Escrow::load(&mut data).unwrap().seal_note(&party(1), 100, &party(4)).unwrap();
    Escrow::load(&mut data).unwrap().seal_note(&party(2), 100, &party(5)).unwrap();

    let err = release(&mut data, &account, 100, None, &mut |_| unreachable!()).unwrap_err();
    assert_eq!(err, EscrowError::PrivateLockNotWired);
    assert_eq!(Escrow::load(&mut data).unwrap().status(), Status::Proposed as u8);

    release(
        &mut data,
        &account,
        100,
        Some(PoolMove { escrow: account, transact: &[1] }),
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(Escrow::load(&mut data).unwrap().status(), Status::Exchanged as u8);

    let mut lone = fresh();
    both_approved(&mut lone);
    Escrow::load(&mut lone).unwrap().seal_note(&party(1), 100, &party(4)).unwrap();
    let err = reclaim(&mut lone, &account, &party(1), 1_000, None, &mut |_| unreachable!()).unwrap_err();
    assert_eq!(err, EscrowError::PrivateLockNotWired);
    assert!(Escrow::load(&mut lone).unwrap().a_sealed());

    reclaim(
        &mut lone,
        &account,
        &party(1),
        1_000,
        Some(PoolMove { escrow: account, transact: &[1] }),
        &mut |_| Ok(()),
    )
    .unwrap();
    let escrow = Escrow::load(&mut lone).unwrap();
    assert_eq!(escrow.status(), Status::Reclaimed as u8);
    assert_eq!(escrow.commitment_a(), [0u8; 32]);
}

/// Public inputs are read from this account. Another address is a different input.
#[test]
fn public_inputs_are_this_account_and_a_swapped_address_differs() {
    let account = party(7);
    let mut data = fresh();
    both_approved(&mut data);
    let here = proved_lock(&data, &account, 0).unwrap();
    assert_eq!(here.a_approved, 1);
    assert_eq!(here.b_approved, 1);
    assert_eq!(here.limbs[4], 1_000);
    let elsewhere = proved_lock(&data, &party(8), 0).unwrap();
    assert_ne!(here.limbs, elsewhere.limbs);
    assert!(binding_limbs(&account, -1).is_err());
}

/// A lock instruction without the 128-byte circuit proof never reaches the pool.
#[test]
fn a_lock_without_the_circuit_proof_is_rejected() {
    let mut data = fresh();
    both_approved(&mut data);
    let mut ix = vec![0u8; LOCK_HEADER];
    ix[..32].copy_from_slice(&party(7));
    ix[33..65].copy_from_slice(&party(4));
    let err = process(
        Instruction::FundSide,
        true,
        &mut data,
        &party(7),
        &ix,
        &party(1),
        true,
        100,
        Some(&SPP_ID),
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::BadAccount);
    assert_eq!(CIRCUIT_PROOF_LEN, 128);
    assert!(!Escrow::load(&mut data).unwrap().a_sealed());
}

/// An unsealed escrow can close after the deadline. A sealed one cannot. A finished swap can.
#[test]
fn close_returns_rent_only_when_no_note_is_still_locked() {
    let mut dead = fresh();
    opened(&mut dead);
    Escrow::load(&mut dead).unwrap().close_ready(&party(2)).unwrap();
    let stranger = Escrow::load(&mut dead).unwrap().close_ready(&party(9));
    assert_eq!(stranger.unwrap_err(), EscrowError::NotAParty);

    let mut locked = fresh();
    both_approved(&mut locked);
    Escrow::load(&mut locked).unwrap().seal_side(&party(1), 100).unwrap();
    let frozen = Escrow::load(&mut locked).unwrap().close_ready(&party(1));
    assert_eq!(frozen.unwrap_err(), EscrowError::Frozen);

    let mut swapped = fresh();
    both_approved(&mut swapped);
    Escrow::load(&mut swapped).unwrap().seal_side(&party(1), 100).unwrap();
    Escrow::load(&mut swapped).unwrap().seal_side(&party(2), 100).unwrap();
    Escrow::load(&mut swapped).unwrap().release(1_000).unwrap();
    Escrow::load(&mut swapped).unwrap().close_ready(&party(1)).unwrap();

    let empty = Escrow::load(&mut fresh()).unwrap().close_ready(&party(1));
    assert_eq!(empty.unwrap_err(), EscrowError::NotInitialized);
}
