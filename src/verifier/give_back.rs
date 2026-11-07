use spr_program::{
    transaction_hash,
    verifier::{groth16_solana, public_hash, verify_groth16, Field, VerifyError},
    CompressedProof, PublicTransfer,
};

include!("give_back.vk.rs");

pub struct PublicInputs {
    pub escrow_0: u64,
    pub escrow_1: u64,
    pub escrow_2: u64,
    pub escrow_3: u64,
    pub start_at: u64,
    pub now: u64,
    pub other_sealed: u64,
}

impl PublicInputs {
    pub fn hash(&self, transaction_hash: &[u8; 32]) -> Result<[u8; 32], VerifyError> {
        public_hash(
            &[
                Field::Integer(u128::from(self.escrow_0)),
                Field::Integer(u128::from(self.escrow_1)),
                Field::Integer(u128::from(self.escrow_2)),
                Field::Integer(u128::from(self.escrow_3)),
                Field::Integer(u128::from(self.start_at)),
                Field::Integer(u128::from(self.now)),
                Field::Integer(u128::from(self.other_sealed)),
            ],
            transaction_hash,
        )
    }
}

pub struct Verifier<'a> {
    pub proof: &'a CompressedProof,
    pub public_inputs: PublicInputs,
    pub private_tx_hash: &'a [u8; 32],
    pub transfers: &'a [PublicTransfer],
}

impl Verifier<'_> {
    pub fn verify(&self) -> Result<(), VerifyError> {
        let transaction_hash = transaction_hash(self.private_tx_hash, self.transfers)
            .map_err(|_| VerifyError::PublicInputs)?;
        verify_groth16(
            self.proof,
            self.public_inputs.hash(&transaction_hash)?,
            &VERIFYINGKEY,
        )
    }
}
