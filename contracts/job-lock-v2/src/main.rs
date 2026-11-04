#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_input,
        load_script_hash, load_witness_args,
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

#[allow(dead_code)]
mod dao_harvest_v2_validation {
    include!("../../shared/dao_harvest_v2_validation.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

use dao_harvest_v2::{
    CLOSE_OPERATION, FALLBACK_CLAIM_OPERATION, FALLBACK_PREPARE_OPERATION,
    OWNER_COMPLETE_OPERATION, PREFERRED_CLAIM_OPERATION, PREFERRED_PREPARE_OPERATION,
    RECOVER_OPERATION, ROTATE_OPERATION, SWEEP_OPERATION,
};
use error_codes::ScriptError;
use harvest_generated::{
    DaoHarvestEnvelopeV2, DaoHarvestPayloadV2, DaoHarvestProgressV2, DaoHarvestWitnessV2,
};
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
    if QueryIter::new(load_cell_data, Source::GroupInput).count() != 1 {
        return Err(ScriptError::DuplicateJob);
    }
    let job_data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::InvalidData)?;
    validate_job_container(&job)?;

    let args =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let witness_bytes = args
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    let envelope_bytes = args
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let witness = DaoHarvestWitnessV2::from_slice(&witness_bytes)
        .map_err(|_| ScriptError::InvalidWitnessMode)?;
    let envelope = DaoHarvestEnvelopeV2::from_slice(&envelope_bytes)
        .map_err(|_| ScriptError::PayloadHashMismatch)?;
    validate_witness(&witness)?;
    validate_indexed_job_input(&witness)?;

    let payload_bytes = envelope.payload().raw_data();
    let progress_bytes = envelope.progress().raw_data();
    let payload =
        DaoHarvestPayloadV2::from_slice(&payload_bytes).map_err(|_| ScriptError::InvalidData)?;
    let _progress =
        DaoHarvestProgressV2::from_slice(&progress_bytes).map_err(|_| ScriptError::InvalidData)?;
    validate_commitments(&job, &witness, &payload, &payload_bytes, &progress_bytes)?;
    validate_identity(&witness, &payload)?;
    validate_successor_shape(&job, &witness)?;
    Ok(())
}

fn validate_job_container(job: &JobDataV1) -> Result<(), ScriptError> {
    if read_u16(job.version().as_slice()) != 1 {
        return Err(ScriptError::UnsupportedVersion);
    }
    if read_u16(job.flags().as_slice()) != 0 {
        return Err(ScriptError::ReservedFlags);
    }
    if job.state().as_slice() != [0]
        || read_u16(job.trigger_kind().as_slice()) != 2
        || read_u64(job.reward().as_slice()) != 0
        || read_u64(job.remaining_budget().as_slice()) != 0
        || read_u32(job.remaining_runs().as_slice()) == 0
    {
        return Err(ScriptError::PolicyVersionMismatch);
    }
    Ok(())
}

fn validate_witness(witness: &DaoHarvestWitnessV2) -> Result<(), ScriptError> {
    let operation = witness.operation().as_slice()[0];
    let indices = witness_indices(witness);
    if read_u16(witness.version().as_slice()) != dao_harvest_v2::DAO_HARVEST_V2_VERSION
        || witness.flags().as_slice() != [0]
        || !dao_harvest_v2_validation::validate_witness_layout(operation, &indices)
    {
        return Err(ScriptError::OperationLayoutMismatch);
    }
    Ok(())
}

