#![no_main]
#![no_std]

use alloc::vec::Vec;
use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash,
        load_cell_occupied_capacity, load_cell_type_hash, load_header, load_input,
        load_input_since, load_script, load_script_hash, load_witness_args,
    },
};
use molecule::prelude::{Builder, Entity};

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
mod dao_harvest {
    include!("../../shared/dao_harvest.rs");
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

use dao_harvest_v2::*;
use error_codes::ScriptError;
use harvest_generated::{
    DaoHarvestEnvelopeV2, DaoHarvestPayloadV2, DaoHarvestPrepareCreditV2, DaoHarvestProgressV2,
    DaoHarvestWitnessV2,
};
use job_generated::JobDataV1;

entry!(main);
default_alloc!();

struct HarvestContext {
    witness: DaoHarvestWitnessV2,
    envelope: DaoHarvestEnvelopeV2,
    payload: DaoHarvestPayloadV2,
    progress: DaoHarvestProgressV2,
}

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    let inputs = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let outputs = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    match (inputs, outputs) {
        (0, 1) => validate_setup(),
        (1, 0 | 1) => validate_transition(),
        _ => Err(ScriptError::DuplicateJob),
    }
}

fn validate_setup() -> Result<(), ScriptError> {
    let context = load_context(0, Source::Input)?;
    if operation(&context.witness) != SETUP_OPERATION {
        return Err(ScriptError::InvalidWitnessMode);
    }
    validate_envelope_shape(&context)?;
    validate_payload(&context.payload)?;
    validate_fallback_proof(&context)?;
    let identity_index = index(context.witness.identity_input_index())?;
    require_lock_hash(
        identity_index,
        Source::Input,
        context.payload.owner_lock_hash().as_slice(),
        ScriptError::MissingOwnerAuthorization,
    )?;

    let job_index = index(context.witness.job_output_index())?;
    let job = load_job(job_index, Source::Output)?;
    validate_job_creation(&job, &context, job_index)?;
    let vault_index = index(context.witness.vault_output_index())?;
    let compensation_index = index(context.witness.compensation_output_index())?;
    validate_vault(
        &job,
        &context.payload,
        vault_index,
        Source::Output,
        false,
        false,
    )?;
    validate_compensation(
        &job,
        &context.payload,
        compensation_index,
        Source::Output,
        read_u64(context.payload.compensation_seed_capacity().as_slice()),
        false,
    )?;
    validate_unique_job_lock(job_index, Source::Output)?;
    Ok(())
}

fn validate_transition() -> Result<(), ScriptError> {
    let context = load_context(0, Source::GroupInput)?;
    let operation = operation(&context.witness);
    validate_envelope_shape(&context)?;
    validate_payload(&context.payload)?;
    let job_index = index(context.witness.job_input_index())?;
    validate_group_job_index(job_index)?;
    let job = load_job(job_index, Source::Input)?;
    validate_input_job(&job, &context)?;
    validate_unique_job_lock(job_index, Source::Input)?;
    match operation {
        PREFERRED_PREPARE_OPERATION | FALLBACK_PREPARE_OPERATION => {
            validate_prepare(&job, &context)
        }
        PREFERRED_CLAIM_OPERATION | FALLBACK_CLAIM_OPERATION | OWNER_COMPLETE_OPERATION => {
            validate_claim(&job, &context)
        }
        SWEEP_OPERATION => validate_sweep(&job, &context),
        CLOSE_OPERATION => Err(ScriptError::OperationLayoutMismatch),
        ROTATE_OPERATION => validate_rotation(&job, &context),
        RECOVER_OPERATION => validate_recovery(&job, &context),
        _ => Err(ScriptError::InvalidWitnessMode),
    }
}

fn load_context(witness_index: usize, source: Source) -> Result<HarvestContext, ScriptError> {
    let args =
        load_witness_args(witness_index, source).map_err(|_| ScriptError::InvalidWitnessMode)?;
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
    let payload = DaoHarvestPayloadV2::from_slice(&envelope.payload().raw_data())
        .map_err(|_| ScriptError::InvalidData)?;
    let progress = DaoHarvestProgressV2::from_slice(&envelope.progress().raw_data())
        .map_err(|_| ScriptError::InvalidData)?;
    let indices = witness_indices(&witness);
    if read_u16(witness.version().as_slice()) != DAO_HARVEST_V2_VERSION
        || witness.flags().as_slice() != [0]
        || !dao_harvest_v2_validation::validate_witness_layout(operation(&witness), &indices)
    {
        return Err(ScriptError::OperationLayoutMismatch);
    }
    Ok(HarvestContext {
        witness,
        envelope,
        payload,
        progress,
    })
}

fn validate_envelope_shape(context: &HarvestContext) -> Result<(), ScriptError> {
    let operation = operation(&context.witness);
    let credit = context.envelope.prepare_credit().raw_data();
    let proof = context.envelope.operator_proof().raw_data();
    let successor = context.envelope.successor_payload().raw_data();
    let credit_required = matches!(
        operation,
        PREFERRED_PREPARE_OPERATION
            | FALLBACK_PREPARE_OPERATION
            | PREFERRED_CLAIM_OPERATION
            | FALLBACK_CLAIM_OPERATION
            | OWNER_COMPLETE_OPERATION
    ) || (operation == RECOVER_OPERATION
        && context.progress.state().as_slice() == [WITHDRAWING_STATE]);
    let proof_required = matches!(
        operation,
        SETUP_OPERATION | FALLBACK_PREPARE_OPERATION | ROTATE_OPERATION
    );
    if credit_required == credit.is_empty()
        || proof_required == proof.is_empty()
        || (operation == ROTATE_OPERATION) == successor.is_empty()
    {
        return Err(ScriptError::OperationLayoutMismatch);
    }
    let expected_credit_hash = if credit.is_empty() {
        [0_u8; 32]
    } else {
        prepare_credit_hash(&credit).ok_or(ScriptError::ArithmeticOverflow)?
    };
    if context.witness.prepare_credit_hash().as_slice() != expected_credit_hash {
        return Err(ScriptError::PrepareCreditMismatch);
    }
    Ok(())
}

