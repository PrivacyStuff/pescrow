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
    /// The proof's public inputs are not this escrow account.
    ProofMismatch = 119,
    /// No verifying key has been built for this circuit. The invoke does not run.
    ProofKeyMissing = 120,
    /// The shielded-pool invoke failed. The seal was not written.
    InvokeFailed = 121,
    /// The circuit proof does not match this account.
    ProofRejected = 123,
    /// A sealed side has no output commitment to spend.
    MissingCommitment = 122,
}

impl EscrowError {
    /// Stable numeric code returned to the runtime. Do not renumber a shipped code.
    pub const fn code(self) -> u32 {
        self as u32
    }
}
