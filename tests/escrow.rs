use pescrow::{
    approve, create, decline, fund_side, process, reclaim, release, CreateArgs, Escrow, EscrowError,
    Instruction, Ring, Status, Wallets, ACCOUNT_LEN, ESCROW_TAG, SPP_ID,
};

fn party(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn fresh() -> Vec<u8> {
    vec![0u8; ACCOUNT_LEN]
}

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
        },
    )
    .unwrap();
}

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
        },
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::DeadlineAfterRelease);
}

#[test]
fn rejects_an_account_this_program_does_not_own() {
    let err = process(
        Instruction::Create,
        false,
        &mut fresh(),
        &[0u8; 48],
        &party(1),
        true,
        0,
        None,
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::BadAccount);
}

#[test]
fn rejects_a_third_party_approval() {
    let mut data = fresh();
    opened(&mut data);
    let err = approve(&mut data, &party(9), 100).unwrap_err();
    assert_eq!(err, EscrowError::NotAParty);
}

#[test]
fn rejects_approval_at_the_deadline() {
    let mut data = fresh();
    opened(&mut data);
    let err = approve(&mut data, &party(1), 900).unwrap_err();
    assert_eq!(err, EscrowError::TooLate);
}

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

#[test]
fn a_lone_lock_cannot_release_and_comes_back_only_after_the_deadline() {
    let mut data = fresh();
    opened(&mut data);
    approve(&mut data, &party(1), 100).unwrap();
    approve(&mut data, &party(2), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();

    let missing = release(&mut data, 100).unwrap_err();
    assert_eq!(missing, EscrowError::OtherSideMissing);

    let early_reclaim = reclaim(&mut data, &party(1), 100).unwrap_err();
    assert_eq!(early_reclaim, EscrowError::TooEarly);

    let still_missing = release(&mut data, 1_000).unwrap_err();
    assert_eq!(still_missing, EscrowError::OtherSideMissing);

    reclaim(&mut data, &party(1), 1_000).unwrap();
    let escrow = Escrow::load(&mut data).unwrap();
    assert_eq!(escrow.status(), Status::Reclaimed as u8);
    assert!(!escrow.a_sealed());
}

#[test]
fn release_swaps_only_after_both_sides_are_sealed() {
    let mut data = fresh();
    opened(&mut data);
    approve(&mut data, &party(1), 100).unwrap();
    approve(&mut data, &party(2), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(1), 100).unwrap();
    Escrow::load(&mut data).unwrap().seal_side(&party(2), 100).unwrap();
    release(&mut data, 100).unwrap();
    assert_eq!(Escrow::load(&mut data).unwrap().status(), Status::Exchanged as u8);
    assert_eq!(Escrow::load(&mut data).unwrap().tag(), ESCROW_TAG);
}

#[test]
fn fund_rejects_any_program_other_than_the_privacy_program_and_does_not_seal() {
    let mut data = fresh();
    opened(&mut data);
    approve(&mut data, &party(1), 100).unwrap();
    approve(&mut data, &party(2), 100).unwrap();

    let wrong = fund_side(&mut data, &party(1), 100, Some(&[9u8; 32])).unwrap_err();
    assert_eq!(wrong, EscrowError::WrongPrivacyProgram);

    let stranger = fund_side(&mut data, &party(9), 100, Some(&SPP_ID)).unwrap_err();
    assert_eq!(stranger, EscrowError::NotAParty);

    let closed = fund_side(&mut data, &party(1), 100, Some(&SPP_ID)).unwrap_err();
    assert_eq!(closed, EscrowError::PrivateLockNotWired);
    assert!(!Escrow::load(&mut data).unwrap().a_sealed());
}

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
        },
    )
    .unwrap_err();
    assert_eq!(err, EscrowError::SameParty);
}

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
            },
        )
        .unwrap_err();
        assert_eq!(err, EscrowError::CustomRingUnset);
        assert_eq!(custom[0], 0);
    }
}
