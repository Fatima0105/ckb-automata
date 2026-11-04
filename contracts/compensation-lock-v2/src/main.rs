#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash,
        load_cell_type_hash, load_script, load_witness_args,
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
    CLOSE_OPERATION, FALLBACK_CLAIM_OPERATION, OWNER_COMPLETE_OPERATION, PREFERRED_CLAIM_OPERATION,
    RECOVER_OPERATION, ROTATE_OPERATION, SWEEP_OPERATION,
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
    let script = load_script().map_err(|_| ScriptError::InvalidCompensationCell)?;
    let args = dao_harvest_v2::decode_compensation_lock_args(&script.args().raw_data())
        .ok_or(ScriptError::InvalidCompensationCell)?;
    if let Some((request, envelope)) = load_terminal_close_request() {
        return validate_terminal_close(&args, &request, &envelope);
    }
    let job_index = unique_job_input(&args.job_id, &args.policy_script_hash)?;
    let job_data =
        load_cell_data(job_index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::MissingBoundJob)?;
    let job_lock =
        load_cell_lock_hash(job_index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
    if job.job_id().as_slice() != args.job_id
        || job.cancel_lock_hash().as_slice() != args.owner_lock_hash
        || job.policy_script_hash().as_slice() != args.policy_script_hash
        || job.payload_hash().as_slice() != args.payload_hash
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
    let payload_hash = dao_harvest_v2::payload_hash(&args.policy_script_hash, &payload_bytes)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if payload_hash != args.payload_hash
        || request.payload_hash().as_slice() != payload_hash
        || payload.owner_lock_hash().as_slice() != args.owner_lock_hash
        || payload.payout_lock_hash().as_slice() != args.payout_lock_hash
    {
        return Err(ScriptError::CompensationBindingMismatch);
    }

    let operation = request.operation().as_slice()[0];
    if !matches!(
        operation,
        PREFERRED_CLAIM_OPERATION
            | FALLBACK_CLAIM_OPERATION
            | OWNER_COMPLETE_OPERATION
            | SWEEP_OPERATION
            | CLOSE_OPERATION
            | ROTATE_OPERATION
            | RECOVER_OPERATION
    ) {
        return Err(ScriptError::InvalidWitnessMode);
    }
    let declared = read_u32(request.compensation_input_index().as_slice()) as usize;
    let grouped = load_cell_lock_hash(0, Source::GroupInput)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    let declared_hash = load_cell_lock_hash(declared, Source::Input)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    if declared_hash != grouped {
        return Err(ScriptError::OperationLayoutMismatch);
    }

    let owner_operation = matches!(
        operation,
        OWNER_COMPLETE_OPERATION
            | SWEEP_OPERATION
            | CLOSE_OPERATION
            | ROTATE_OPERATION
            | RECOVER_OPERATION
    );
    if owner_operation
        && !QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|hash| hash == args.owner_lock_hash && hash != grouped && hash != job_lock)
    {
        return Err(ScriptError::MissingOwnerAuthorization);
    }
    validate_successor(operation, &request, &envelope, &args, &grouped)
}