fn validate_payload(payload: &DaoHarvestPayloadV2) -> Result<(), ScriptError> {
    let nonzero = [
        payload.owner_lock_hash().as_slice(),
        payload.payout_lock_hash().as_slice(),
        payload.vault_lock_code_hash().as_slice(),
        payload.compensation_lock_code_hash().as_slice(),
        payload.dao_type_hash().as_slice(),
        payload.preferred_prepare_operator_lock_hash().as_slice(),
        payload.fallback_prepare_executor_set_hash().as_slice(),
    ]
    .iter()
    .all(|value| value.iter().any(|byte| *byte != 0));
    if read_u16(payload.version().as_slice()) != DAO_HARVEST_V2_VERSION
        || !nonzero
        || read_u64(payload.principal_capacity().as_slice()) == 0
        || read_u64(payload.compensation_seed_capacity().as_slice()) == 0
        || read_u32(payload.total_cycles().as_slice()) == 0
        || !dao_harvest_v2_validation::is_relative_epoch_since(read_u64(
            payload.prepare_buffer_epochs().as_slice(),
        ))
        || !dao_harvest_v2_validation::is_relative_epoch_since(read_u64(
            payload.takeover_delay_epochs().as_slice(),
        ))
        || !dao_harvest_v2_validation::is_relative_epoch_since(read_u64(
            payload.confirmation_margin_epochs().as_slice(),
        ))
    {
        return Err(ScriptError::PolicyVersionMismatch);
    }
    let end = read_u64(payload.end_epoch_since().as_slice());
    if end != 0 && !dao_harvest_v2_validation::is_absolute_epoch_since(end) {
        return Err(ScriptError::InvalidSince);
    }
    Ok(())
}

fn validate_fallback_proof(context: &HarvestContext) -> Result<Vec<[u8; 32]>, ScriptError> {
    let expected: [u8; 32] = context
        .payload
        .fallback_prepare_executor_set_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::InvalidExecutorSet)?;
    decode_fallback_operator_proof(&context.envelope.operator_proof().raw_data(), &expected)
        .ok_or(ScriptError::InvalidExecutorSet)
}

