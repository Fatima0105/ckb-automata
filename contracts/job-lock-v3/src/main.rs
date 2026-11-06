#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash,
        load_cell_occupied_capacity, load_cell_type_hash, load_input_since, load_script_hash,
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
    clippy::useless_conversion,
    clippy::write_literal
)]
mod generated {
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
mod operator_generated {
    include!("../../generated/operator_v1.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

mod trigger {
    include!("../../shared/trigger.rs");
}

mod execution_witness {
    include!("../../shared/execution_witness.rs");
}

mod operator_selection {
    include!("../../shared/operator_selection.rs");
}

use error_codes::ScriptError;
use generated::JobDataV1;
use operator_generated::OperatorPayloadV1;

entry!(main);
default_alloc!();

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    match load_operation()? {
        execution_witness::WitnessOperation::Execute(request) => validate_execution(
            request.reward_output_index,
            request.executor_lock_hash,
            &request.controlled_output_indices[..request.controlled_output_count],
        ),
        execution_witness::WitnessOperation::Cancel => validate_cancellation(),
        execution_witness::WitnessOperation::Recover => validate_recovery(),
        execution_witness::WitnessOperation::TopUp {
            successor_output_index,
        } => validate_top_up(successor_output_index),
        execution_witness::WitnessOperation::RotateExecutorSet {
            successor_output_index,
        } => validate_executor_rotation(successor_output_index),
    }
}

fn load_operation() -> Result<execution_witness::WitnessOperation, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let input_type = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?;
    let bytes = input_type.raw_data();
    execution_witness::parse_witness_operation(&bytes).ok_or(ScriptError::InvalidWitnessMode)
}

fn load_job() -> Result<JobDataV1, ScriptError> {
    if QueryIter::new(load_cell_capacity, Source::GroupInput).count() != 1 {
        return Err(ScriptError::InvalidData);
    }
    let data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)
}

fn validate_cancellation() -> Result<(), ScriptError> {
    let job = load_job()?;
    validate_supported_live_job(&job)?;
    validate_policy_commitment(&job)?;
    let cancel_lock_hash = validate_owner_authorization(&job)?;
    validate_no_successor()?;
    validate_refund(cancel_lock_hash)
}

fn validate_recovery() -> Result<(), ScriptError> {
    let job = load_job()?;
    let cancel_lock_hash = validate_owner_authorization(&job)?;
    validate_no_successor()?;
    validate_refund(cancel_lock_hash)
}

