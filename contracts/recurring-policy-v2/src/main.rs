#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash,
        load_input_since, load_script, load_script_hash, load_witness_args,
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
    clippy::useless_conversion,
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
    clippy::write_literal
)]
mod recurring_generated {
    include!("../../generated/recurring_v1.rs");
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
mod operator_generated {
    include!("../../generated/operator_v1.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

#[allow(dead_code)]
mod recurring {
    include!("../../shared/recurring.rs");
}

mod execution_witness {
    include!("../../shared/execution_witness.rs");
}

mod output_match {
    include!("../../shared/output_match.rs");
}

mod operator_selection {
    include!("../../shared/operator_selection.rs");
}

use error_codes::ScriptError;
use job_generated::JobDataV1;
use operator_generated::OperatorPayloadV1;
use recurring_generated::RecurringPayloadV1;

entry!(main);
default_alloc!();

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    let input_count = QueryIter::new(load_cell_capacity, Source::GroupInput).count();
    let output_count = QueryIter::new(load_cell_capacity, Source::GroupOutput).count();
    match (input_count, output_count) {
        (0, 1) => validate_creation(),
        (1, 1) => {
            if owner_top_up_requested()? {
                validate_owner_top_up()
            } else {
                validate_execution()
            }
        }
        (1, 0) => {
            if owner_exit_requested()? {
                Ok(())
            } else {
                validate_final_execution()
            }
        }
        _ => Err(ScriptError::InvalidApplicationState),
    }
}

fn validate_owner_top_up() -> Result<(), ScriptError> {
    let input_data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let output_data =
        load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let input = JobDataV1::from_slice(&input_data).map_err(|_| ScriptError::InvalidData)?;
    let output = JobDataV1::from_slice(&output_data).map_err(|_| ScriptError::InvalidData)?;
    if input.reward().as_slice() != output.reward().as_slice() {
        return Err(ScriptError::SuccessorInvariantMismatch);
    }
    Ok(())
}

fn owner_top_up_requested() -> Result<bool, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let request = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    Ok(matches!(
        execution_witness::parse_witness_operation(&request),
        Some(execution_witness::WitnessOperation::TopUp { .. })
    ))
}

fn owner_exit_requested() -> Result<bool, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let request = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    Ok(matches!(
        execution_witness::parse_witness_operation(&request),
        Some(
            execution_witness::WitnessOperation::Cancel
                | execution_witness::WitnessOperation::Recover
        )
    ))
}

fn validate_creation() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let witness =
        load_witness_args(0, Source::Input).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let payload = validate_intent(&job, &payload_bytes)?;
    if read_u64(job.sequence().as_slice()) != 0
        || read_u64(job.not_before().as_slice()) != read_u64(payload.first_not_before().as_slice())
        || read_u32(job.remaining_runs().as_slice()) != read_u32(payload.total_runs().as_slice())
    {
        return Err(ScriptError::InvalidData);
    }
    Ok(())
}

fn validate_execution() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let payload = validate_intent(&job, &payload_bytes)?;

    if read_u32(job.remaining_runs().as_slice()) <= 1 {
        return Err(ScriptError::InvalidApplicationState);
    }
    let committed_since = read_u64(job.not_before().as_slice());
    let actual_since =
        load_input_since(0, Source::GroupInput).map_err(|_| ScriptError::InvalidSince)?;
    if actual_since != committed_since && actual_since != read_u64(job.not_after().as_slice()) {
        return Err(ScriptError::InvalidSince);
    }

    let payout_index = validate_unique_payout(&payload)?;
    let request = load_execution_request()?;
    let controlled = &request.controlled_output_indices[..request.controlled_output_count];
    let successor_index = unique_policy_output_index()?;
    if controlled.len() != 3
        || !controlled.contains(&request.reward_output_index)
        || !controlled.contains(&payout_index)
        || !controlled.contains(&successor_index)
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    let successor_data =
        load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let successor = JobDataV1::from_slice(&successor_data).map_err(|_| ScriptError::InvalidData)?;
    let successor_sequence = read_u64(job.sequence().as_slice())
        .checked_add(1)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let expected_successor = recurring::scheduled_block_lower_bound(
        read_u64(payload.first_not_before().as_slice()),
        successor_sequence,
        read_u64(payload.interval_blocks().as_slice()),
    )
    .ok_or(ScriptError::ArithmeticOverflow)?;
    if read_u64(successor.sequence().as_slice()) != successor_sequence
        || read_u64(successor.not_before().as_slice()) != expected_successor
        || successor.trigger_params_hash().as_slice()
            != recurring::absolute_block_trigger_hash(expected_successor)
    {
        return Err(ScriptError::TriggerHashMismatch);
    }
    let expected_successor_capacity = load_cell_capacity(0, Source::GroupInput)
        .map_err(|_| ScriptError::CapacityNotConserved)?
        .checked_sub(read_u64(job.reward().as_slice()))
        .and_then(|value| value.checked_sub(read_u64(payload.amount().as_slice())))
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let successor_capacity = load_cell_capacity(0, Source::GroupOutput)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let expected_successor_budget = read_u64(job.remaining_budget().as_slice())
        .checked_sub(read_u64(job.reward().as_slice()))
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if successor_capacity != expected_successor_capacity
        || read_u64(successor.remaining_budget().as_slice()) != expected_successor_budget
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
}