fn validate_successor(
    operation: u8,
    request: &DaoHarvestWitnessV2,
    envelope: &DaoHarvestEnvelopeV2,
    args: &dao_harvest_v2::CompensationLockArgsV2,
    input_lock_hash: &[u8; 32],
) -> Result<(), ScriptError> {
    let output_index = read_u32(request.compensation_output_index().as_slice());
    if matches!(operation, CLOSE_OPERATION | RECOVER_OPERATION) {
        if output_index != dao_harvest_v2::ABSENT_INDEX
            || QueryIter::new(load_cell_lock_hash, Source::Output)
                .any(|hash| hash == *input_lock_hash)
        {
            return Err(ScriptError::SuccessorCountMismatch);
        }
        return Ok(());
    }
    if output_index == dao_harvest_v2::ABSENT_INDEX {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    let output_index = output_index as usize;
    let output = load_cell_lock(output_index, Source::Output)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    let output_args = dao_harvest_v2::decode_compensation_lock_args(&output.args().raw_data())
        .ok_or(ScriptError::InvalidCompensationCell)?;
    let terminal = matches!(
        operation,
        PREFERRED_CLAIM_OPERATION | FALLBACK_CLAIM_OPERATION | OWNER_COMPLETE_OPERATION
    ) && read_u32(request.job_output_index().as_slice())
        == dao_harvest_v2::ABSENT_INDEX;
    if output.code_hash()
        != load_script()
            .map_err(|_| ScriptError::InvalidCompensationCell)?
            .code_hash()
        || output.hash_type().as_slice() != [2]
        || output_args.job_id != if terminal { [0_u8; 32] } else { args.job_id }
        || output_args.owner_lock_hash != args.owner_lock_hash
        || output_args.payout_lock_hash != args.payout_lock_hash
        || output_args.policy_script_hash != args.policy_script_hash
    {
        return Err(ScriptError::CompensationBindingMismatch);
    }
    let expected_payload = if operation == ROTATE_OPERATION {
        let successor = envelope.successor_payload().raw_data();
        dao_harvest_v2::payload_hash(&args.policy_script_hash, &successor)
            .ok_or(ScriptError::ArithmeticOverflow)?
    } else {
        args.payload_hash
    };
    if output_args.payload_hash != expected_payload {
        return Err(ScriptError::CompensationBindingMismatch);
    }
    let output_data = load_cell_data(output_index, Source::Output)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    if !output_data.is_empty() {
        return Err(ScriptError::InvalidCompensationCell);
    }
    Ok(())
}

fn load_terminal_close_request() -> Option<(DaoHarvestWitnessV2, DaoHarvestEnvelopeV2)> {
    let witness = load_witness_args(0, Source::GroupInput).ok()?;
    let request =
        DaoHarvestWitnessV2::from_slice(&witness.input_type().to_opt()?.raw_data()).ok()?;
    if request.operation().as_slice() != [CLOSE_OPERATION] {
        return None;
    }
    let envelope =
        DaoHarvestEnvelopeV2::from_slice(&witness.output_type().to_opt()?.raw_data()).ok()?;
    Some((request, envelope))
}

fn validate_terminal_close(
    args: &dao_harvest_v2::CompensationLockArgsV2,
    request: &DaoHarvestWitnessV2,
    envelope: &DaoHarvestEnvelopeV2,
) -> Result<(), ScriptError> {
    let absent = dao_harvest_v2::ABSENT_INDEX;
    if read_u16(request.version().as_slice()) != dao_harvest_v2::DAO_HARVEST_V2_VERSION
        || request.flags().as_slice() != [0]
        || request.prepare_credit_hash().as_slice() != [0_u8; 32]
        || QueryIter::new(load_cell_lock_hash, Source::GroupInput).count() != 1
        || read_u32(request.job_input_index().as_slice()) != absent
        || read_u32(request.vault_input_index().as_slice()) != absent
        || read_u32(request.compensation_input_index().as_slice()) == absent
        || read_u32(request.identity_input_index().as_slice()) == absent
        || read_u32(request.prepare_accumulator_input_index().as_slice()) != absent
        || read_u32(request.claim_accumulator_input_index().as_slice()) != absent
        || read_u32(request.job_output_index().as_slice()) != absent
        || read_u32(request.vault_output_index().as_slice()) != absent
        || read_u32(request.compensation_output_index().as_slice()) != absent
        || read_u32(request.prepare_accumulator_output_index().as_slice()) != absent
        || read_u32(request.claim_accumulator_output_index().as_slice()) != absent
    {
        return Err(ScriptError::OperationLayoutMismatch);
    }
    let payload_bytes = envelope.payload().raw_data();
    let payload =
        DaoHarvestPayloadV2::from_slice(&payload_bytes).map_err(|_| ScriptError::InvalidData)?;
    let computed = dao_harvest_v2::payload_hash(&args.policy_script_hash, &payload_bytes)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if computed != args.payload_hash
        || request.payload_hash().as_slice() != computed
        || payload.owner_lock_hash().as_slice() != args.owner_lock_hash
        || payload.payout_lock_hash().as_slice() != args.payout_lock_hash
        || !envelope.prepare_credit().raw_data().is_empty()
        || !envelope.operator_proof().raw_data().is_empty()
        || !envelope.successor_payload().raw_data().is_empty()
        || args.job_id != [0_u8; 32]
        || !load_cell_data(0, Source::GroupInput)
            .map_err(|_| ScriptError::InvalidCompensationCell)?
            .is_empty()
    {
        return Err(ScriptError::CompensationBindingMismatch);
    }
    let grouped = load_cell_lock_hash(0, Source::GroupInput)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    let declared = load_cell_lock_hash(
        read_u32(request.compensation_input_index().as_slice()) as usize,
        Source::Input,
    )
    .map_err(|_| ScriptError::OperationLayoutMismatch)?;
    let owner = load_cell_lock_hash(
        read_u32(request.identity_input_index().as_slice()) as usize,
        Source::Input,
    )
    .map_err(|_| ScriptError::MissingOwnerAuthorization)?;
    if declared != grouped || owner != args.owner_lock_hash {
        return Err(ScriptError::MissingOwnerAuthorization);
    }
    if QueryIter::new(load_cell_lock_hash, Source::Output).any(|hash| hash == grouped) {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    let input_capacity = load_cell_capacity(0, Source::GroupInput)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    let mut payouts = 0;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == args.payout_lock_hash
            && load_cell_capacity(index, Source::Output).map_err(|_| ScriptError::PayoutMismatch)?
                == input_capacity
            && load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::PayoutMismatch)?
                .is_none()
            && load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::PayoutMismatch)?
                .is_empty()
        {
            payouts += 1;
        }
    }
    if payouts == 1 {
        Ok(())
    } else {
        Err(ScriptError::PayoutMismatch)
    }
}

fn unique_job_input(job_id: &[u8; 32], policy_hash: &[u8; 32]) -> Result<usize, ScriptError> {
    let mut found = None;
    for (index, type_hash) in QueryIter::new(load_cell_type_hash, Source::Input).enumerate() {
        if type_hash == Some(*policy_hash) {
            let data =
                load_cell_data(index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
            if JobDataV1::from_slice(&data).is_ok_and(|job| job.job_id().as_slice() == job_id) {
                if found.is_some() {
                    return Err(ScriptError::DuplicateJob);
                }
                found = Some(index);
            }
        }
    }
    found.ok_or(ScriptError::MissingBoundJob)
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap_or_default())
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().unwrap_or_default())
}
