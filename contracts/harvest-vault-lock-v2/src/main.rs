#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_script,
        load_witness_args,
    },
};
use molecule::prelude::Entity;

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
mod job_generated {
    include!("../../generated/job_v1.rs");
}

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::useless_conversion,
    clippy::write_literal
)]
mod harvest_generated {
    include!("../../generated/dao_harvest_v2.rs");
}

#[allow(dead_code)]
mod dao_harvest_v2 {
    include!("../../shared/dao_harvest_v2.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

use dao_harvest_v2::{
    FALLBACK_CLAIM_OPERATION, FALLBACK_PREPARE_OPERATION, OWNER_COMPLETE_OPERATION,
    PREFERRED_CLAIM_OPERATION, PREFERRED_PREPARE_OPERATION, RECOVER_OPERATION,
};
use error_codes::ScriptError;
use harvest_generated::{DaoHarvestEnvelopeV2, DaoHarvestPayloadV2, DaoHarvestWitnessV2};
use job_generated::JobDataV1;

entry!(main);
default_alloc!();

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    let script = load_script().map_err(|_| ScriptError::InvalidDaoCell)?;
    let args = dao_harvest_v2::decode_harvest_vault_lock_args(&script.args().raw_data())
        .ok_or(ScriptError::InvalidDaoCell)?;
    if args.job_lock_hash == [0_u8; 32] {
        if QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|hash| hash == args.owner_lock_hash)
        {
            return Ok(());
        }
        return Err(ScriptError::MissingOwnerAuthorization);
    }
    let job_index = unique_job_input(&args.job_lock_hash)?;
    let job_data =
        load_cell_data(job_index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::MissingBoundJob)?;
    let policy = load_cell_type_hash(job_index, Source::Input)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if job.job_id().as_slice() != args.job_id
        || job.cancel_lock_hash().as_slice() != args.owner_lock_hash
        || policy != args.policy_script_hash
        || job.policy_script_hash().as_slice() != args.policy_script_hash
    {
        return Err(ScriptError::CompensationBindingMismatch);
    }

    let witness =
        load_witness_args(job_index, Source::Input).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let request = DaoHarvestWitnessV2::from_slice(
        &witness
            .input_type()
            .to_opt()
            .ok_or(ScriptError::InvalidWitnessMode)?
            .raw_data(),
    )
    .map_err(|_| ScriptError::InvalidWitnessMode)?;
    let envelope = DaoHarvestEnvelopeV2::from_slice(
        &witness
            .output_type()
            .to_opt()
            .ok_or(ScriptError::PayloadHashMismatch)?
            .raw_data(),
    )
    .map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = envelope.payload().raw_data();
    let payload =
        DaoHarvestPayloadV2::from_slice(&payload_bytes).map_err(|_| ScriptError::InvalidData)?;
    let payload_hash = dao_harvest_v2::payload_hash(&policy, &payload_bytes)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let terms_hash = dao_harvest_v2::vault_terms_hash(&[
        payload.version().as_slice(),
        payload.owner_lock_hash().as_slice(),
        payload.payout_lock_hash().as_slice(),
        payload.dao_type_hash().as_slice(),
        payload.principal_capacity().as_slice(),
        payload.prepare_service_fee().as_slice(),
        payload.claim_service_fee().as_slice(),
        payload.compensation_seed_capacity().as_slice(),
        payload.prepare_buffer_epochs().as_slice(),
        payload.takeover_delay_epochs().as_slice(),
        payload.confirmation_margin_epochs().as_slice(),
        payload.total_cycles().as_slice(),
        payload.end_epoch_since().as_slice(),
    ])
    .ok_or(ScriptError::ArithmeticOverflow)?;
    if job.payload_hash().as_slice() != payload_hash
        || request.payload_hash().as_slice() != payload_hash
        || args.immutable_terms_hash != terms_hash
        || payload.owner_lock_hash().as_slice() != args.owner_lock_hash
    {
        return Err(ScriptError::CompensationBindingMismatch);
    }

    let operation = request.operation().as_slice()[0];
    if !matches!(
        operation,
        PREFERRED_PREPARE_OPERATION
            | FALLBACK_PREPARE_OPERATION
            | PREFERRED_CLAIM_OPERATION
            | FALLBACK_CLAIM_OPERATION
            | OWNER_COMPLETE_OPERATION
            | RECOVER_OPERATION
    ) {
        return Err(ScriptError::InvalidWitnessMode);
    }
    let declared_vault = read_u32(request.vault_input_index().as_slice()) as usize;
    let grouped =
        load_cell_lock_hash(0, Source::GroupInput).map_err(|_| ScriptError::InvalidDaoCell)?;
    let declared = load_cell_lock_hash(declared_vault, Source::Input)
        .map_err(|_| ScriptError::InvalidDaoCell)?;
    if declared != grouped {
        return Err(ScriptError::OperationLayoutMismatch);
    }
    if matches!(operation, OWNER_COMPLETE_OPERATION | RECOVER_OPERATION)
        && !QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|hash| hash == args.owner_lock_hash && hash != grouped)
    {
        return Err(ScriptError::MissingOwnerAuthorization);
    }
    Ok(())
}

fn unique_job_input(expected: &[u8; 32]) -> Result<usize, ScriptError> {
    let mut found = None;
    for (index, hash) in QueryIter::new(load_cell_lock_hash, Source::Input).enumerate() {
        if hash == *expected {
            if found.is_some() {
                return Err(ScriptError::DuplicateJob);
            }
            found = Some(index);
        }
    }
    found.ok_or(ScriptError::MissingBoundJob)
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap_or_default())
}