fn unique_policy_output_index() -> Result<usize, ScriptError> {
    let policy_hash = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let mut found = None;
    for (index, type_hash) in QueryIter::new(load_cell_type_hash, Source::Output).enumerate() {
        if type_hash == Some(policy_hash) {
            if found.is_some() {
                return Err(ScriptError::SuccessorCountMismatch);
            }
            found = Some(index);
        }
    }
    found.ok_or(ScriptError::SuccessorCountMismatch)
}

fn validate_final_execution() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let payload = validate_intent(&job, &payload_bytes)?;
    if read_u32(job.remaining_runs().as_slice()) != 1 {
        return Err(ScriptError::InvalidApplicationState);
    }
    let committed_since = read_u64(job.not_before().as_slice());
    let actual_since =
        load_input_since(0, Source::GroupInput).map_err(|_| ScriptError::InvalidSince)?;
    if actual_since != committed_since && actual_since != read_u64(job.not_after().as_slice()) {
        return Err(ScriptError::InvalidSince);
    }

    let request = load_execution_request()?;
    let controlled = &request.controlled_output_indices[..request.controlled_output_count];
    if controlled.len() != 3 || controlled[0] != request.reward_output_index {
        return Err(ScriptError::CapacityNotConserved);
    }
    validate_plain_output(
        controlled[0],
        &request.executor_lock_hash,
        read_u64(job.reward().as_slice()),
    )?;
    let mut recipient_hash = [0_u8; 32];
    recipient_hash.copy_from_slice(payload.recipient_lock_hash().as_slice());
    validate_plain_output(
        controlled[1],
        &recipient_hash,
        read_u64(payload.amount().as_slice()),
    )?;

    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let residual = input_capacity
        .checked_sub(read_u64(job.reward().as_slice()))
        .and_then(|value| value.checked_sub(read_u64(payload.amount().as_slice())))
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let mut owner_hash = [0_u8; 32];
    owner_hash.copy_from_slice(payload.owner_lock_hash().as_slice());
    validate_plain_output(controlled[2], &owner_hash, residual)?;

    let job_lock_hash =
        load_cell_lock_hash(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    if QueryIter::new(load_cell_lock_hash, Source::Output)
        .any(|lock_hash| lock_hash == job_lock_hash)
    {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    Ok(())
}

fn validate_unique_payout(payload: &RecurringPayloadV1) -> Result<usize, ScriptError> {
    let mut recipient_hash = [0_u8; 32];
    recipient_hash.copy_from_slice(payload.recipient_lock_hash().as_slice());
    let amount = read_u64(payload.amount().as_slice());
    let mut payout_index = None;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == recipient_hash {
            let capacity = load_cell_capacity(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let type_hash = load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let data = load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            if output_match::matches_plain_output(
                &lock_hash,
                &recipient_hash,
                capacity,
                amount,
                type_hash.is_some(),
                data.is_empty(),
            ) {
                if payout_index.is_some() {
                    return Err(ScriptError::InvalidApplicationState);
                }
                payout_index = Some(index);
            }
        }
    }
    payout_index.ok_or(ScriptError::InvalidApplicationState)
}

fn validate_plain_output(
    index: usize,
    expected_lock_hash: &[u8; 32],
    expected_capacity: u64,
) -> Result<(), ScriptError> {
    let lock_hash = load_cell_lock_hash(index, Source::Output)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let capacity = load_cell_capacity(index, Source::Output)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let type_hash = load_cell_type_hash(index, Source::Output)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let data =
        load_cell_data(index, Source::Output).map_err(|_| ScriptError::InvalidApplicationState)?;
    if !output_match::matches_plain_output(
        &lock_hash,
        expected_lock_hash,
        capacity,
        expected_capacity,
        type_hash.is_some(),
        data.is_empty(),
    ) {
        return Err(ScriptError::InvalidApplicationState);
    }
    Ok(())
}

fn load_execution_request() -> Result<execution_witness::ExecutionRequest, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let bytes = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    match execution_witness::parse_witness_operation(&bytes) {
        Some(execution_witness::WitnessOperation::Execute(request)) => Ok(request),
        _ => Err(ScriptError::InvalidWitnessMode),
    }
}

