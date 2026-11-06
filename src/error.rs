/// Failures a caller can hit. Custom codes start at 100 so they do not collide
/// with the runtime's `ProgramError` discriminants when mapped at the entrypoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum EscrowError {
    DeadlineAfterRelease = 100,
    SameParty = 101,
    NotAParty = 102,
    AlreadyInitialized = 103,
    NotInitialized = 104,
    Frozen = 105,
    TooLate = 106,
    NotBothApproved = 107,
    SideAlreadySealed = 108,
    SideNotSealed = 109,
    OtherSideSealed = 110,
    OtherSideMissing = 111,
    TooEarly = 112,
    AlreadyFinished = 113,
    WrongPrivacyProgram = 114,
    PrivateLockNotWired = 115,
    BadAccount = 116,
    /// The permissionless ring prints both wallets. Choosing private wallets there would be a false hide.
    PermissionlessPublishesWallets = 117,
    /// A custom ring is a real option. Create waits until that ring's program id is set.
    CustomRingUnset = 118,
}

impl EscrowError {
    pub const fn code(self) -> u32 {
        self as u32
    }
}