fn validate_job_creation(
    job: &JobDataV1,
    context: &HarvestContext,
    job_index: usize,
) -> Result<(), ScriptError> {
    let policy_hash = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let payload_bytes = context.envelope.payload().raw_data();
    let progress_bytes = context.envelope.progress().raw_data();
    let payload_hash =
        payload_hash(&policy_hash, &payload_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    let progress_hash = progress_hash(&progress_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    validate_job_lock_code(job_index, Source::Output)?;
    if read_u16(job.version().as_slice()) != 1
        || read_u16(job.flags().as_slice()) != 0
        || job.state().as_slice() != [0]
        || read_u16(job.trigger_kind().as_slice()) != 2
        || read_u64(job.sequence().as_slice()) != 0
        || read_u64(job.reward().as_slice()) != 0
        || read_u64(job.remaining_budget().as_slice()) != 0
        || read_u32(job.remaining_runs().as_slice())
            != read_u32(context.payload.total_cycles().as_slice())
        || job.policy_script_hash().as_slice() != policy_hash
        || job.payload_hash().as_slice() != payload_hash
        || job.trigger_params_hash().as_slice() != progress_hash
        || job.cancel_lock_hash().as_slice() != context.payload.owner_lock_hash().as_slice()
        || !dao_harvest_v2_validation::is_absolute_epoch_since(read_u64(
            job.not_before().as_slice(),
        ))
        || read_u64(job.not_after().as_slice())
            != read_u64(context.payload.end_epoch_since().as_slice())
        || (read_u64(job.not_after().as_slice()) != 0
            && (!dao_harvest_v2_validation::epoch_at_or_after(
                read_u64(job.not_after().as_slice()),
                read_u64(job.not_before().as_slice()),
            ) || job.not_after().as_slice() == job.not_before().as_slice()))
        || read_u16(context.progress.version().as_slice()) != DAO_HARVEST_V2_VERSION
        || context.progress.state().as_slice() != [DEPOSITED_STATE]
        || read_u32(context.progress.cycle_index().as_slice()) != 0
        || context.progress.prepare_credit_hash().as_slice() != [0_u8; 32]
    {
        return Err(ScriptError::SuccessorInvariantMismatch);
    }
    Ok(())
}

fn validate_input_job(job: &JobDataV1, context: &HarvestContext) -> Result<(), ScriptError> {
    let policy_hash = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let payload_bytes = context.envelope.payload().raw_data();
    let progress_bytes = context.envelope.progress().raw_data();
    let expected_payload =
        payload_hash(&policy_hash, &payload_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    let expected_progress =
        progress_hash(&progress_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    if job.policy_script_hash().as_slice() != policy_hash
        || job.payload_hash().as_slice() != expected_payload
        || context.witness.payload_hash().as_slice() != expected_payload
        || job.trigger_params_hash().as_slice() != expected_progress
        || context.witness.progress_hash().as_slice() != expected_progress
        || job.cancel_lock_hash().as_slice() != context.payload.owner_lock_hash().as_slice()
    {
        return Err(ScriptError::PayloadHashMismatch);
    }
    Ok(())
}

fn validate_prepare(job: &JobDataV1, context: &HarvestContext) -> Result<(), ScriptError> {
    if context.progress.state().as_slice() != [DEPOSITED_STATE]
        || context.progress.prepare_credit_hash().as_slice() != [0_u8; 32]
    {
        return Err(ScriptError::InvalidState);
    }
    let identity_index = index(context.witness.identity_input_index())?;
    let identity = load_cell_lock_hash(identity_index, Source::Input)
        .map_err(|_| ScriptError::UnauthorizedExecutor)?;
    let operation = operation(&context.witness);
    if operation == PREFERRED_PREPARE_OPERATION {
        if identity.as_slice()
            != context
                .payload
                .preferred_prepare_operator_lock_hash()
                .as_slice()
        {
            return Err(ScriptError::UnauthorizedPreferredOperator);
        }
        let actual = load_input_since(index(context.witness.job_input_index())?, Source::Input)
            .map_err(|_| ScriptError::InvalidSince)?;
        if actual != read_u64(job.not_before().as_slice())
            || !dao_harvest_v2_validation::is_absolute_epoch_since(actual)
        {
            return Err(ScriptError::InvalidSince);
        }
    } else {
        let operators = validate_fallback_proof(context)?;
        if !operators.contains(&identity) {
            return Err(ScriptError::UnauthorizedExecutor);
        }
        let actual = load_input_since(index(context.witness.job_input_index())?, Source::Input)
            .map_err(|_| ScriptError::InvalidSince)?;
        if !dao_harvest_v2_validation::epoch_at_or_after_delay(
            actual,
            read_u64(job.not_before().as_slice()),
            read_u64(context.payload.takeover_delay_epochs().as_slice()),
        ) {
            return Err(ScriptError::TakeoverNotReached);
        }
    }
    let vault_input = index(context.witness.vault_input_index())?;
    let vault_output = index(context.witness.vault_output_index())?;
    validate_vault(
        job,
        &context.payload,
        vault_input,
        Source::Input,
        false,
        false,
    )?;
    validate_vault(
        job,
        &context.payload,
        vault_output,
        Source::Output,
        true,
        false,
    )?;
    require_same_lock_and_type(vault_input, vault_output)?;

    let credit_bytes = context.envelope.prepare_credit().raw_data();
    let credit = DaoHarvestPrepareCreditV2::from_slice(&credit_bytes)
        .map_err(|_| ScriptError::InvalidPrepareCredit)?;
    let job_output = index(context.witness.job_output_index())?;
    validate_prepare_credit(job, context, &credit, identity, vault_output, job_output)?;
    let credit_hash = prepare_credit_hash(&credit_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    let cycle_index: [u8; 4] = context
        .progress
        .cycle_index()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::InvalidData)?;
    let successor_progress = DaoHarvestProgressV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .state(WITHDRAWING_STATE)
        .cycle_index(cycle_index)
        .prepare_credit_hash(credit_hash)
        .build();
    validate_successor_job(
        job,
        job_output,
        read_u64(job.sequence().as_slice())
            .checked_add(1)
            .ok_or(ScriptError::ArithmeticOverflow)?,
        read_u32(job.remaining_runs().as_slice()),
        job.payload_hash().as_slice(),
        progress_hash(successor_progress.as_slice()).ok_or(ScriptError::ArithmeticOverflow)?,
        SuccessorTiming::Advance,
    )
}

fn validate_prepare_credit(
    job: &JobDataV1,
    context: &HarvestContext,
    credit: &DaoHarvestPrepareCreditV2,
    identity: [u8; 32],
    vault_output: usize,
    job_output: usize,
) -> Result<(), ScriptError> {
    if read_u16(credit.version().as_slice()) != DAO_HARVEST_V2_VERSION
        || credit.job_id().as_slice() != job.job_id().as_slice()
        || credit.cycle_index().as_slice() != context.progress.cycle_index().as_slice()
        || credit.preparer_lock_hash().as_slice() != identity
        || read_u32(credit.prepared_vault_output_index().as_slice()) as usize != vault_output
        || read_u32(credit.job_output_index().as_slice()) as usize != job_output
    {
        return Err(ScriptError::InvalidPrepareCredit);
    }
    Ok(())
}

fn validate_claim(job: &JobDataV1, context: &HarvestContext) -> Result<(), ScriptError> {
    if context.progress.state().as_slice() != [WITHDRAWING_STATE] {
        return Err(ScriptError::InvalidState);
    }
    let credit_bytes = context.envelope.prepare_credit().raw_data();
    let credit = DaoHarvestPrepareCreditV2::from_slice(&credit_bytes)
        .map_err(|_| ScriptError::InvalidPrepareCredit)?;
    validate_claim_credit(job, context, &credit, &credit_bytes)?;
    validate_claim_authority(job, context, &credit)?;

    let vault_input = index(context.witness.vault_input_index())?;
    let vault_output = index(context.witness.vault_output_index())?;
    validate_vault(
        job,
        &context.payload,
        vault_input,
        Source::Input,
        true,
        false,
    )?;
    let maximum = load_maximum_withdraw(vault_input)?;
    let principal = read_u64(context.payload.principal_capacity().as_slice());
    let owner_completion = operation(&context.witness) == OWNER_COMPLETE_OPERATION;
    let allocation = dao_harvest_v2_validation::allocate_compensation(
        maximum,
        principal,
        read_u64(context.payload.prepare_service_fee().as_slice()),
        read_u64(context.payload.claim_service_fee().as_slice()),
        owner_completion,
    )
    .ok_or(ScriptError::PrincipalMismatch)?;

    validate_operator_payments(context, &credit, allocation)?;
    let compensation_input = index(context.witness.compensation_input_index())?;
    let compensation_output = index(context.witness.compensation_output_index())?;
    let input_capacity = load_cell_capacity(compensation_input, Source::Input)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    validate_compensation(
        job,
        &context.payload,
        compensation_input,
        Source::Input,
        input_capacity,
        false,
    )?;
    let remaining = read_u32(job.remaining_runs().as_slice());
    let terminal = remaining == 1;
    validate_vault(
        job,
        &context.payload,
        vault_output,
        Source::Output,
        false,
        terminal,
    )?;
    if !terminal {
        require_same_lock_and_type(vault_input, vault_output)?;
    }
    validate_compensation(
        job,
        &context.payload,
        compensation_output,
        Source::Output,
        input_capacity
            .checked_add(allocation.owner_payment)
            .ok_or(ScriptError::ArithmeticOverflow)?,
        terminal,
    )?;

    let next_cycle = read_u32(context.progress.cycle_index().as_slice())
        .checked_add(1)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let job_output = read_u32(context.witness.job_output_index().as_slice());
    if remaining == 1 {
        if job_output != ABSENT_INDEX {
            return Err(ScriptError::CycleLimitReached);
        }
    } else {
        if job_output == ABSENT_INDEX {
            return Err(ScriptError::SuccessorCountMismatch);
        }
        let progress = DaoHarvestProgressV2::new_builder()
            .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
            .state(DEPOSITED_STATE)
            .cycle_index(next_cycle.to_le_bytes())
            .prepare_credit_hash([0_u8; 32])
            .build();
        validate_successor_job(
            job,
            job_output as usize,
            read_u64(job.sequence().as_slice())
                .checked_add(1)
                .ok_or(ScriptError::ArithmeticOverflow)?,
            remaining - 1,
            job.payload_hash().as_slice(),
            progress_hash(progress.as_slice()).ok_or(ScriptError::ArithmeticOverflow)?,
            SuccessorTiming::Advance,
        )?;
    }
    Ok(())
}

fn validate_claim_credit(
    job: &JobDataV1,
    context: &HarvestContext,
    credit: &DaoHarvestPrepareCreditV2,
    bytes: &[u8],
) -> Result<(), ScriptError> {
    let expected_hash = prepare_credit_hash(bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    let job_input = load_input(index(context.witness.job_input_index())?, Source::Input)
        .map_err(|_| ScriptError::InvalidPrepareCredit)?;
    let vault_input = load_input(index(context.witness.vault_input_index())?, Source::Input)
        .map_err(|_| ScriptError::InvalidPrepareCredit)?;
    if read_u16(credit.version().as_slice()) != DAO_HARVEST_V2_VERSION
        || credit.job_id().as_slice() != job.job_id().as_slice()
        || credit.cycle_index().as_slice() != context.progress.cycle_index().as_slice()
        || context.progress.prepare_credit_hash().as_slice() != expected_hash
        || job_input.previous_output().tx_hash().as_slice()
            != vault_input.previous_output().tx_hash().as_slice()
        || read_u32(credit.job_output_index().as_slice())
            != read_u32(job_input.previous_output().index().as_slice())
        || read_u32(credit.prepared_vault_output_index().as_slice())
            != read_u32(vault_input.previous_output().index().as_slice())
    {
        return Err(ScriptError::PrepareCreditMismatch);
    }
    Ok(())
}

fn validate_claim_authority(
    job: &JobDataV1,
    context: &HarvestContext,
    credit: &DaoHarvestPrepareCreditV2,
) -> Result<(), ScriptError> {
    let identity_index = index(context.witness.identity_input_index())?;
    let identity = load_cell_lock_hash(identity_index, Source::Input)
        .map_err(|_| ScriptError::UnauthorizedExecutor)?;
    let actual_since = load_input_since(index(context.witness.vault_input_index())?, Source::Input)
        .map_err(|_| ScriptError::InvalidSince)?;
    if !dao_harvest_v2_validation::is_absolute_epoch_since(actual_since) {
        return Err(ScriptError::InvalidSince);
    }
    match operation(&context.witness) {
        PREFERRED_CLAIM_OPERATION => {
            if identity.as_slice() != credit.preparer_lock_hash().as_slice()
                || actual_since != read_u64(job.not_before().as_slice())
            {
                return Err(ScriptError::UnauthorizedPreferredOperator);
            }
        }
        FALLBACK_CLAIM_OPERATION => {
            if !dao_harvest_v2_validation::epoch_at_or_after_delay(
                actual_since,
                read_u64(job.not_before().as_slice()),
                read_u64(context.payload.takeover_delay_epochs().as_slice()),
            ) {
                return Err(ScriptError::TakeoverNotReached);
            }
        }
        OWNER_COMPLETE_OPERATION => {
            if identity.as_slice() != context.payload.owner_lock_hash().as_slice()
                || !dao_harvest_v2_validation::epoch_at_or_after(
                    actual_since,
                    read_u64(job.not_before().as_slice()),
                )
            {
                return Err(ScriptError::MissingOwnerAuthorization);
            }
        }
        _ => return Err(ScriptError::InvalidWitnessMode),
    }
    Ok(())
}

fn validate_operator_payments(
    context: &HarvestContext,
    credit: &DaoHarvestPrepareCreditV2,
    allocation: dao_harvest_v2_validation::CompensationAllocation,
) -> Result<(), ScriptError> {
    let prepare_input = index(context.witness.prepare_accumulator_input_index())?;
    let prepare_output = index(context.witness.prepare_accumulator_output_index())?;
    let prepare_lock: [u8; 32] = credit
        .preparer_lock_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::InvalidPrepareCredit)?;
    let claim_input = read_u32(context.witness.claim_accumulator_input_index().as_slice());
    let claim_output = read_u32(context.witness.claim_accumulator_output_index().as_slice());
    let identity_index = index(context.witness.identity_input_index())?;
    let claimant = load_cell_lock_hash(identity_index, Source::Input)
        .map_err(|_| ScriptError::UnauthorizedExecutor)?;
    let same_operator = claimant == prepare_lock;
    if same_operator {
        if claim_input != ABSENT_INDEX
            && (claim_input as usize != prepare_input || claim_output as usize != prepare_output)
        {
            return Err(ScriptError::InvalidOperatorAccumulator);
        }
        validate_accumulator(
            prepare_input,
            prepare_output,
            &prepare_lock,
            allocation
                .prepare_payment
                .checked_add(allocation.claim_payment)
                .ok_or(ScriptError::ArithmeticOverflow)?,
        )
    } else {
        if operation(&context.witness) == PREFERRED_CLAIM_OPERATION
            || operation(&context.witness) == OWNER_COMPLETE_OPERATION
        {
            if operation(&context.witness) == PREFERRED_CLAIM_OPERATION {
                return Err(ScriptError::UnauthorizedPreferredOperator);
            }
            validate_accumulator(
                prepare_input,
                prepare_output,
                &prepare_lock,
                allocation.prepare_payment,
            )?;
            return Ok(());
        }
        validate_accumulator(
            prepare_input,
            prepare_output,
            &prepare_lock,
            allocation.prepare_payment,
        )?;
        validate_accumulator(
            index_u32(claim_input)?,
            index_u32(claim_output)?,
            &claimant,
            allocation.claim_payment,
        )
    }
}

fn validate_accumulator(
    input: usize,
    output: usize,
    expected_lock: &[u8; 32],
    payment: u64,
) -> Result<(), ScriptError> {
    require_lock_hash(
        input,
        Source::Input,
        expected_lock,
        ScriptError::InvalidOperatorAccumulator,
    )?;
    if QueryIter::new(load_cell_lock_hash, Source::Input)
        .filter(|hash| hash == expected_lock)
        .count()
        != 1
        || QueryIter::new(load_cell_lock_hash, Source::Output)
            .filter(|hash| hash == expected_lock)
            .count()
            != 1
    {
        return Err(ScriptError::InvalidOperatorAccumulator);
    }
    require_lock_hash(
        output,
        Source::Output,
        expected_lock,
        ScriptError::InvalidOperatorAccumulator,
    )?;
    if load_cell_type_hash(input, Source::Input)
        .map_err(|_| ScriptError::InvalidOperatorAccumulator)?
        .is_some()
        || load_cell_type_hash(output, Source::Output)
            .map_err(|_| ScriptError::InvalidOperatorAccumulator)?
            .is_some()
        || !load_cell_data(input, Source::Input)
            .map_err(|_| ScriptError::InvalidOperatorAccumulator)?
            .is_empty()
        || !load_cell_data(output, Source::Output)
            .map_err(|_| ScriptError::InvalidOperatorAccumulator)?
            .is_empty()
    {
        return Err(ScriptError::InvalidOperatorAccumulator);
    }
    let input_capacity = load_cell_capacity(input, Source::Input)
        .map_err(|_| ScriptError::InvalidOperatorAccumulator)?;
    let output_capacity = load_cell_capacity(output, Source::Output)
        .map_err(|_| ScriptError::InvalidOperatorAccumulator)?;
    if !dao_harvest_v2_validation::validate_accumulator_delta(
        input_capacity,
        output_capacity,
        payment,
    ) {
        return Err(ScriptError::ServiceFeeMismatch);
    }
    Ok(())
}

fn validate_sweep(job: &JobDataV1, context: &HarvestContext) -> Result<(), ScriptError> {
    require_owner(context)?;
    let job_output = index(context.witness.job_output_index())?;
    validate_successor_job(
        job,
        job_output,
        read_u64(job.sequence().as_slice()),
        read_u32(job.remaining_runs().as_slice()),
        job.payload_hash().as_slice(),
        job.trigger_params_hash()
            .as_slice()
            .try_into()
            .unwrap_or_default(),
        SuccessorTiming::Preserve,
    )?;
    let compensation_input = index(context.witness.compensation_input_index())?;
    let compensation_output = index(context.witness.compensation_output_index())?;
    let input_capacity = load_cell_capacity(compensation_input, Source::Input)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    let seed = read_u64(context.payload.compensation_seed_capacity().as_slice());
    if input_capacity <= seed {
        return Err(ScriptError::CompensationDeltaMismatch);
    }
    validate_compensation(
        job,
        &context.payload,
        compensation_input,
        Source::Input,
        input_capacity,
        false,
    )?;
    validate_compensation(
        job,
        &context.payload,
        compensation_output,
        Source::Output,
        seed,
        false,
    )?;
    validate_exact_plain_payout(
        context.payload.payout_lock_hash().as_slice(),
        input_capacity - seed,
    )
}

fn validate_rotation(job: &JobDataV1, context: &HarvestContext) -> Result<(), ScriptError> {
    require_owner(context)?;
    if context.progress.state().as_slice() != [DEPOSITED_STATE] {
        return Err(ScriptError::InvalidState);
    }
    let successor_bytes = context.envelope.successor_payload().raw_data();
    let successor =
        DaoHarvestPayloadV2::from_slice(&successor_bytes).map_err(|_| ScriptError::InvalidData)?;
    validate_payload(&successor)?;
    validate_rotation_fields(&context.payload, &successor)?;
    let mut successor_context = HarvestContext {
        witness: context.witness.clone(),
        envelope: context.envelope.clone(),
        payload: successor.clone(),
        progress: context.progress.clone(),
    };
    let _ = &mut successor_context;
    let expected_set: [u8; 32] = successor
        .fallback_prepare_executor_set_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::InvalidExecutorSet)?;
    decode_fallback_operator_proof(&context.envelope.operator_proof().raw_data(), &expected_set)
        .ok_or(ScriptError::InvalidExecutorSet)?;
    let policy = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let successor_hash =
        payload_hash(&policy, &successor_bytes).ok_or(ScriptError::ArithmeticOverflow)?;
    if successor_hash.as_slice() == job.payload_hash().as_slice() {
        return Err(ScriptError::InvalidExecutorSet);
    }
    let job_output = index(context.witness.job_output_index())?;
    validate_successor_job(
        job,
        job_output,
        read_u64(job.sequence().as_slice()),
        read_u32(job.remaining_runs().as_slice()),
        &successor_hash,
        job.trigger_params_hash()
            .as_slice()
            .try_into()
            .unwrap_or_default(),
        SuccessorTiming::Preserve,
    )?;
    let input = index(context.witness.compensation_input_index())?;
    let output = index(context.witness.compensation_output_index())?;
    let capacity = load_cell_capacity(input, Source::Input)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    validate_compensation(job, &context.payload, input, Source::Input, capacity, false)?;
    validate_compensation_with_payload_hash(
        job,
        &successor,
        &successor_hash,
        output,
        Source::Output,
        capacity,
        false,
    )
}

fn validate_rotation_fields(
    input: &DaoHarvestPayloadV2,
    output: &DaoHarvestPayloadV2,
) -> Result<(), ScriptError> {
    for (left, right) in [
        (input.version().as_slice(), output.version().as_slice()),
        (
            input.owner_lock_hash().as_slice(),
            output.owner_lock_hash().as_slice(),
        ),
        (
            input.payout_lock_hash().as_slice(),
            output.payout_lock_hash().as_slice(),
        ),
        (
            input.vault_lock_code_hash().as_slice(),
            output.vault_lock_code_hash().as_slice(),
        ),
        (
            input.compensation_lock_code_hash().as_slice(),
            output.compensation_lock_code_hash().as_slice(),
        ),
        (
            input.dao_type_hash().as_slice(),
            output.dao_type_hash().as_slice(),
        ),
        (
            input.principal_capacity().as_slice(),
            output.principal_capacity().as_slice(),
        ),
        (
            input.prepare_service_fee().as_slice(),
            output.prepare_service_fee().as_slice(),
        ),
        (
            input.claim_service_fee().as_slice(),
            output.claim_service_fee().as_slice(),
        ),
        (
            input.compensation_seed_capacity().as_slice(),
            output.compensation_seed_capacity().as_slice(),
        ),
        (
            input.prepare_buffer_epochs().as_slice(),
            output.prepare_buffer_epochs().as_slice(),
        ),
        (
            input.takeover_delay_epochs().as_slice(),
            output.takeover_delay_epochs().as_slice(),
        ),
        (
            input.confirmation_margin_epochs().as_slice(),
            output.confirmation_margin_epochs().as_slice(),
        ),
        (
            input.total_cycles().as_slice(),
            output.total_cycles().as_slice(),
        ),
        (
            input.end_epoch_since().as_slice(),
            output.end_epoch_since().as_slice(),
        ),
    ] {
        if left != right {
            return Err(ScriptError::SuccessorInvariantMismatch);
        }
    }
    Ok(())
}

fn validate_recovery(job: &JobDataV1, context: &HarvestContext) -> Result<(), ScriptError> {
    require_owner(context)?;
    let vault = index(context.witness.vault_input_index())?;
    let withdrawing = context.progress.state().as_slice() == [WITHDRAWING_STATE];
    validate_vault(
        job,
        &context.payload,
        vault,
        Source::Input,
        withdrawing,
        false,
    )?;
    let vault_value = if withdrawing {
        load_maximum_withdraw(vault)?
    } else {
        load_cell_capacity(vault, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?
    };
    let compensation = index(context.witness.compensation_input_index())?;
    let compensation_value = load_cell_capacity(compensation, Source::Input)
        .map_err(|_| ScriptError::InvalidCompensationCell)?;
    validate_compensation(
        job,
        &context.payload,
        compensation,
        Source::Input,
        compensation_value,
        false,
    )?;
    let prepare_payment = if withdrawing {
        let credit_bytes = context.envelope.prepare_credit().raw_data();
        let credit = DaoHarvestPrepareCreditV2::from_slice(&credit_bytes)
            .map_err(|_| ScriptError::InvalidPrepareCredit)?;
        validate_claim_credit(job, context, &credit, &credit_bytes)?;
        let gross = vault_value
            .checked_sub(read_u64(context.payload.principal_capacity().as_slice()))
            .ok_or(ScriptError::PrincipalMismatch)?;
        let payment = gross.min(read_u64(context.payload.prepare_service_fee().as_slice()));
        let preparer: [u8; 32] = credit
            .preparer_lock_hash()
            .as_slice()
            .try_into()
            .map_err(|_| ScriptError::InvalidPrepareCredit)?;
        validate_accumulator(
            index(context.witness.prepare_accumulator_input_index())?,
            index(context.witness.prepare_accumulator_output_index())?,
            &preparer,
            payment,
        )?;
        payment
    } else {
        if read_u32(context.witness.prepare_accumulator_input_index().as_slice()) != ABSENT_INDEX
            || read_u32(
                context
                    .witness
                    .prepare_accumulator_output_index()
                    .as_slice(),
            ) != ABSENT_INDEX
        {
            return Err(ScriptError::InvalidOperatorAccumulator);
        }
        0
    };
    let job_value = load_cell_capacity(index(context.witness.job_input_index())?, Source::Input)
        .map_err(|_| ScriptError::CapacityNotConserved)?;
    validate_exact_plain_payout(
        context.payload.owner_lock_hash().as_slice(),
        vault_value
            .checked_sub(prepare_payment)
            .ok_or(ScriptError::ArithmeticOverflow)?
            .checked_add(compensation_value)
            .and_then(|value| value.checked_add(job_value))
            .ok_or(ScriptError::ArithmeticOverflow)?,
    )
}

fn validate_job_lock_code(index: usize, source: Source) -> Result<(), ScriptError> {
    let policy = load_script().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let args = policy.args().raw_data();
    if args.len() != 32 {
        return Err(ScriptError::PolicyVersionMismatch);
    }
    let lock = load_cell_lock(index, source).map_err(|_| ScriptError::MissingBoundJob)?;
    if lock.code_hash().as_slice() != args.as_ref()
        || lock.hash_type().as_slice() != [2]
        || !lock.args().raw_data().is_empty()
    {
        return Err(ScriptError::MissingBoundJob);
    }
    Ok(())
}

fn validate_vault(
    job: &JobDataV1,
    payload: &DaoHarvestPayloadV2,
    index: usize,
    source: Source,
    withdrawing: bool,
    terminal: bool,
) -> Result<(), ScriptError> {
    let capacity = load_cell_capacity(index, source).map_err(|_| ScriptError::InvalidDaoCell)?;
    let data = load_cell_data(index, source).map_err(|_| ScriptError::InvalidDaoCell)?;
    let type_hash = load_cell_type_hash(index, source)
        .map_err(|_| ScriptError::InvalidDaoCell)?
        .ok_or(ScriptError::InvalidDaoCell)?;
    if capacity != read_u64(payload.principal_capacity().as_slice())
        || type_hash.as_slice() != payload.dao_type_hash().as_slice()
        || dao_harvest::is_withdrawing_dao_data(&data) != Some(withdrawing)
    {
        return Err(ScriptError::PrincipalMismatch);
    }
    let lock = load_cell_lock(index, source).map_err(|_| ScriptError::InvalidDaoCell)?;
    if lock.code_hash().as_slice() != payload.vault_lock_code_hash().as_slice()
        || lock.hash_type().as_slice() != [2]
    {
        return Err(ScriptError::InvalidDaoCell);
    }
    let expected = expected_vault_args(job, payload, terminal)?;
    if lock.args().raw_data().as_ref() != expected {
        return Err(ScriptError::CompensationBindingMismatch);
    }
    let expected_hash =
        load_cell_lock_hash(index, source).map_err(|_| ScriptError::InvalidDaoCell)?;
    if QueryIter::new(load_cell_lock_hash, source)
        .filter(|hash| *hash == expected_hash)
        .count()
        != 1
    {
        return Err(ScriptError::InvalidDaoCell);
    }
    Ok(())
}

fn expected_vault_args(
    job: &JobDataV1,
    payload: &DaoHarvestPayloadV2,
    terminal: bool,
) -> Result<[u8; 160], ScriptError> {
    let job_lock = if terminal {
        [0_u8; 32]
    } else {
        load_cell_lock_hash(0, Source::GroupInput)
            .or_else(|_| {
                let output = index_u32(0)?;
                load_cell_lock_hash(output, Source::GroupOutput)
                    .map_err(|_| ScriptError::MissingBoundJob)
            })
            .map_err(|_| ScriptError::MissingBoundJob)?
    };
    let policy = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let terms = immutable_terms_hash(payload)?;
    Ok(encode_harvest_vault_lock_args(&HarvestVaultLockArgsV2 {
        job_id: job
            .job_id()
            .as_slice()
            .try_into()
            .map_err(|_| ScriptError::JobIdMismatch)?,
        owner_lock_hash: payload
            .owner_lock_hash()
            .as_slice()
            .try_into()
            .map_err(|_| ScriptError::InvalidData)?,
        job_lock_hash: job_lock,
        policy_script_hash: policy,
        immutable_terms_hash: terms,
    }))
}

fn immutable_terms_hash(payload: &DaoHarvestPayloadV2) -> Result<[u8; 32], ScriptError> {
    vault_terms_hash(&[
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
    .ok_or(ScriptError::ArithmeticOverflow)
}

fn validate_compensation(
    job: &JobDataV1,
    payload: &DaoHarvestPayloadV2,
    index: usize,
    source: Source,
    expected_capacity: u64,
    terminal: bool,
) -> Result<(), ScriptError> {
    let hash: [u8; 32] = job
        .payload_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::PayloadHashMismatch)?;
    validate_compensation_with_payload_hash(
        job,
        payload,
        &hash,
        index,
        source,
        expected_capacity,
        terminal,
    )
}

fn validate_compensation_with_payload_hash(
    job: &JobDataV1,
    payload: &DaoHarvestPayloadV2,
    payload_hash: &[u8; 32],
    index: usize,
    source: Source,
    expected_capacity: u64,
    terminal: bool,
) -> Result<(), ScriptError> {
    if load_cell_capacity(index, source).map_err(|_| ScriptError::InvalidCompensationCell)?
        != expected_capacity
        || load_cell_type_hash(index, source)
            .map_err(|_| ScriptError::InvalidCompensationCell)?
            .is_some()
        || !load_cell_data(index, source)
            .map_err(|_| ScriptError::InvalidCompensationCell)?
            .is_empty()
    {
        return Err(ScriptError::InvalidCompensationCell);
    }
    let lock = load_cell_lock(index, source).map_err(|_| ScriptError::InvalidCompensationCell)?;
    if lock.code_hash().as_slice() != payload.compensation_lock_code_hash().as_slice()
        || lock.hash_type().as_slice() != [2]
    {
        return Err(ScriptError::InvalidCompensationCell);
    }
    let policy = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    let expected = encode_compensation_lock_args(&CompensationLockArgsV2 {
        job_id: if terminal {
            [0_u8; 32]
        } else {
            job.job_id()
                .as_slice()
                .try_into()
                .map_err(|_| ScriptError::JobIdMismatch)?
        },
        owner_lock_hash: payload
            .owner_lock_hash()
            .as_slice()
            .try_into()
            .map_err(|_| ScriptError::InvalidData)?,
        payout_lock_hash: payload
            .payout_lock_hash()
            .as_slice()
            .try_into()
            .map_err(|_| ScriptError::InvalidData)?,
        policy_script_hash: policy,
        payload_hash: *payload_hash,
    });
    if lock.args().raw_data().as_ref() != expected {
        return Err(ScriptError::CompensationBindingMismatch);
    }
    let expected_hash =
        load_cell_lock_hash(index, source).map_err(|_| ScriptError::InvalidCompensationCell)?;
    if QueryIter::new(load_cell_lock_hash, source)
        .filter(|hash| *hash == expected_hash)
        .count()
        != 1
    {
        return Err(ScriptError::InvalidCompensationCell);
    }
    Ok(())
}

fn validate_successor_job(
    input: &JobDataV1,
    output_index: usize,
    sequence: u64,
    remaining_runs: u32,
    payload_hash: &[u8],
    progress_hash: [u8; 32],
    timing: SuccessorTiming,
) -> Result<(), ScriptError> {
    let output = load_job(output_index, Source::Output)?;
    validate_job_lock_code(output_index, Source::Output)?;
    for (left, right) in [
        (input.version().as_slice(), output.version().as_slice()),
        (input.flags().as_slice(), output.flags().as_slice()),
        (input.job_id().as_slice(), output.job_id().as_slice()),
        (input.state().as_slice(), output.state().as_slice()),
        (
            input.trigger_kind().as_slice(),
            output.trigger_kind().as_slice(),
        ),
        (
            input.policy_script_hash().as_slice(),
            output.policy_script_hash().as_slice(),
        ),
        (input.reward().as_slice(), output.reward().as_slice()),
        (
            input.remaining_budget().as_slice(),
            output.remaining_budget().as_slice(),
        ),
        (
            input.cancel_lock_hash().as_slice(),
            output.cancel_lock_hash().as_slice(),
        ),
    ] {
        if left != right {
            return Err(ScriptError::SuccessorInvariantMismatch);
        }
    }
    if read_u64(output.sequence().as_slice()) != sequence
        || read_u32(output.remaining_runs().as_slice()) != remaining_runs
        || output.payload_hash().as_slice() != payload_hash
        || output.trigger_params_hash().as_slice() != progress_hash
        || load_cell_capacity(output_index, Source::Output)
            .map_err(|_| ScriptError::CapacityNotConserved)?
            != load_cell_capacity(0, Source::GroupInput)
                .map_err(|_| ScriptError::CapacityNotConserved)?
    {
        return Err(ScriptError::SuccessorInvariantMismatch);
    }
    let input_not_before = read_u64(input.not_before().as_slice());
    let output_not_before = read_u64(output.not_before().as_slice());
    let input_not_after = read_u64(input.not_after().as_slice());
    let output_not_after = read_u64(output.not_after().as_slice());
    match timing {
        SuccessorTiming::Preserve => {
            if input_not_before != output_not_before || input_not_after != output_not_after {
                return Err(ScriptError::SuccessorInvariantMismatch);
            }
        }
        SuccessorTiming::Advance => {
            if !dao_harvest_v2_validation::is_absolute_epoch_since(output_not_before)
                || output_not_before == input_not_before
                || !dao_harvest_v2_validation::epoch_at_or_after(
                    output_not_before,
                    input_not_before,
                )
                || (input_not_after != 0
                    && dao_harvest_v2_validation::epoch_at_or_after(
                        output_not_before,
                        input_not_after,
                    ))
                || output_not_after != input_not_after
            {
                return Err(ScriptError::InvalidSince);
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum SuccessorTiming {
    Preserve,
    Advance,
}

fn load_maximum_withdraw(input_index: usize) -> Result<u64, ScriptError> {
    let witness =
        load_witness_args(input_index, Source::Input).map_err(|_| ScriptError::MissingHeader)?;
    let input_type = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::MissingHeader)?
        .raw_data();
    if input_type.len() != 8 {
        return Err(ScriptError::MissingHeader);
    }
    let deposit_header_index = read_u64(&input_type) as usize;
    let deposit_header = load_header(deposit_header_index, Source::HeaderDep)
        .map_err(|_| ScriptError::MissingHeader)?;
    let withdrawing_header =
        load_header(input_index, Source::Input).map_err(|_| ScriptError::MissingHeader)?;
    let deposit_dao = deposit_header.raw().dao().raw_data();
    let withdrawing_dao = withdrawing_header.raw().dao().raw_data();
    if deposit_dao.len() != 32 || withdrawing_dao.len() != 32 {
        return Err(ScriptError::MissingHeader);
    }
    let principal =
        load_cell_capacity(input_index, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?;
    let occupied = load_cell_occupied_capacity(input_index, Source::Input)
        .map_err(|_| ScriptError::InvalidDaoCell)?;
    dao_harvest::maximum_withdraw_capacity(
        principal,
        occupied,
        read_u64(&deposit_dao[8..16]),
        read_u64(&withdrawing_dao[8..16]),
    )
    .ok_or(ScriptError::ArithmeticOverflow)
}

fn validate_exact_plain_payout(lock_hash: &[u8], capacity: u64) -> Result<(), ScriptError> {
    let mut matches = 0;
    for (index, candidate) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if candidate.as_slice() == lock_hash
            && load_cell_capacity(index, Source::Output).map_err(|_| ScriptError::PayoutMismatch)?
                == capacity
            && load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::PayoutMismatch)?
                .is_none()
            && load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::PayoutMismatch)?
                .is_empty()
        {
            matches += 1;
        }
    }
    if matches == 1 {
        Ok(())
    } else {
        Err(ScriptError::PayoutMismatch)
    }
}

fn require_owner(context: &HarvestContext) -> Result<(), ScriptError> {
    require_lock_hash(
        index(context.witness.identity_input_index())?,
        Source::Input,
        context.payload.owner_lock_hash().as_slice(),
        ScriptError::MissingOwnerAuthorization,
    )
}

fn require_lock_hash(
    index: usize,
    source: Source,
    expected: &[u8],
    error: ScriptError,
) -> Result<(), ScriptError> {
    let actual = load_cell_lock_hash(index, source).map_err(|_| error)?;
    if actual.as_slice() == expected {
        Ok(())
    } else {
        Err(error)
    }
}

fn require_same_lock_and_type(input: usize, output: usize) -> Result<(), ScriptError> {
    let input_lock =
        load_cell_lock_hash(input, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?;
    let output_lock =
        load_cell_lock_hash(output, Source::Output).map_err(|_| ScriptError::InvalidDaoCell)?;
    let input_type =
        load_cell_type_hash(input, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?;
    let output_type =
        load_cell_type_hash(output, Source::Output).map_err(|_| ScriptError::InvalidDaoCell)?;
    if input_lock == output_lock && input_type == output_type {
        Ok(())
    } else {
        Err(ScriptError::InvalidDaoCell)
    }
}

fn validate_group_job_index(index: usize) -> Result<(), ScriptError> {
    let indexed = load_input(index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
    let grouped = load_input(0, Source::GroupInput).map_err(|_| ScriptError::MissingBoundJob)?;
    if indexed.as_slice() == grouped.as_slice() {
        Ok(())
    } else {
        Err(ScriptError::MissingBoundJob)
    }
}

fn validate_unique_job_lock(index: usize, source: Source) -> Result<(), ScriptError> {
    let expected = load_cell_lock_hash(index, source).map_err(|_| ScriptError::MissingBoundJob)?;
    if QueryIter::new(load_cell_lock_hash, source)
        .filter(|hash| *hash == expected)
        .count()
        == 1
    {
        Ok(())
    } else {
        Err(ScriptError::DuplicateJob)
    }
}

fn load_job(index: usize, source: Source) -> Result<JobDataV1, ScriptError> {
    let data = load_cell_data(index, source).map_err(|_| ScriptError::InvalidData)?;
    JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)
}

fn index<T: Entity>(value: T) -> Result<usize, ScriptError> {
    index_u32(read_u32(value.as_slice()))
}

fn index_u32(value: u32) -> Result<usize, ScriptError> {
    if value == ABSENT_INDEX {
        Err(ScriptError::OperationLayoutMismatch)
    } else {
        Ok(value as usize)
    }
}

fn operation(witness: &DaoHarvestWitnessV2) -> u8 {
    witness.operation().as_slice()[0]
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