fn validate_top_up(successor_output_index: usize) -> Result<(), ScriptError> {
    let job = load_job()?;
    validate_supported_live_job(&job)?;
    validate_policy_commitment(&job)?;
    validate_owner_authorization(&job)?;

    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    let successor_count = QueryIter::new(load_cell_lock_hash, Source::Output)
        .filter(|lock_hash| *lock_hash == job_lock_hash)
        .count();
    let successor_lock = load_cell_lock_hash(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::SuccessorCountMismatch)?;
    if successor_count != 1 || successor_lock != job_lock_hash {
        return Err(ScriptError::SuccessorCountMismatch);
    }

    let mut policy_hash = [0_u8; 32];
    policy_hash.copy_from_slice(job.policy_script_hash().as_slice());
    let successor_policy = load_cell_type_hash(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if successor_policy != policy_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }

    let successor_data = load_cell_data(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::InvalidData)?;
    let successor = JobDataV1::from_slice(&successor_data).map_err(|_| ScriptError::InvalidData)?;
    for (input, output) in [
        (job.version().as_slice(), successor.version().as_slice()),
        (job.flags().as_slice(), successor.flags().as_slice()),
        (job.job_id().as_slice(), successor.job_id().as_slice()),
        (job.sequence().as_slice(), successor.sequence().as_slice()),
        (job.state().as_slice(), successor.state().as_slice()),
        (
            job.trigger_kind().as_slice(),
            successor.trigger_kind().as_slice(),
        ),
        (
            job.trigger_params_hash().as_slice(),
            successor.trigger_params_hash().as_slice(),
        ),
        (
            job.policy_script_hash().as_slice(),
            successor.policy_script_hash().as_slice(),
        ),
        (
            job.payload_hash().as_slice(),
            successor.payload_hash().as_slice(),
        ),
        (
            job.not_before().as_slice(),
            successor.not_before().as_slice(),
        ),
        (job.not_after().as_slice(), successor.not_after().as_slice()),
        (
            job.remaining_runs().as_slice(),
            successor.remaining_runs().as_slice(),
        ),
        (
            job.cancel_lock_hash().as_slice(),
            successor.cancel_lock_hash().as_slice(),
        ),
    ] {
        if input != output {
            return Err(ScriptError::SuccessorInvariantMismatch);
        }
    }

    let input_reward = read_u64(job.reward().as_slice());
    let successor_reward = read_u64(successor.reward().as_slice());
    let input_budget = read_u64(job.remaining_budget().as_slice());
    let successor_budget = read_u64(successor.remaining_budget().as_slice());
    if successor_reward < input_reward
        || successor_budget < input_budget
        || (successor_reward == input_reward && successor_budget == input_budget)
    {
        return Err(ScriptError::SuccessorInvariantMismatch);
    }

    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let successor_capacity = load_cell_capacity(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let successor_occupied = load_cell_occupied_capacity(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let successor_spendable = successor_capacity
        .checked_sub(successor_occupied)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if successor_capacity < input_capacity
        || successor_budget > successor_spendable
        || successor_reward > successor_budget
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
}

fn validate_executor_rotation(successor_output_index: usize) -> Result<(), ScriptError> {
    let job = load_job()?;
    validate_supported_live_job(&job)?;
    validate_policy_commitment(&job)?;
    validate_owner_authorization(&job)?;

    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    let successor_count = QueryIter::new(load_cell_lock_hash, Source::Output)
        .filter(|lock_hash| *lock_hash == job_lock_hash)
        .count();
    let successor_lock = load_cell_lock_hash(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::SuccessorCountMismatch)?;
    if successor_count != 1 || successor_lock != job_lock_hash {
        return Err(ScriptError::SuccessorCountMismatch);
    }

    let successor_policy = load_cell_type_hash(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if successor_policy != job.policy_script_hash().as_slice() {
        return Err(ScriptError::PolicyHashMismatch);
    }
    let successor_data = load_cell_data(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::InvalidData)?;
    let successor = JobDataV1::from_slice(&successor_data).map_err(|_| ScriptError::InvalidData)?;
    for (input, output) in [
        (job.version().as_slice(), successor.version().as_slice()),
        (job.flags().as_slice(), successor.flags().as_slice()),
        (job.job_id().as_slice(), successor.job_id().as_slice()),
        (job.sequence().as_slice(), successor.sequence().as_slice()),
        (job.state().as_slice(), successor.state().as_slice()),
        (
            job.trigger_kind().as_slice(),
            successor.trigger_kind().as_slice(),
        ),
        (
            job.trigger_params_hash().as_slice(),
            successor.trigger_params_hash().as_slice(),
        ),
        (
            job.policy_script_hash().as_slice(),
            successor.policy_script_hash().as_slice(),
        ),
        (job.reward().as_slice(), successor.reward().as_slice()),
        (
            job.remaining_budget().as_slice(),
            successor.remaining_budget().as_slice(),
        ),
        (
            job.not_before().as_slice(),
            successor.not_before().as_slice(),
        ),
        (job.not_after().as_slice(), successor.not_after().as_slice()),
        (
            job.remaining_runs().as_slice(),
            successor.remaining_runs().as_slice(),
        ),
        (
            job.cancel_lock_hash().as_slice(),
            successor.cancel_lock_hash().as_slice(),
        ),
    ] {
        if input != output {
            return Err(ScriptError::SuccessorInvariantMismatch);
        }
    }
    if job.payload_hash().as_slice() == successor.payload_hash().as_slice() {
        return Err(ScriptError::InvalidExecutorSet);
    }

    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let successor_capacity = load_cell_capacity(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let successor_occupied = load_cell_occupied_capacity(successor_output_index, Source::Output)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let successor_budget = read_u64(successor.remaining_budget().as_slice());
    if successor_capacity != input_capacity
        || successor_budget > successor_capacity.saturating_sub(successor_occupied)
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
}

fn validate_no_successor() -> Result<(), ScriptError> {
    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if QueryIter::new(load_cell_lock_hash, Source::Output)
        .any(|lock_hash| lock_hash == job_lock_hash)
    {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    Ok(())
}

fn validate_owner_authorization(job: &JobDataV1) -> Result<[u8; 32], ScriptError> {
    let mut cancel_lock_hash = [0_u8; 32];
    cancel_lock_hash.copy_from_slice(job.cancel_lock_hash().as_slice());

    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if cancel_lock_hash == job_lock_hash
        || !QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|lock_hash| lock_hash == cancel_lock_hash && lock_hash != job_lock_hash)
    {
        return Err(ScriptError::MissingOwnerAuthorization);
    }

    Ok(cancel_lock_hash)
}

fn validate_supported_live_job(job: &JobDataV1) -> Result<(), ScriptError> {
    if read_u16(job.version().as_slice()) != 1 {
        return Err(ScriptError::UnsupportedVersion);
    }
    if read_u16(job.flags().as_slice()) != 0 {
        return Err(ScriptError::ReservedFlags);
    }
    if job.state().as_slice() != [0] {
        return Err(ScriptError::InvalidState);
    }
    if !(1..=6).contains(&read_u16(job.trigger_kind().as_slice())) {
        return Err(ScriptError::UnsupportedTrigger);
    }
    if read_u32(job.remaining_runs().as_slice()) == 0 {
        return Err(ScriptError::InvalidData);
    }
    Ok(())
}

fn validate_policy_commitment(job: &JobDataV1) -> Result<(), ScriptError> {
    let mut committed_policy_hash = [0_u8; 32];
    committed_policy_hash.copy_from_slice(job.policy_script_hash().as_slice());
    let actual_policy_hash = load_cell_type_hash(0, Source::GroupInput)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if actual_policy_hash != committed_policy_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }
    Ok(())
}

fn validate_execution(
    reward_output_index: usize,
    executor_lock_hash: [u8; 32],
    controlled_output_indices: &[usize],
) -> Result<(), ScriptError> {
    let job = load_job()?;
    validate_supported_live_job(&job)?;
    let trigger_kind = read_u16(job.trigger_kind().as_slice());
    let committed_since = read_u64(job.not_before().as_slice());
    let takeover_since = read_u64(job.not_after().as_slice());
    let actual_since =
        load_input_since(0, Source::GroupInput).map_err(|_| ScriptError::InvalidSince)?;
    let operator = load_operator_payload(&job)?;
    let preferred_entity = operator.preferred_executor_lock_hash();
    let preferred = preferred_entity.as_slice();
    let delay = read_u64(operator.takeover_delay_blocks().as_slice());
    if trigger_kind != 1
        || !operator_selection::execution_since_allowed(
            committed_since,
            takeover_since,
            actual_since,
            preferred,
            executor_lock_hash.as_slice(),
            delay,
        )
        || (actual_since == takeover_since
            && !trigger::validate_trigger_since(trigger_kind, takeover_since, actual_since))
    {
        return Err(ScriptError::InvalidSince);
    }

    validate_policy_commitment(&job)?;

    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if executor_lock_hash == job_lock_hash
        || !QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|lock_hash| lock_hash == executor_lock_hash && lock_hash != job_lock_hash)
    {
        return Err(ScriptError::RewardRecipientMismatch);
    }

    let mut reward_bytes = [0_u8; 8];
    reward_bytes.copy_from_slice(job.reward().as_slice());
    let expected_reward = u64::from_le_bytes(reward_bytes);
    let actual_reward = load_cell_capacity(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardAmountMismatch)?;
    if actual_reward != expected_reward {
        return Err(ScriptError::RewardAmountMismatch);
    }

    let actual_recipient = load_cell_lock_hash(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    let reward_type = load_cell_type_hash(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    let reward_data = load_cell_data(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    if actual_recipient != executor_lock_hash || reward_type.is_some() || !reward_data.is_empty() {
        return Err(ScriptError::RewardRecipientMismatch);
    }
    if !controlled_output_indices.contains(&reward_output_index) {
        return Err(ScriptError::CapacityNotConserved);
    }
    validate_value_conservation(&job, controlled_output_indices)?;
    validate_successor(&job, job_lock_hash, controlled_output_indices, delay)
}

fn load_operator_payload(job: &JobDataV1) -> Result<OperatorPayloadV1, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let payload = OperatorPayloadV1::from_slice(&payload_bytes)
        .map_err(|_| ScriptError::PayloadHashMismatch)?;
    if read_u16(payload.version().as_slice()) != 1 {
        return Err(ScriptError::UnsupportedVersion);
    }
    let mut policy_hash = [0_u8; 32];
    policy_hash.copy_from_slice(job.policy_script_hash().as_slice());
    if operator_selection::payload_hash(&policy_hash, &payload_bytes)
        != job.payload_hash().as_slice()
    {
        return Err(ScriptError::PayloadHashMismatch);
    }
    Ok(payload)
}

fn validate_successor(
    job: &JobDataV1,
    job_lock_hash: [u8; 32],
    controlled_output_indices: &[usize],
    takeover_delay: u64,
) -> Result<(), ScriptError> {
    let mut runs_bytes = [0_u8; 4];
    runs_bytes.copy_from_slice(job.remaining_runs().as_slice());
    let remaining_runs = u32::from_le_bytes(runs_bytes);
    if remaining_runs == 0 {
        return Err(ScriptError::InvalidData);
    }
    if remaining_runs == 1 {
        if QueryIter::new(load_cell_lock_hash, Source::Output)
            .any(|lock_hash| lock_hash == job_lock_hash)
        {
            return Err(ScriptError::SuccessorCountMismatch);
        }
        return Ok(());
    }

    validate_recurring_successor(
        job,
        job_lock_hash,
        controlled_output_indices,
        remaining_runs,
        takeover_delay,
    )
}

fn validate_recurring_successor(
    job: &JobDataV1,
    job_lock_hash: [u8; 32],
    controlled_output_indices: &[usize],
    remaining_runs: u32,
    takeover_delay: u64,
) -> Result<(), ScriptError> {
    let mut successor_index = None;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == job_lock_hash {
            if successor_index.is_some() {
                return Err(ScriptError::SuccessorCountMismatch);
            }
            successor_index = Some(index);
        }
    }
    let successor_index = successor_index.ok_or(ScriptError::SuccessorCountMismatch)?;
    if !controlled_output_indices.contains(&successor_index) {
        return Err(ScriptError::CapacityNotConserved);
    }

    let mut policy_hash = [0_u8; 32];
    policy_hash.copy_from_slice(job.policy_script_hash().as_slice());
    let successor_policy = load_cell_type_hash(successor_index, Source::Output)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if successor_policy != policy_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }
    let successor_data =
        load_cell_data(successor_index, Source::Output).map_err(|_| ScriptError::InvalidData)?;
    let successor = JobDataV1::from_slice(&successor_data).map_err(|_| ScriptError::InvalidData)?;

    for (input, output) in [
        (job.version().as_slice(), successor.version().as_slice()),
        (job.flags().as_slice(), successor.flags().as_slice()),
        (job.job_id().as_slice(), successor.job_id().as_slice()),
        (job.state().as_slice(), successor.state().as_slice()),
        (
            job.trigger_kind().as_slice(),
            successor.trigger_kind().as_slice(),
        ),
        (
            job.policy_script_hash().as_slice(),
            successor.policy_script_hash().as_slice(),
        ),
        (
            job.payload_hash().as_slice(),
            successor.payload_hash().as_slice(),
        ),
        (job.reward().as_slice(), successor.reward().as_slice()),
        (
            job.cancel_lock_hash().as_slice(),
            successor.cancel_lock_hash().as_slice(),
        ),
    ] {
        if input != output {
            return Err(ScriptError::SuccessorInvariantMismatch);
        }
    }

    let input_sequence = read_u64(job.sequence().as_slice());
    let successor_sequence = read_u64(successor.sequence().as_slice());
    if input_sequence
        .checked_add(1)
        .ok_or(ScriptError::ArithmeticOverflow)?
        != successor_sequence
    {
        return Err(ScriptError::SequenceMismatch);
    }
    if read_u32(successor.remaining_runs().as_slice()) != remaining_runs - 1 {
        return Err(ScriptError::RunsIncrease);
    }
    let input_budget = read_u64(job.remaining_budget().as_slice());
    let successor_budget = read_u64(successor.remaining_budget().as_slice());
    if successor_budget >= input_budget {
        return Err(ScriptError::BudgetIncrease);
    }

    let trigger_kind = read_u16(job.trigger_kind().as_slice());
    let successor_since = read_u64(successor.not_before().as_slice());
    let successor_takeover = read_u64(successor.not_after().as_slice());
    let trigger_hash_changed =
        successor.trigger_params_hash().as_slice() != job.trigger_params_hash().as_slice();
    let lower_bound_advanced = trigger::absolute_since_strictly_advances(
        read_u64(job.not_before().as_slice()),
        successor_since,
    );
    if !trigger::validate_trigger_since(trigger_kind, successor_since, successor_since)
        || !trigger_hash_changed
        || ((1..=3).contains(&trigger_kind) && !lower_bound_advanced)
        || operator_selection::takeover_block(successor_since, takeover_delay)
            != Some(successor_takeover)
    {
        return Err(ScriptError::TriggerHashMismatch);
    }

    let successor_capacity = load_cell_capacity(successor_index, Source::Output)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let successor_occupied = load_cell_occupied_capacity(successor_index, Source::Output)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    let successor_spendable = successor_capacity
        .checked_sub(successor_occupied)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if successor_budget > successor_spendable
        || read_u64(successor.reward().as_slice()) > successor_budget
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
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

fn validate_value_conservation(
    job: &JobDataV1,
    controlled_output_indices: &[usize],
) -> Result<(), ScriptError> {
    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let occupied_capacity =
        load_cell_occupied_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let spendable_capacity = input_capacity
        .checked_sub(occupied_capacity)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let mut budget_bytes = [0_u8; 8];
    budget_bytes.copy_from_slice(job.remaining_budget().as_slice());
    let remaining_budget = u64::from_le_bytes(budget_bytes);
    let mut reward_bytes = [0_u8; 8];
    reward_bytes.copy_from_slice(job.reward().as_slice());
    let reward = u64::from_le_bytes(reward_bytes);
    if remaining_budget > spendable_capacity || reward > remaining_budget {
        return Err(ScriptError::CapacityNotConserved);
    }

    let mut controlled_capacity = 0_u64;
    for index in controlled_output_indices {
        let capacity = load_cell_capacity(*index, Source::Output)
            .map_err(|_| ScriptError::CapacityNotConserved)?;
        let occupied = load_cell_occupied_capacity(*index, Source::Output)
            .map_err(|_| ScriptError::CapacityNotConserved)?;
        if capacity < occupied {
            return Err(ScriptError::CapacityNotConserved);
        }
        controlled_capacity = controlled_capacity
            .checked_add(capacity)
            .ok_or(ScriptError::ArithmeticOverflow)?;
    }
    if controlled_capacity != input_capacity {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
}

fn validate_refund(cancel_lock_hash: [u8; 32]) -> Result<(), ScriptError> {
    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let refund_capacity =
        load_cell_capacity(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;
    let refund_lock_hash =
        load_cell_lock_hash(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;
    let refund_type_hash =
        load_cell_type_hash(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;
    let refund_data =
        load_cell_data(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;

    if refund_capacity != input_capacity
        || refund_lock_hash != cancel_lock_hash
        || refund_type_hash.is_some()
        || !refund_data.is_empty()
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
}