fn validate_indexed_job_input(witness: &DaoHarvestWitnessV2) -> Result<(), ScriptError> {
    let index = read_u32(witness.job_input_index().as_slice()) as usize;
    let indexed = load_input(index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
    let grouped = load_input(0, Source::GroupInput).map_err(|_| ScriptError::MissingBoundJob)?;
    if indexed.as_slice() != grouped.as_slice() {
        return Err(ScriptError::MissingBoundJob);
    }
    Ok(())
}

fn validate_commitments(
    job: &JobDataV1,
    witness: &DaoHarvestWitnessV2,
    payload: &DaoHarvestPayloadV2,
    payload_bytes: &[u8],
    progress_bytes: &[u8],
) -> Result<(), ScriptError> {
    if read_u16(payload.version().as_slice()) != dao_harvest_v2::DAO_HARVEST_V2_VERSION {
        return Err(ScriptError::PolicyVersionMismatch);
    }
    let policy_hash = load_cell_type_hash(0, Source::GroupInput)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if policy_hash.as_slice() != job.policy_script_hash().as_slice() {
        return Err(ScriptError::PolicyHashMismatch);
    }
    let payload_hash = dao_harvest_v2::payload_hash(&policy_hash, payload_bytes)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let progress_hash =
        dao_harvest_v2::progress_hash(progress_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    if payload_hash.as_slice() != job.payload_hash().as_slice()
        || payload_hash.as_slice() != witness.payload_hash().as_slice()
        || progress_hash.as_slice() != job.trigger_params_hash().as_slice()
        || progress_hash.as_slice() != witness.progress_hash().as_slice()
    {
        return Err(ScriptError::PayloadHashMismatch);
    }
    Ok(())
}

fn validate_identity(
    witness: &DaoHarvestWitnessV2,
    payload: &DaoHarvestPayloadV2,
) -> Result<(), ScriptError> {
    let operation = witness.operation().as_slice()[0];
    let identity_index = read_u32(witness.identity_input_index().as_slice()) as usize;
    let identity = load_cell_lock_hash(identity_index, Source::Input)
        .map_err(|_| ScriptError::UnauthorizedExecutor)?;
    let owner = payload.owner_lock_hash();
    let preferred = payload.preferred_prepare_operator_lock_hash();
    let expected = match operation {
        OWNER_COMPLETE_OPERATION
        | SWEEP_OPERATION
        | CLOSE_OPERATION
        | ROTATE_OPERATION
        | RECOVER_OPERATION => owner.as_slice(),
        PREFERRED_PREPARE_OPERATION => preferred.as_slice(),
        FALLBACK_PREPARE_OPERATION | PREFERRED_CLAIM_OPERATION | FALLBACK_CLAIM_OPERATION => {
            return Ok(());
        }
        _ => return Err(ScriptError::InvalidWitnessMode),
    };
    if identity.as_slice() != expected {
        return Err(if operation == PREFERRED_PREPARE_OPERATION {
            ScriptError::UnauthorizedPreferredOperator
        } else {
            ScriptError::MissingOwnerAuthorization
        });
    }
    Ok(())
}

fn validate_successor_shape(
    job: &JobDataV1,
    witness: &DaoHarvestWitnessV2,
) -> Result<(), ScriptError> {
    let operation = witness.operation().as_slice()[0];
    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    let input_count = QueryIter::new(load_cell_lock_hash, Source::Input)
        .filter(|hash| *hash == job_lock_hash)
        .count();
    let output_count = QueryIter::new(load_cell_lock_hash, Source::Output)
        .filter(|hash| *hash == job_lock_hash)
        .count();
    if input_count != 1 || output_count > 1 {
        return Err(ScriptError::DuplicateJob);
    }
    let output_index = read_u32(witness.job_output_index().as_slice());
    let output_required = matches!(
        operation,
        PREFERRED_PREPARE_OPERATION
            | FALLBACK_PREPARE_OPERATION
            | SWEEP_OPERATION
            | ROTATE_OPERATION
    );
    let output_optional = matches!(
        operation,
        PREFERRED_CLAIM_OPERATION | FALLBACK_CLAIM_OPERATION | OWNER_COMPLETE_OPERATION
    );
    let output_present = output_index != dao_harvest_v2::ABSENT_INDEX;
    if (output_required && !output_present)
        || (!output_required && !output_optional && output_present)
    {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    if output_index == dao_harvest_v2::ABSENT_INDEX {
        if output_count != 0 {
            return Err(ScriptError::SuccessorCountMismatch);
        }
        return Ok(());
    }
    let output_index = output_index as usize;
    let output_lock = load_cell_lock_hash(output_index, Source::Output)
        .map_err(|_| ScriptError::SuccessorCountMismatch)?;
    let output_policy = load_cell_type_hash(output_index, Source::Output)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if output_count != 1
        || output_lock != job_lock_hash
        || output_policy.as_slice() != job.policy_script_hash().as_slice()
    {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    Ok(())
}

fn witness_indices(witness: &DaoHarvestWitnessV2) -> [u32; 11] {
    [
        read_u32(witness.job_input_index().as_slice()),
        read_u32(witness.vault_input_index().as_slice()),
        read_u32(witness.compensation_input_index().as_slice()),
        read_u32(witness.identity_input_index().as_slice()),
        read_u32(witness.prepare_accumulator_input_index().as_slice()),
        read_u32(witness.claim_accumulator_input_index().as_slice()),
        read_u32(witness.job_output_index().as_slice()),
        read_u32(witness.vault_output_index().as_slice()),
        read_u32(witness.compensation_output_index().as_slice()),
        read_u32(witness.prepare_accumulator_output_index().as_slice()),
        read_u32(witness.claim_accumulator_output_index().as_slice()),
    ]
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().unwrap_or_default())
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap_or_default())
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().unwrap_or_default())
}