fn validate_intent(
    job: &JobDataV1,
    payload_bytes: &[u8],
) -> Result<RecurringPayloadV1, ScriptError> {
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    if !script.args().raw_data().is_empty() {
        return Err(ScriptError::InvalidData);
    }
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if job.policy_script_hash().as_slice() != script_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }
    if read_u16(job.version().as_slice()) != 1
        || read_u16(job.flags().as_slice()) != 0
        || job.state().as_slice() != [0]
        || read_u16(job.trigger_kind().as_slice()) != 1
    {
        return Err(ScriptError::InvalidData);
    }
    let expected_payload = operator_selection::payload_hash(&script_hash, payload_bytes);
    if job.payload_hash().as_slice() != expected_payload {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let operator =
        OperatorPayloadV1::from_slice(payload_bytes).map_err(|_| ScriptError::InvalidData)?;
    if read_u16(operator.version().as_slice()) != 1
        || is_zero(operator.preferred_executor_lock_hash().as_slice())
    {
        return Err(ScriptError::InvalidData);
    }
    let application = operator.application_payload().raw_data();
    let payload =
        RecurringPayloadV1::from_slice(&application).map_err(|_| ScriptError::InvalidData)?;
    let amount = read_u64(payload.amount().as_slice());
    let interval = read_u64(payload.interval_blocks().as_slice());
    let first = read_u64(payload.first_not_before().as_slice());
    let total_runs = read_u32(payload.total_runs().as_slice());
    if read_u16(payload.version().as_slice()) != 1
        || is_zero(payload.owner_lock_hash().as_slice())
        || is_zero(payload.recipient_lock_hash().as_slice())
        || !recurring::valid_recurring_schedule(
            amount,
            interval,
            first,
            total_runs,
            payload.final_refund_kind().as_slice()[0],
        )
        || payload.owner_lock_hash().as_slice() != job.cancel_lock_hash().as_slice()
        || payload.reward().as_slice() != job.reward().as_slice()
    {
        return Err(ScriptError::InvalidData);
    }
    let sequence = read_u64(job.sequence().as_slice());
    let remaining_runs = read_u32(job.remaining_runs().as_slice());
    if sequence
        .checked_add(remaining_runs as u64)
        .ok_or(ScriptError::ArithmeticOverflow)?
        != total_runs as u64
    {
        return Err(ScriptError::InvalidData);
    }
    let expected_lower_bound = recurring::scheduled_block_lower_bound(first, sequence, interval)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let takeover = operator_selection::takeover_block(
        expected_lower_bound,
        read_u64(operator.takeover_delay_blocks().as_slice()),
    )
    .ok_or(ScriptError::ArithmeticOverflow)?;
    if read_u64(job.not_before().as_slice()) != expected_lower_bound
        || read_u64(job.not_after().as_slice()) != takeover
        || job.trigger_params_hash().as_slice()
            != recurring::absolute_block_trigger_hash(expected_lower_bound)
    {
        return Err(ScriptError::TriggerHashMismatch);
    }
    Ok(payload)
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().expect("Molecule Uint16"))
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("Molecule Uint32"))
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("Molecule Uint64"))
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
}
