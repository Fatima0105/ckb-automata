#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash,
        load_script, load_script_hash, load_witness_args,
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
mod campaign_generated {
    include!("../../generated/campaign_v1.rs");
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

mod execution_witness {
    include!("../../shared/execution_witness.rs");
}

mod operator_selection {
    include!("../../shared/operator_selection.rs");
}

use campaign_generated::CampaignDataV1;
use error_codes::ScriptError;
use job_generated::JobDataV1;
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
    let input_count = QueryIter::new(load_cell_capacity, Source::GroupInput).count();
    let output_count = QueryIter::new(load_cell_capacity, Source::GroupOutput).count();
    match (input_count, output_count) {
        (0, 1) => validate_creation(),
        (1, 1) => {
            if owner_top_up_requested()? {
                Ok(())
            } else {
                Err(ScriptError::InvalidApplicationState)
            }
        }
        (1, 0) => {
            if owner_exit_requested()? {
                Ok(())
            } else {
                validate_finalization()
            }
        }
        _ => Err(ScriptError::InvalidApplicationState),
    }
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

fn campaign_type_hash() -> Result<[u8; 32], ScriptError> {
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    let args = script.args().raw_data();
    args.as_ref()
        .try_into()
        .map_err(|_| ScriptError::InvalidData)
}

fn validate_creation() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    let operator = load_operator_payload(&job, script_hash, 0, Source::Input, true)?;
    validate_job_configuration(&job, script_hash, &operator)?;
    validate_application_payload(&operator, campaign_type_hash()?)?;
    Ok(())
}

fn validate_job_configuration(
    job: &JobDataV1,
    script_hash: [u8; 32],
    operator: &OperatorPayloadV1,
) -> Result<(), ScriptError> {
    if job.policy_script_hash().as_slice() != script_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }
    if read_u16(job.version().as_slice()) != 1
        || read_u16(job.flags().as_slice()) != 0
        || job.state().as_slice() != [0]
        || read_u16(job.trigger_kind().as_slice()) != 1
        || read_u32(job.remaining_runs().as_slice()) != 1
        || read_u64(job.not_before().as_slice()) == 0
        || is_zero(job.payload_hash().as_slice())
    {
        return Err(ScriptError::InvalidData);
    }
    let delay = read_u64(operator.takeover_delay_blocks().as_slice());
    if is_zero(operator.preferred_executor_lock_hash().as_slice())
        || operator_selection::takeover_block(read_u64(job.not_before().as_slice()), delay)
            != Some(read_u64(job.not_after().as_slice()))
    {
        return Err(ScriptError::InvalidData);
    }
    Ok(())
}

fn validate_finalization() -> Result<(), ScriptError> {
    let job_data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::InvalidData)?;
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    let operator = load_operator_payload(&job, script_hash, 0, Source::GroupInput, false)?;
    validate_job_configuration(&job, script_hash, &operator)?;
    let expected_campaign_type = campaign_type_hash()?;
    validate_application_payload(&operator, expected_campaign_type)?;

    let mut campaign_index = None;
    for (index, type_hash) in QueryIter::new(load_cell_type_hash, Source::Input).enumerate() {
        if type_hash == Some(expected_campaign_type) {
            if campaign_index.is_some() {
                return Err(ScriptError::InvalidApplicationState);
            }
            campaign_index = Some(index);
        }
    }
    let campaign_index = campaign_index.ok_or(ScriptError::InvalidApplicationState)?;
    let campaign_data =
        load_cell_data(campaign_index, Source::Input).map_err(|_| ScriptError::InvalidData)?;
    let campaign =
        CampaignDataV1::from_slice(&campaign_data).map_err(|_| ScriptError::InvalidData)?;
    if campaign.state().as_slice() != [0]
        || read_u64(job.not_before().as_slice()) != read_u64(campaign.deadline_since().as_slice())
    {
        return Err(ScriptError::InvalidApplicationState);
    }
    validate_reward(&job)?;
    validate_no_successor()?;

    let mut success_lock_hash = [0_u8; 32];
    success_lock_hash.copy_from_slice(campaign.success_lock_hash().as_slice());
    if read_u64(campaign.pledged().as_slice()) < read_u64(campaign.target().as_slice()) {
        return validate_terminal_state(expected_campaign_type, 2);
    }

    let mut payout_count = 0;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == success_lock_hash {
            payout_count += 1;
            let capacity = load_cell_capacity(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let type_hash = load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let data = load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            if capacity != read_u64(campaign.pledged().as_slice())
                || type_hash.is_some()
                || !data.is_empty()
            {
                return Err(ScriptError::InvalidApplicationState);
            }
        }
    }
    if payout_count != 1 {
        return Err(ScriptError::InvalidApplicationState);
    }
    validate_terminal_state(expected_campaign_type, 1)
}

fn load_operator_payload(
    job: &JobDataV1,
    script_hash: [u8; 32],
    witness_index: usize,
    source: Source,
    input_field: bool,
) -> Result<OperatorPayloadV1, ScriptError> {
    let witness =
        load_witness_args(witness_index, source).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let bytes = if input_field {
        witness
            .input_type()
            .to_opt()
            .ok_or(ScriptError::PayloadHashMismatch)?
            .raw_data()
    } else {
        witness
            .output_type()
            .to_opt()
            .ok_or(ScriptError::PayloadHashMismatch)?
            .raw_data()
    };
    let payload =
        OperatorPayloadV1::from_slice(&bytes).map_err(|_| ScriptError::PayloadHashMismatch)?;
    if read_u16(payload.version().as_slice()) != 1
        || operator_selection::payload_hash(&script_hash, &bytes) != job.payload_hash().as_slice()
    {
        return Err(ScriptError::PayloadHashMismatch);
    }
    Ok(payload)
}

fn validate_application_payload(
    payload: &OperatorPayloadV1,
    campaign_type: [u8; 32],
) -> Result<(), ScriptError> {
    let application = payload.application_payload().raw_data();
    if application.len() != 33 || application[0] != 1 || application[1..] != campaign_type {
        return Err(ScriptError::PayloadHashMismatch);
    }
    Ok(())
}

fn validate_terminal_state(
    expected_campaign_type: [u8; 32],
    expected_state: u8,
) -> Result<(), ScriptError> {
    let mut terminal_count = 0;
    for (index, type_hash) in QueryIter::new(load_cell_type_hash, Source::Output).enumerate() {
        if type_hash == Some(expected_campaign_type) {
            let data = load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let output = CampaignDataV1::from_slice(&data)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            if output.state().as_slice() != [expected_state] {
                return Err(ScriptError::InvalidApplicationState);
            }
            terminal_count += 1;
        }
    }
    if terminal_count == 1 {
        Ok(())
    } else {
        Err(ScriptError::InvalidApplicationState)
    }
}

fn validate_reward(job: &JobDataV1) -> Result<(), ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let request = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    if request.len() < 38 || request[0] != 0 {
        return Err(ScriptError::InvalidWitnessMode);
    }
    let reward_output_index = read_u32(&request[1..5]) as usize;
    let expected_recipient = &request[5..37];
    let capacity = load_cell_capacity(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardAmountMismatch)?;
    if capacity != read_u64(job.reward().as_slice()) {
        return Err(ScriptError::RewardAmountMismatch);
    }
    let recipient = load_cell_lock_hash(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    let type_hash = load_cell_type_hash(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    let data = load_cell_data(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    if recipient.as_slice() != expected_recipient || type_hash.is_some() || !data.is_empty() {
        return Err(ScriptError::RewardRecipientMismatch);
    }
    Ok(())
}

fn validate_no_successor() -> Result<(), ScriptError> {
    let job_lock_hash =
        load_cell_lock_hash(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    if QueryIter::new(load_cell_lock_hash, Source::Output)
        .any(|lock_hash| lock_hash == job_lock_hash)
    {
        return Err(ScriptError::SuccessorCountMismatch);
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

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
}
