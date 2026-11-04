use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{
            Capacity, EpochNumberWithFraction, HeaderBuilder, ScriptHashType, TransactionBuilder,
            TransactionView,
        },
        packed::{CellInput, CellOutput, OutPoint, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};

use crate::{
    benchmarks::BenchmarkCase,
    dao_harvest::maximum_withdraw_capacity,
    dao_harvest_v2::{
        CLOSE_OPERATION, CompensationLockArgsV2, DAO_HARVEST_V2_VERSION, DEPOSITED_STATE,
        HarvestVaultLockArgsV2, RECOVER_OPERATION, ROTATE_OPERATION, SETUP_OPERATION,
        SWEEP_OPERATION, encode_compensation_lock_args, encode_harvest_vault_lock_args,
        fallback_operator_set_hash, payload_hash, progress_hash, vault_terms_hash,
    },
    error_codes::ScriptError,
    fixtures::contract_binary,
    generated::JobDataV1,
    generated_dao_harvest_v2::{
        Bytes as MoleculeBytes, DaoHarvestEnvelopeV2, DaoHarvestPayloadV2,
        DaoHarvestPrepareCreditV2, DaoHarvestProgressV2, DaoHarvestWitnessV2,
    },
};

const CKB: u64 = 100_000_000;
const PRINCIPAL: u64 = 10_000 * CKB;
const JOB_CAPACITY: u64 = 400 * CKB;
const SEED: u64 = 201 * CKB;
const EPOCH: u64 = 1 << 61;
const RELATIVE_EPOCH: u64 = (1 << 63) | EPOCH;
const ABSENT: u32 = u32::MAX;

#[derive(Clone, Copy)]
enum SetupMutation {
    None,
    Principal,
    JobId,
    Payout,
    Version,
    DuplicateJob,
    LockCode,
}

#[derive(Clone, Copy)]
enum PrepareMutation {
    None,
    Principal,
    Unauthorized,
    ForgedCredit,
    Early,
    SinceMetric,
    Progress,
}

#[derive(Clone, Copy)]
enum ClaimMutation {
    None,
    Early,
    Principal,
    FeeInflation,
    RewardLock,
    ForgedCredit,
    SinceMetric,
    Header,
    DuplicateAccumulator,
}

struct ContractCase {
    context: Context,
    transaction: TransactionView,
    compensation_fixture: Option<(CellOutput, Bytes)>,
}

fn deploy_with_args(
    context: &mut Context,
    name: &str,
    args: Bytes,
) -> (Script, ckb_testtool::ckb_types::packed::OutPoint) {
    let out_point = context.deploy_cell(contract_binary(name));
    let script = context
        .build_script_with_hash_type(&out_point, ScriptHashType::Data1, args)
        .expect("deployed script");
    (script, out_point)
}

fn always_success(context: &mut Context, discriminator: u8) -> Script {
    let out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());
    context
        .build_script_with_hash_type(
            &out_point,
            ScriptHashType::Data1,
            Bytes::from(vec![discriminator]),
        )
        .expect("always success")
}

fn molecule_bytes(value: &[u8]) -> MoleculeBytes {
    MoleculeBytes::new_builder()
        .set(value.iter().copied().map(Into::into).collect())
        .build()
}

fn dao_header(number: u64, epoch: u64, rate: u64) -> ckb_testtool::ckb_types::core::HeaderView {
    let mut dao = [0_u8; 32];
    dao[..8].copy_from_slice(&7_777_u64.to_le_bytes());
    dao[8..16].copy_from_slice(&rate.to_le_bytes());
    HeaderBuilder::default()
        .number(number)
        .epoch(EpochNumberWithFraction::new(epoch, 0, 1).full_value())
        .dao(dao.pack())
        .build()
}

#[allow(clippy::too_many_arguments)]
fn build_payload(
    owner_hash: [u8; 32],
    payout_hash: [u8; 32],
    vault_code_hash: [u8; 32],
    compensation_code_hash: [u8; 32],
    dao_type_hash: [u8; 32],
    preferred_hash: [u8; 32],
    fallback_set_hash: [u8; 32],
    version: u16,
) -> DaoHarvestPayloadV2 {
    DaoHarvestPayloadV2::new_builder()
        .version(version.to_le_bytes())
        .owner_lock_hash(owner_hash)
        .payout_lock_hash(payout_hash)
        .vault_lock_code_hash(vault_code_hash)
        .compensation_lock_code_hash(compensation_code_hash)
        .dao_type_hash(dao_type_hash)
        .principal_capacity(PRINCIPAL.to_le_bytes())
        .preferred_prepare_operator_lock_hash(preferred_hash)
        .fallback_prepare_executor_set_hash(fallback_set_hash)
        .prepare_service_fee((2 * CKB).to_le_bytes())
        .claim_service_fee((3 * CKB).to_le_bytes())
        .compensation_seed_capacity(SEED.to_le_bytes())
        .prepare_buffer_epochs((RELATIVE_EPOCH | 4).to_le_bytes())
        .takeover_delay_epochs((RELATIVE_EPOCH | (1 << 24) | (20 << 40)).to_le_bytes())
        .confirmation_margin_epochs((RELATIVE_EPOCH | 1).to_le_bytes())
        .total_cycles(2_u32.to_le_bytes())
        .end_epoch_since((EPOCH | 1_000).to_le_bytes())
        .build()
}

fn terms_hash(payload: &DaoHarvestPayloadV2) -> [u8; 32] {
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
    .expect("terms hash")
}

fn build_setup_case(mutation: SetupMutation) -> ContractCase {
    let mut context = Context::new_with_deterministic_rng();
    let owner = always_success(&mut context, 1);
    let payout = always_success(&mut context, 2);
    let preferred = always_success(&mut context, 3);
    let fallback = always_success(&mut context, 4);
    let dao_type = always_success(&mut context, 5);
    let owner_hash: [u8; 32] = owner.calc_script_hash().unpack();
    let payout_hash: [u8; 32] = payout.calc_script_hash().unpack();
    let preferred_hash: [u8; 32] = preferred.calc_script_hash().unpack();
    let fallback_hash: [u8; 32] = fallback.calc_script_hash().unpack();
    let dao_type_hash: [u8; 32] = dao_type.calc_script_hash().unpack();

    let (job_lock, job_dep) = deploy_with_args(&mut context, "job-lock-v2", Bytes::new());
    let job_code_hash: [u8; 32] = job_lock.code_hash().unpack();
    let (policy, policy_dep) = deploy_with_args(
        &mut context,
        "dao-harvest-policy-v2",
        Bytes::copy_from_slice(&job_code_hash),
    );
    let (_, vault_dep) = deploy_with_args(&mut context, "harvest-vault-lock-v2", Bytes::new());
    let vault_code_hash: [u8; 32] = context
        .build_script_with_hash_type(&vault_dep, ScriptHashType::Data1, Bytes::new())
        .unwrap()
        .code_hash()
        .unpack();
    let (_, compensation_dep) =
        deploy_with_args(&mut context, "compensation-lock-v2", Bytes::new());
    let compensation_code_hash: [u8; 32] = context
        .build_script_with_hash_type(&compensation_dep, ScriptHashType::Data1, Bytes::new())
        .unwrap()
        .code_hash()
        .unpack();
    let policy_hash: [u8; 32] = policy.calc_script_hash().unpack();
    let job_lock_hash: [u8; 32] = job_lock.calc_script_hash().unpack();

    let mut fallback_set = [fallback_hash];
    let fallback_set_hash = fallback_operator_set_hash(&mut fallback_set).unwrap();
    let payload = build_payload(
        owner_hash,
        if matches!(mutation, SetupMutation::Payout) {
            [0x77; 32]
        } else {
            payout_hash
        },
        if matches!(mutation, SetupMutation::LockCode) {
            [0x99; 32]
        } else {
            vault_code_hash
        },
        compensation_code_hash,
        dao_type_hash,
        preferred_hash,
        fallback_set_hash,
        if matches!(mutation, SetupMutation::Version) {
            1
        } else {
            DAO_HARVEST_V2_VERSION
        },
    );
    let payload_hash = payload_hash(&policy_hash, payload.as_slice()).unwrap();
    let progress = DaoHarvestProgressV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .state(DEPOSITED_STATE)
        .cycle_index(0_u32.to_le_bytes())
        .prepare_credit_hash([0_u8; 32])
        .build();
    let progress_hash = progress_hash(progress.as_slice()).unwrap();
    let job_id = if matches!(mutation, SetupMutation::JobId) {
        [0x12; 32]
    } else {
        [0x11; 32]
    };
    let job = JobDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .flags(0_u16.to_le_bytes())
        .job_id(job_id)
        .sequence(0_u64.to_le_bytes())
        .state(0)
        .trigger_kind(2_u16.to_le_bytes())
        .trigger_params_hash(progress_hash)
        .policy_script_hash(policy_hash)
        .payload_hash(payload_hash)
        .reward(0_u64.to_le_bytes())
        .remaining_budget(0_u64.to_le_bytes())
        .not_before((EPOCH | 100).to_le_bytes())
        .not_after((EPOCH | 1_000).to_le_bytes())
        .remaining_runs(2_u32.to_le_bytes())
        .cancel_lock_hash(owner_hash)
        .build();

    let vault_args = encode_harvest_vault_lock_args(&HarvestVaultLockArgsV2 {
        job_id: [0x11; 32],
        owner_lock_hash: owner_hash,
        job_lock_hash,
        policy_script_hash: policy_hash,
        immutable_terms_hash: terms_hash(&payload),
    });
    let vault = context
        .build_script_with_hash_type(
            &vault_dep,
            ScriptHashType::Data1,
            Bytes::copy_from_slice(&vault_args),
        )
        .unwrap();
    let compensation_args = encode_compensation_lock_args(&CompensationLockArgsV2 {
        job_id: [0x11; 32],
        owner_lock_hash: owner_hash,
        payout_lock_hash: payout_hash,
        policy_script_hash: policy_hash,
        payload_hash,
    });
    let compensation = context
        .build_script_with_hash_type(
            &compensation_dep,
            ScriptHashType::Data1,
            Bytes::copy_from_slice(&compensation_args),
        )
        .unwrap();
    let witness = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(SETUP_OPERATION)
        .flags(0)
        .job_input_index(ABSENT.to_le_bytes())
        .vault_input_index(ABSENT.to_le_bytes())
        .compensation_input_index(ABSENT.to_le_bytes())
        .identity_input_index(0_u32.to_le_bytes())
        .prepare_accumulator_input_index(ABSENT.to_le_bytes())
        .claim_accumulator_input_index(ABSENT.to_le_bytes())
        .job_output_index(0_u32.to_le_bytes())
        .vault_output_index(1_u32.to_le_bytes())
        .compensation_output_index(2_u32.to_le_bytes())
        .prepare_accumulator_output_index(ABSENT.to_le_bytes())
        .claim_accumulator_output_index(ABSENT.to_le_bytes())
        .payload_hash(payload_hash)
        .progress_hash(progress_hash)
        .prepare_credit_hash([0_u8; 32])
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(payload.as_slice()))
        .progress(molecule_bytes(progress.as_slice()))
        .prepare_credit(molecule_bytes(&[]))
        .operator_proof(molecule_bytes(&fallback_set.concat()))
        .successor_payload(molecule_bytes(&[]))
        .build();

    let duplicate = matches!(mutation, SetupMutation::DuplicateJob);
    let funding = context.create_cell(
        CellOutput::new_builder()
            .capacity(PRINCIPAL + JOB_CAPACITY * (1 + u64::from(duplicate)) + SEED)
            .lock(owner)
            .build(),
        Bytes::new(),
    );
    let vault_capacity = if matches!(mutation, SetupMutation::Principal) {
        PRINCIPAL - 1
    } else {
        PRINCIPAL
    };
    let compensation_output = CellOutput::new_builder()
        .capacity(SEED)
        .lock(compensation)
        .build();
    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(funding).build())
        .output(
            CellOutput::new_builder()
                .capacity(JOB_CAPACITY)
                .lock(job_lock.clone())
                .type_(Some(policy.clone()).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(vault_capacity)
                .lock(vault)
                .type_(Some(dao_type).pack())
                .build(),
        )
        .output(compensation_output.clone())
        .output_data(job.as_bytes().pack())
        .output_data(Bytes::from(vec![0; 8]).pack())
        .output_data(Bytes::new().pack())
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(witness.as_bytes()).pack())
                .output_type(Some(envelope.as_bytes()).pack())
                .build()
                .as_bytes()
                .pack(),
        );
    if duplicate {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(JOB_CAPACITY)
                    .lock(job_lock)
                    .type_(Some(policy).pack())
                    .build(),
            )
            .output_data(job.as_bytes().pack());
    }
    let transaction = context.complete_tx(builder.build());
    let _ = (job_dep, policy_dep);
    ContractCase {
        context,
        transaction,
        compensation_fixture: Some((compensation_output, Bytes::new())),
    }
}

fn build_prepare_case(mutation: PrepareMutation) -> ContractCase {
    build_prepare_case_kind(mutation, false)
}

fn build_prepare_case_kind(mutation: PrepareMutation, fallback_mode: bool) -> ContractCase {
    let setup = build_setup_case(SetupMutation::None);
    let ContractCase {
        mut context,
        transaction: setup_transaction,
        compensation_fixture,
    } = setup;
    let setup_outputs: Vec<_> = setup_transaction.outputs().into_iter().collect();
    let setup_data: Vec<_> = setup_transaction.outputs_data().into_iter().collect();
    let job_cell = context.create_cell(setup_outputs[0].clone(), setup_data[0].raw_data());
    let vault_cell = context.create_cell(setup_outputs[1].clone(), setup_data[1].raw_data());
    let job = JobDataV1::from_slice(&setup_data[0].raw_data()).unwrap();
    let setup_witness =
        WitnessArgs::from_slice(&setup_transaction.witnesses().get(0).unwrap().raw_data()).unwrap();
    let setup_envelope =
        DaoHarvestEnvelopeV2::from_slice(&setup_witness.output_type().to_opt().unwrap().raw_data())
            .unwrap();
    let payload_bytes = setup_envelope.payload().raw_data();
    let input_progress =
        DaoHarvestProgressV2::from_slice(&setup_envelope.progress().raw_data()).unwrap();

    let preferred = always_success(&mut context, if fallback_mode { 4 } else { 3 });
    let operator = if matches!(mutation, PrepareMutation::Unauthorized) {
        always_success(&mut context, 9)
    } else {
        preferred
    };
    let operator_hash: [u8; 32] = operator.calc_script_hash().unpack();
    let operator_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(300 * CKB)
            .lock(operator.clone())
            .build(),
        Bytes::new(),
    );
    let credit = DaoHarvestPrepareCreditV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .job_id(<[u8; 32]>::try_from(job.job_id().as_slice()).unwrap())
        .cycle_index(input_progress.cycle_index())
        .preparer_lock_hash(if matches!(mutation, PrepareMutation::ForgedCredit) {
            [0x91; 32]
        } else {
            operator_hash
        })
        .prepared_vault_output_index(1_u32.to_le_bytes())
        .job_output_index(0_u32.to_le_bytes())
        .build();
    let credit_hash = crate::dao_harvest_v2::prepare_credit_hash(credit.as_slice()).unwrap();
    let successor_progress = DaoHarvestProgressV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .state(if matches!(mutation, PrepareMutation::Progress) {
            DEPOSITED_STATE
        } else {
            crate::dao_harvest_v2::WITHDRAWING_STATE
        })
        .cycle_index(input_progress.cycle_index())
        .prepare_credit_hash(credit_hash)
        .build();
    let successor_progress_hash = progress_hash(successor_progress.as_slice()).unwrap();
    let next_since = if matches!(mutation, PrepareMutation::SinceMetric) {
        180
    } else {
        EPOCH | 180
    };
    let successor_job = job
        .clone()
        .as_builder()
        .sequence(1_u64.to_le_bytes())
        .trigger_params_hash(successor_progress_hash)
        .not_before(next_since.to_le_bytes())
        .build();
    let request = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(if fallback_mode {
            crate::dao_harvest_v2::FALLBACK_PREPARE_OPERATION
        } else {
            crate::dao_harvest_v2::PREFERRED_PREPARE_OPERATION
        })
        .flags(0)
        .job_input_index(0_u32.to_le_bytes())
        .vault_input_index(1_u32.to_le_bytes())
        .compensation_input_index(ABSENT.to_le_bytes())
        .identity_input_index(2_u32.to_le_bytes())
        .prepare_accumulator_input_index(ABSENT.to_le_bytes())
        .claim_accumulator_input_index(ABSENT.to_le_bytes())
        .job_output_index(0_u32.to_le_bytes())
        .vault_output_index(1_u32.to_le_bytes())
        .compensation_output_index(ABSENT.to_le_bytes())
        .prepare_accumulator_output_index(ABSENT.to_le_bytes())
        .claim_accumulator_output_index(ABSENT.to_le_bytes())
        .payload_hash(<[u8; 32]>::try_from(job.payload_hash().as_slice()).unwrap())
        .progress_hash(<[u8; 32]>::try_from(job.trigger_params_hash().as_slice()).unwrap())
        .prepare_credit_hash(credit_hash)
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&payload_bytes))
        .progress(molecule_bytes(input_progress.as_slice()))
        .prepare_credit(molecule_bytes(credit.as_slice()))
        .operator_proof(if fallback_mode {
            setup_envelope.operator_proof()
        } else {
            molecule_bytes(&[])
        })
        .successor_payload(molecule_bytes(&[]))
        .build();
    let input_since = if fallback_mode {
        if matches!(mutation, PrepareMutation::Early) {
            EPOCH | 100
        } else {
            EPOCH | 101
        }
    } else if matches!(mutation, PrepareMutation::Early) {
        EPOCH | 99
    } else {
        EPOCH | 100
    };
    let output_principal = if matches!(mutation, PrepareMutation::Principal) {
        PRINCIPAL - 1
    } else {
        PRINCIPAL
    };
    let transaction = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .since(input_since)
                .previous_output(job_cell)
                .build(),
        )
        .input(CellInput::new_builder().previous_output(vault_cell).build())
        .input(
            CellInput::new_builder()
                .previous_output(operator_cell)
                .build(),
        )
        .output(setup_outputs[0].clone())
        .output(
            setup_outputs[1]
                .clone()
                .as_builder()
                .capacity(output_principal)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(299 * CKB)
                .lock(operator)
                .build(),
        )
        .output_data(successor_job.as_bytes().pack())
        .output_data(Bytes::copy_from_slice(&42_u64.to_le_bytes()).pack())
        .output_data(Bytes::new().pack())
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(request.as_bytes()).pack())
                .output_type(Some(envelope.as_bytes()).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    ContractCase {
        context,
        transaction,
        compensation_fixture,
    }
}

fn build_claim_case(mutation: ClaimMutation) -> ContractCase {
    build_claim_case_kind(mutation, false, false, false)
}

fn build_claim_case_kind(
    mutation: ClaimMutation,
    terminal: bool,
    fallback_claim: bool,
    owner_complete: bool,
) -> ContractCase {
    assert!(!(terminal && (fallback_claim || owner_complete)));
    assert!(!(fallback_claim && owner_complete));
    let prepared = build_prepare_case(PrepareMutation::None);
    let ContractCase {
        mut context,
        transaction: prepare_transaction,
        compensation_fixture,
    } = prepared;
    let outputs: Vec<_> = prepare_transaction.outputs().into_iter().collect();
    let mut output_data: Vec<_> = prepare_transaction.outputs_data().into_iter().collect();
    if terminal {
        let terminal_job = JobDataV1::from_slice(&output_data[0].raw_data())
            .unwrap()
            .as_builder()
            .remaining_runs(1_u32.to_le_bytes())
            .build();
        output_data[0] = terminal_job.as_bytes().pack();
    }
    let shared_hash = [0x55; 32];
    let job_out_point = OutPoint::new_builder()
        .tx_hash(shared_hash.pack())
        .index(0_u32)
        .build();
    let vault_out_point = OutPoint::new_builder()
        .tx_hash(shared_hash.pack())
        .index(1_u32)
        .build();
    context.create_cell_with_out_point(
        job_out_point.clone(),
        outputs[0].clone(),
        output_data[0].raw_data(),
    );
    context.create_cell_with_out_point(
        vault_out_point.clone(),
        outputs[1].clone(),
        output_data[1].raw_data(),
    );
    let job_input = CellInput::new_builder()
        .previous_output(job_out_point)
        .build();
    let vault_input = CellInput::new_builder()
        .since(if matches!(mutation, ClaimMutation::SinceMetric) {
            180
        } else if matches!(mutation, ClaimMutation::Early) {
            EPOCH | if fallback_claim { 180 } else { 179 }
        } else if fallback_claim {
            EPOCH | 181
        } else {
            EPOCH | 180
        })
        .previous_output(vault_out_point.clone())
        .build();
    let (compensation_output, compensation_data) = compensation_fixture.unwrap();
    let compensation_cell = context.create_cell(compensation_output.clone(), compensation_data);

    let prepare_witness =
        WitnessArgs::from_slice(&prepare_transaction.witnesses().get(0).unwrap().raw_data())
            .unwrap();
    let prepare_envelope = DaoHarvestEnvelopeV2::from_slice(
        &prepare_witness.output_type().to_opt().unwrap().raw_data(),
    )
    .unwrap();
    let payload_bytes = prepare_envelope.payload().raw_data();
    let canonical_credit =
        DaoHarvestPrepareCreditV2::from_slice(&prepare_envelope.prepare_credit().raw_data())
            .unwrap();
    let claim_credit = if matches!(mutation, ClaimMutation::ForgedCredit) {
        canonical_credit
            .clone()
            .as_builder()
            .job_id([0x99; 32])
            .build()
    } else {
        canonical_credit.clone()
    };
    let claim_credit_hash =
        crate::dao_harvest_v2::prepare_credit_hash(claim_credit.as_slice()).unwrap();
    let input_progress = DaoHarvestProgressV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .state(crate::dao_harvest_v2::WITHDRAWING_STATE)
        .cycle_index(0_u32.to_le_bytes())
        .prepare_credit_hash(
            crate::dao_harvest_v2::prepare_credit_hash(canonical_credit.as_slice()).unwrap(),
        )
        .build();
    let job = JobDataV1::from_slice(&output_data[0].raw_data()).unwrap();
    assert_eq!(
        job.trigger_params_hash().as_slice(),
        progress_hash(input_progress.as_slice()).unwrap()
    );

    let operator = always_success(&mut context, 3);
    let claimant = always_success(&mut context, 11);
    let owner = always_success(&mut context, 1);
    let wrong_reward = always_success(&mut context, 12);
    let funding_lock = always_success(&mut context, 10);
    let operator_hash: [u8; 32] = operator.calc_script_hash().unpack();
    assert_eq!(
        operator_hash.as_slice(),
        canonical_credit.preparer_lock_hash().as_slice()
    );
    let accumulator_capacity = 300 * CKB;
    let accumulator_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(accumulator_capacity)
            .lock(operator.clone())
            .build(),
        Bytes::new(),
    );
    let claim_accumulator_capacity = 320 * CKB;
    let claim_accumulator_cell = fallback_claim.then(|| {
        context.create_cell(
            CellOutput::new_builder()
                .capacity(claim_accumulator_capacity)
                .lock(claimant.clone())
                .build(),
            Bytes::new(),
        )
    });
    let owner_cell = owner_complete.then(|| {
        context.create_cell(
            CellOutput::new_builder()
                .capacity(300 * CKB)
                .lock(owner)
                .build(),
            Bytes::new(),
        )
    });
    let funding_capacity = 2_000 * CKB;
    let funding_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(funding_capacity)
            .lock(funding_lock.clone())
            .build(),
        Bytes::new(),
    );

    let deposit_rate = if matches!(mutation, ClaimMutation::Header) {
        900
    } else {
        1_000
    };
    let withdraw_rate = 1_100;
    let deposit_header = dao_header(42, 1, deposit_rate);
    let withdrawing_header = dao_header(84, 180, withdraw_rate);
    context.insert_header(deposit_header.clone());
    context.insert_header(withdrawing_header.clone());
    context.link_cell_with_block(vault_out_point, withdrawing_header.hash(), 0);
    let occupied = outputs[1]
        .occupied_capacity(Capacity::bytes(8).unwrap())
        .unwrap()
        .as_u64();
    let canonical_maximum =
        maximum_withdraw_capacity(PRINCIPAL, occupied, 1_000, withdraw_rate).unwrap();
    let gross = canonical_maximum - PRINCIPAL;
    let prepare_fee = 2 * CKB;
    let claim_fee = 3 * CKB;
    let owner_compensation = gross - prepare_fee - if owner_complete { 0 } else { claim_fee };
    let inflation = u64::from(matches!(mutation, ClaimMutation::FeeInflation));
    let duplicate_capacity = if matches!(mutation, ClaimMutation::DuplicateAccumulator) {
        100 * CKB
    } else {
        0
    };
    let principal_remainder = u64::from(matches!(mutation, ClaimMutation::Principal));

    let successor_progress = DaoHarvestProgressV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .state(DEPOSITED_STATE)
        .cycle_index(1_u32.to_le_bytes())
        .prepare_credit_hash([0_u8; 32])
        .build();
    let successor_job = job
        .clone()
        .as_builder()
        .sequence(2_u64.to_le_bytes())
        .trigger_params_hash(progress_hash(successor_progress.as_slice()).unwrap())
        .not_before((EPOCH | 360).to_le_bytes())
        .remaining_runs(1_u32.to_le_bytes())
        .build();
    let request = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(if owner_complete {
            crate::dao_harvest_v2::OWNER_COMPLETE_OPERATION
        } else if fallback_claim {
            crate::dao_harvest_v2::FALLBACK_CLAIM_OPERATION
        } else {
            crate::dao_harvest_v2::PREFERRED_CLAIM_OPERATION
        })
        .flags(0)
        .job_input_index(0_u32.to_le_bytes())
        .vault_input_index(1_u32.to_le_bytes())
        .compensation_input_index(2_u32.to_le_bytes())
        .identity_input_index(
            if fallback_claim || owner_complete {
                4_u32
            } else {
                3_u32
            }
            .to_le_bytes(),
        )
        .prepare_accumulator_input_index(3_u32.to_le_bytes())
        .claim_accumulator_input_index(if fallback_claim { 4_u32 } else { ABSENT }.to_le_bytes())
        .job_output_index(if terminal { ABSENT } else { 0 }.to_le_bytes())
        .vault_output_index(if terminal { 0_u32 } else { 1_u32 }.to_le_bytes())
        .compensation_output_index(if terminal { 1_u32 } else { 2_u32 }.to_le_bytes())
        .prepare_accumulator_output_index(if terminal { 2_u32 } else { 3_u32 }.to_le_bytes())
        .claim_accumulator_output_index(if fallback_claim { 4_u32 } else { ABSENT }.to_le_bytes())
        .payload_hash(<[u8; 32]>::try_from(job.payload_hash().as_slice()).unwrap())
        .progress_hash(<[u8; 32]>::try_from(job.trigger_params_hash().as_slice()).unwrap())
        .prepare_credit_hash(claim_credit_hash)
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&payload_bytes))
        .progress(molecule_bytes(input_progress.as_slice()))
        .prepare_credit(molecule_bytes(claim_credit.as_slice()))
        .operator_proof(molecule_bytes(&[]))
        .successor_payload(molecule_bytes(&[]))
        .build();

    let funding_change = funding_capacity
        .checked_sub(gross)
        .and_then(|value| value.checked_sub(CKB))
        .and_then(|value| value.checked_sub(inflation))
        .and_then(|value| value.checked_sub(duplicate_capacity))
        .and_then(|value| value.checked_add(principal_remainder))
        .unwrap();
    let accumulator_lock = if matches!(mutation, ClaimMutation::RewardLock) {
        wrong_reward
    } else {
        operator.clone()
    };
    let terminal_vault = if terminal {
        let mut args = outputs[1].lock().args().raw_data().to_vec();
        args[64..96].fill(0);
        outputs[1]
            .clone()
            .as_builder()
            .capacity(PRINCIPAL - principal_remainder)
            .lock(
                outputs[1]
                    .lock()
                    .as_builder()
                    .args(Bytes::from(args).pack())
                    .build(),
            )
            .build()
    } else {
        outputs[1]
            .clone()
            .as_builder()
            .capacity(PRINCIPAL - principal_remainder)
            .build()
    };
    let mut builder = TransactionBuilder::default()
        .input(job_input)
        .input(vault_input)
        .input(
            CellInput::new_builder()
                .previous_output(compensation_cell)
                .build(),
        )
        .input(
            CellInput::new_builder()
                .previous_output(accumulator_cell)
                .build(),
        );
    if let Some(claim_accumulator_cell) = claim_accumulator_cell {
        builder = builder.input(
            CellInput::new_builder()
                .since(EPOCH | 181)
                .previous_output(claim_accumulator_cell)
                .build(),
        );
    }
    if let Some(owner_cell) = owner_cell {
        builder = builder.input(CellInput::new_builder().previous_output(owner_cell).build());
    }
    builder = builder.input(
        CellInput::new_builder()
            .previous_output(funding_cell)
            .build(),
    );
    let compensation_successor = compensation_output
        .clone()
        .as_builder()
        .capacity(SEED + owner_compensation)
        .build();
    let compensation_successor = if terminal {
        let mut args = compensation_successor.lock().args().raw_data().to_vec();
        args[..32].fill(0);
        compensation_successor
            .clone()
            .as_builder()
            .lock(
                compensation_successor
                    .lock()
                    .as_builder()
                    .args(Bytes::from(args).pack())
                    .build(),
            )
            .build()
    } else {
        compensation_successor
    };
    let accumulator_successor = CellOutput::new_builder()
        .capacity(
            accumulator_capacity
                + prepare_fee
                + if fallback_claim || owner_complete {
                    0
                } else {
                    claim_fee
                }
                + inflation,
        )
        .lock(accumulator_lock)
        .build();
    let claim_accumulator_successor = CellOutput::new_builder()
        .capacity(claim_accumulator_capacity + claim_fee)
        .lock(claimant)
        .build();
    let funding_successor = CellOutput::new_builder()
        .capacity(funding_change)
        .lock(funding_lock)
        .build();
    let mut builder = if terminal {
        builder
            .output(terminal_vault)
            .output(compensation_successor)
            .output(accumulator_successor)
            .output(funding_successor)
            .output_data(Bytes::from(vec![0; 8]).pack())
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
    } else {
        let builder = builder
            .output(outputs[0].clone())
            .output(terminal_vault)
            .output(compensation_successor)
            .output(accumulator_successor)
            .outputs(if fallback_claim {
                vec![claim_accumulator_successor, funding_successor]
            } else {
                vec![funding_successor]
            })
            .output_data(successor_job.as_bytes().pack())
            .output_data(Bytes::from(vec![0; 8]).pack())
            .output_data(Bytes::new().pack());
        if fallback_claim {
            builder
                .output_data(Bytes::new().pack())
                .output_data(Bytes::new().pack())
                .output_data(Bytes::new().pack())
        } else {
            builder
                .output_data(Bytes::new().pack())
                .output_data(Bytes::new().pack())
        }
    };
    builder = builder
        .header_dep(deposit_header.hash())
        .header_dep(withdrawing_header.hash())
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(request.as_bytes()).pack())
                .output_type(Some(envelope.as_bytes()).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .witness(
            WitnessArgs::new_builder()
                .input_type(Some(Bytes::copy_from_slice(&0_u64.to_le_bytes())).pack())
                .build()
                .as_bytes()
                .pack(),
        )
        .witness(WitnessArgs::default().as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack())
        .witness(WitnessArgs::default().as_bytes().pack());
    if duplicate_capacity != 0 {
        builder = builder
            .output(
                CellOutput::new_builder()
                    .capacity(duplicate_capacity)
                    .lock(operator)
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }
    let transaction = context.complete_tx(builder.build());
    ContractCase {
        context,
        transaction,
        compensation_fixture: None,
    }
}

fn build_terminal_close_case(owner_authorized: bool) -> ContractCase {
    let terminal = build_claim_case_kind(ClaimMutation::None, true, false, false);
    let ContractCase {
        mut context,
        transaction: terminal_transaction,
        ..
    } = terminal;
    let compensation_output = terminal_transaction.outputs().get(1).unwrap();
    let compensation_data = terminal_transaction
        .outputs_data()
        .get(1)
        .unwrap()
        .raw_data();
    let compensation_cell = context.create_cell(compensation_output.clone(), compensation_data);
    let owner = always_success(&mut context, if owner_authorized { 1 } else { 13 });
    let payout = always_success(&mut context, 2);
    let owner_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100 * CKB)
            .lock(owner)
            .build(),
        Bytes::new(),
    );
    let terminal_witness =
        WitnessArgs::from_slice(&terminal_transaction.witnesses().get(0).unwrap().raw_data())
            .unwrap();
    let terminal_envelope = DaoHarvestEnvelopeV2::from_slice(
        &terminal_witness.output_type().to_opt().unwrap().raw_data(),
    )
    .unwrap();
    let payload_bytes = terminal_envelope.payload().raw_data();
    let payload = DaoHarvestPayloadV2::from_slice(&payload_bytes).unwrap();
    assert_eq!(
        payload.payout_lock_hash().as_slice(),
        payout.calc_script_hash().as_slice()
    );
    let args = compensation_output.lock().args().raw_data();
    let committed_payload: [u8; 32] = args[128..160].try_into().unwrap();
    let request = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(CLOSE_OPERATION)
        .flags(0)
        .job_input_index(ABSENT.to_le_bytes())
        .vault_input_index(ABSENT.to_le_bytes())
        .compensation_input_index(0_u32.to_le_bytes())
        .identity_input_index(1_u32.to_le_bytes())
        .prepare_accumulator_input_index(ABSENT.to_le_bytes())
        .claim_accumulator_input_index(ABSENT.to_le_bytes())
        .job_output_index(ABSENT.to_le_bytes())
        .vault_output_index(ABSENT.to_le_bytes())
        .compensation_output_index(ABSENT.to_le_bytes())
        .prepare_accumulator_output_index(ABSENT.to_le_bytes())
        .claim_accumulator_output_index(ABSENT.to_le_bytes())
        .payload_hash(committed_payload)
        .progress_hash([0_u8; 32])
        .prepare_credit_hash([0_u8; 32])
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&payload_bytes))
        .progress(molecule_bytes(&[]))
        .prepare_credit(molecule_bytes(&[]))
        .operator_proof(molecule_bytes(&[]))
        .successor_payload(molecule_bytes(&[]))
        .build();
    let transaction = context.complete_tx(
        TransactionBuilder::default()
            .input(
                CellInput::new_builder()
                    .previous_output(compensation_cell)
                    .build(),
            )
            .input(CellInput::new_builder().previous_output(owner_cell).build())
            .output(
                CellOutput::new_builder()
                    .capacity(compensation_output.capacity())
                    .lock(payout)
                    .build(),
            )
            .output_data(Bytes::new().pack())
            .witness(
                WitnessArgs::new_builder()
                    .input_type(Some(request.as_bytes()).pack())
                    .output_type(Some(envelope.as_bytes()).pack())
                    .build()
                    .as_bytes()
                    .pack(),
            )
            .witness(WitnessArgs::default().as_bytes().pack())
            .build(),
    );
    ContractCase {
        context,
        transaction,
        compensation_fixture: None,
    }
}

fn build_terminal_vault_exit_case(owner_authorized: bool) -> ContractCase {
    let terminal = build_claim_case_kind(ClaimMutation::None, true, false, false);
    let ContractCase {
        mut context,
        transaction: terminal_transaction,
        ..
    } = terminal;
    let vault_output = terminal_transaction.outputs().get(0).unwrap();
    let vault_data = terminal_transaction
        .outputs_data()
        .get(0)
        .unwrap()
        .raw_data();
    let vault_cell = context.create_cell(vault_output.clone(), vault_data);
    let owner = always_success(&mut context, if owner_authorized { 1 } else { 13 });
    let owner_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100 * CKB)
            .lock(owner.clone())
            .build(),
        Bytes::new(),
    );
    let transaction = context.complete_tx(
        TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(vault_cell).build())
            .input(CellInput::new_builder().previous_output(owner_cell).build())
            .output(
                CellOutput::new_builder()
                    .capacity(PRINCIPAL)
                    .lock(owner)
                    .build(),
            )
            .output_data(Bytes::new().pack())
            .build(),
    );
    ContractCase {
        context,
        transaction,
        compensation_fixture: None,
    }
}

fn build_owner_maintenance_case(recovery: bool) -> ContractCase {
    let setup = build_setup_case(SetupMutation::None);
    let ContractCase {
        mut context,
        transaction: setup_transaction,
        compensation_fixture,
    } = setup;
    let outputs: Vec<_> = setup_transaction.outputs().into_iter().collect();
    let output_data: Vec<_> = setup_transaction.outputs_data().into_iter().collect();
    let job_cell = context.create_cell(outputs[0].clone(), output_data[0].raw_data());
    let vault_cell = context.create_cell(outputs[1].clone(), output_data[1].raw_data());
    let (base_compensation, compensation_data) = compensation_fixture.unwrap();
    let compensation_capacity = if recovery { SEED } else { SEED + 50 * CKB };
    let compensation_input = base_compensation
        .clone()
        .as_builder()
        .capacity(compensation_capacity)
        .build();
    let compensation_cell = context.create_cell(compensation_input, compensation_data);
    let owner = always_success(&mut context, 1);
    let payout = always_success(&mut context, 2);
    let owner_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(300 * CKB)
            .lock(owner.clone())
            .build(),
        Bytes::new(),
    );
    let setup_witness =
        WitnessArgs::from_slice(&setup_transaction.witnesses().get(0).unwrap().raw_data()).unwrap();
    let setup_envelope =
        DaoHarvestEnvelopeV2::from_slice(&setup_witness.output_type().to_opt().unwrap().raw_data())
            .unwrap();
    let payload_bytes = setup_envelope.payload().raw_data();
    let progress_bytes = setup_envelope.progress().raw_data();
    let job = JobDataV1::from_slice(&output_data[0].raw_data()).unwrap();
    let request = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(if recovery {
            RECOVER_OPERATION
        } else {
            SWEEP_OPERATION
        })
        .flags(0)
        .job_input_index(0_u32.to_le_bytes())
        .vault_input_index(if recovery { 1_u32 } else { ABSENT }.to_le_bytes())
        .compensation_input_index(if recovery { 2_u32 } else { 1_u32 }.to_le_bytes())
        .identity_input_index(if recovery { 3_u32 } else { 2_u32 }.to_le_bytes())
        .prepare_accumulator_input_index(ABSENT.to_le_bytes())
        .claim_accumulator_input_index(ABSENT.to_le_bytes())
        .job_output_index(if recovery { ABSENT } else { 0_u32 }.to_le_bytes())
        .vault_output_index(ABSENT.to_le_bytes())
        .compensation_output_index(if recovery { ABSENT } else { 1_u32 }.to_le_bytes())
        .prepare_accumulator_output_index(ABSENT.to_le_bytes())
        .claim_accumulator_output_index(ABSENT.to_le_bytes())
        .payload_hash(<[u8; 32]>::try_from(job.payload_hash().as_slice()).unwrap())
        .progress_hash(<[u8; 32]>::try_from(job.trigger_params_hash().as_slice()).unwrap())
        .prepare_credit_hash([0_u8; 32])
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&payload_bytes))
        .progress(molecule_bytes(&progress_bytes))
        .prepare_credit(molecule_bytes(&[]))
        .operator_proof(molecule_bytes(&[]))
        .successor_payload(molecule_bytes(&[]))
        .build();
    let mut builder = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(job_cell).build());
    if recovery {
        builder = builder.input(CellInput::new_builder().previous_output(vault_cell).build());
    }
    builder = builder
        .input(
            CellInput::new_builder()
                .previous_output(compensation_cell)
                .build(),
        )
        .input(CellInput::new_builder().previous_output(owner_cell).build());
    builder = if recovery {
        builder
            .output(
                CellOutput::new_builder()
                    .capacity(JOB_CAPACITY + PRINCIPAL + SEED)
                    .lock(owner)
                    .build(),
            )
            .output_data(Bytes::new().pack())
    } else {
        builder
            .output(outputs[0].clone())
            .output(base_compensation)
            .output(
                CellOutput::new_builder()
                    .capacity(50 * CKB)
                    .lock(payout)
                    .build(),
            )
            .output_data(output_data[0].clone())
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
    };
    let transaction = context.complete_tx(
        builder
            .witness(
                WitnessArgs::new_builder()
                    .input_type(Some(request.as_bytes()).pack())
                    .output_type(Some(envelope.as_bytes()).pack())
                    .build()
                    .as_bytes()
                    .pack(),
            )
            .build(),
    );
    ContractCase {
        context,
        transaction,
        compensation_fixture: None,
    }
}

fn build_rotation_case(mutate_fee: bool) -> ContractCase {
    let setup = build_setup_case(SetupMutation::None);
    let ContractCase {
        mut context,
        transaction: setup_transaction,
        compensation_fixture,
    } = setup;
    let outputs: Vec<_> = setup_transaction.outputs().into_iter().collect();
    let output_data: Vec<_> = setup_transaction.outputs_data().into_iter().collect();
    let job_cell = context.create_cell(outputs[0].clone(), output_data[0].raw_data());
    let (compensation, compensation_data) = compensation_fixture.unwrap();
    let compensation_cell = context.create_cell(compensation.clone(), compensation_data);
    let owner = always_success(&mut context, 1);
    let next_preferred = always_success(&mut context, 14);
    let next_fallback = always_success(&mut context, 15);
    let owner_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(300 * CKB)
            .lock(owner)
            .build(),
        Bytes::new(),
    );
    let setup_witness =
        WitnessArgs::from_slice(&setup_transaction.witnesses().get(0).unwrap().raw_data()).unwrap();
    let setup_envelope =
        DaoHarvestEnvelopeV2::from_slice(&setup_witness.output_type().to_opt().unwrap().raw_data())
            .unwrap();
    let payload_bytes = setup_envelope.payload().raw_data();
    let payload = DaoHarvestPayloadV2::from_slice(&payload_bytes).unwrap();
    let next_preferred_hash: [u8; 32] = next_preferred.calc_script_hash().unpack();
    let next_fallback_hash: [u8; 32] = next_fallback.calc_script_hash().unpack();
    let mut next_set = [next_fallback_hash];
    let next_set_hash = fallback_operator_set_hash(&mut next_set).unwrap();
    let mut successor_builder = payload
        .clone()
        .as_builder()
        .preferred_prepare_operator_lock_hash(next_preferred_hash)
        .fallback_prepare_executor_set_hash(next_set_hash);
    if mutate_fee {
        successor_builder = successor_builder.prepare_service_fee((3 * CKB).to_le_bytes());
    }
    let successor_payload = successor_builder.build();
    let job = JobDataV1::from_slice(&output_data[0].raw_data()).unwrap();
    let policy_hash: [u8; 32] = job.policy_script_hash().as_slice().try_into().unwrap();
    let successor_hash = payload_hash(&policy_hash, successor_payload.as_slice()).unwrap();
    let successor_job = job
        .clone()
        .as_builder()
        .payload_hash(successor_hash)
        .build();
    let mut compensation_args = compensation.lock().args().raw_data().to_vec();
    compensation_args[128..160].copy_from_slice(&successor_hash);
    let successor_compensation = compensation
        .clone()
        .as_builder()
        .lock(
            compensation
                .lock()
                .as_builder()
                .args(Bytes::from(compensation_args).pack())
                .build(),
        )
        .build();
    let request = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(ROTATE_OPERATION)
        .flags(0)
        .job_input_index(0_u32.to_le_bytes())
        .vault_input_index(ABSENT.to_le_bytes())
        .compensation_input_index(1_u32.to_le_bytes())
        .identity_input_index(2_u32.to_le_bytes())
        .prepare_accumulator_input_index(ABSENT.to_le_bytes())
        .claim_accumulator_input_index(ABSENT.to_le_bytes())
        .job_output_index(0_u32.to_le_bytes())
        .vault_output_index(ABSENT.to_le_bytes())
        .compensation_output_index(1_u32.to_le_bytes())
        .prepare_accumulator_output_index(ABSENT.to_le_bytes())
        .claim_accumulator_output_index(ABSENT.to_le_bytes())
        .payload_hash(<[u8; 32]>::try_from(job.payload_hash().as_slice()).unwrap())
        .progress_hash(<[u8; 32]>::try_from(job.trigger_params_hash().as_slice()).unwrap())
        .prepare_credit_hash([0_u8; 32])
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&payload_bytes))
        .progress(setup_envelope.progress())
        .prepare_credit(molecule_bytes(&[]))
        .operator_proof(molecule_bytes(&next_fallback_hash))
        .successor_payload(molecule_bytes(successor_payload.as_slice()))
        .build();
    let transaction = context.complete_tx(
        TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(job_cell).build())
            .input(
                CellInput::new_builder()
                    .previous_output(compensation_cell)
                    .build(),
            )
            .input(CellInput::new_builder().previous_output(owner_cell).build())
            .output(outputs[0].clone())
            .output(successor_compensation)
            .output_data(successor_job.as_bytes().pack())
            .output_data(Bytes::new().pack())
            .witness(
                WitnessArgs::new_builder()
                    .input_type(Some(request.as_bytes()).pack())
                    .output_type(Some(envelope.as_bytes()).pack())
                    .build()
                    .as_bytes()
                    .pack(),
            )
            .build(),
    );
    ContractCase {
        context,
        transaction,
        compensation_fixture: None,
    }
}

fn build_withdrawing_recovery_case() -> ContractCase {
    let prepared = build_prepare_case(PrepareMutation::None);
    let ContractCase {
        mut context,
        transaction: prepare_transaction,
        compensation_fixture,
    } = prepared;
    let outputs: Vec<_> = prepare_transaction.outputs().into_iter().collect();
    let output_data: Vec<_> = prepare_transaction.outputs_data().into_iter().collect();
    let shared_hash = [0x66; 32];
    let job_out_point = OutPoint::new_builder()
        .tx_hash(shared_hash.pack())
        .index(0_u32)
        .build();
    let vault_out_point = OutPoint::new_builder()
        .tx_hash(shared_hash.pack())
        .index(1_u32)
        .build();
    context.create_cell_with_out_point(
        job_out_point.clone(),
        outputs[0].clone(),
        output_data[0].raw_data(),
    );
    context.create_cell_with_out_point(
        vault_out_point.clone(),
        outputs[1].clone(),
        output_data[1].raw_data(),
    );
    let (compensation, compensation_data) = compensation_fixture.unwrap();
    let compensation_cell = context.create_cell(compensation, compensation_data);
    let owner = always_success(&mut context, 1);
    let preparer = always_success(&mut context, 3);
    let funding = always_success(&mut context, 10);
    let owner_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(300 * CKB)
            .lock(owner.clone())
            .build(),
        Bytes::new(),
    );
    let accumulator_capacity = 300 * CKB;
    let accumulator_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(accumulator_capacity)
            .lock(preparer.clone())
            .build(),
        Bytes::new(),
    );
    let funding_capacity = 2_000 * CKB;
    let funding_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(funding_capacity)
            .lock(funding.clone())
            .build(),
        Bytes::new(),
    );
    let prepare_witness =
        WitnessArgs::from_slice(&prepare_transaction.witnesses().get(0).unwrap().raw_data())
            .unwrap();
    let prepare_envelope = DaoHarvestEnvelopeV2::from_slice(
        &prepare_witness.output_type().to_opt().unwrap().raw_data(),
    )
    .unwrap();
    let payload_bytes = prepare_envelope.payload().raw_data();
    let credit_bytes = prepare_envelope.prepare_credit().raw_data();
    let credit_hash = crate::dao_harvest_v2::prepare_credit_hash(&credit_bytes).unwrap();
    let progress = DaoHarvestProgressV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .state(crate::dao_harvest_v2::WITHDRAWING_STATE)
        .cycle_index(0_u32.to_le_bytes())
        .prepare_credit_hash(credit_hash)
        .build();
    let job = JobDataV1::from_slice(&output_data[0].raw_data()).unwrap();
    let request = DaoHarvestWitnessV2::new_builder()
        .version(DAO_HARVEST_V2_VERSION.to_le_bytes())
        .operation(RECOVER_OPERATION)
        .flags(0)
        .job_input_index(0_u32.to_le_bytes())
        .vault_input_index(1_u32.to_le_bytes())
        .compensation_input_index(2_u32.to_le_bytes())
        .identity_input_index(3_u32.to_le_bytes())
        .prepare_accumulator_input_index(4_u32.to_le_bytes())
        .claim_accumulator_input_index(ABSENT.to_le_bytes())
        .job_output_index(ABSENT.to_le_bytes())
        .vault_output_index(ABSENT.to_le_bytes())
        .compensation_output_index(ABSENT.to_le_bytes())
        .prepare_accumulator_output_index(1_u32.to_le_bytes())
        .claim_accumulator_output_index(ABSENT.to_le_bytes())
        .payload_hash(<[u8; 32]>::try_from(job.payload_hash().as_slice()).unwrap())
        .progress_hash(<[u8; 32]>::try_from(job.trigger_params_hash().as_slice()).unwrap())
        .prepare_credit_hash(credit_hash)
        .build();
    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&payload_bytes))
        .progress(molecule_bytes(progress.as_slice()))
        .prepare_credit(molecule_bytes(&credit_bytes))
        .operator_proof(molecule_bytes(&[]))
        .successor_payload(molecule_bytes(&[]))
        .build();
    let deposit_header = dao_header(42, 1, 1_000);
    let withdrawing_header = dao_header(84, 180, 1_100);
    context.insert_header(deposit_header.clone());
    context.insert_header(withdrawing_header.clone());
    context.link_cell_with_block(vault_out_point.clone(), withdrawing_header.hash(), 0);
    let occupied = outputs[1]
        .occupied_capacity(Capacity::bytes(8).unwrap())
        .unwrap()
        .as_u64();
    let maximum = maximum_withdraw_capacity(PRINCIPAL, occupied, 1_000, 1_100).unwrap();
    let gross = maximum - PRINCIPAL;
    let prepare_fee = 2 * CKB;
    let transaction = context.complete_tx(
        TransactionBuilder::default()
            .input(
                CellInput::new_builder()
                    .previous_output(job_out_point)
                    .build(),
            )
            .input(
                CellInput::new_builder()
                    .since(EPOCH | 180)
                    .previous_output(vault_out_point)
                    .build(),
            )
            .input(
                CellInput::new_builder()
                    .previous_output(compensation_cell)
                    .build(),
            )
            .input(CellInput::new_builder().previous_output(owner_cell).build())
            .input(
                CellInput::new_builder()
                    .previous_output(accumulator_cell)
                    .build(),
            )
            .input(
                CellInput::new_builder()
                    .previous_output(funding_cell)
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(JOB_CAPACITY + maximum - prepare_fee + SEED)
                    .lock(owner)
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(accumulator_capacity + prepare_fee)
                    .lock(preparer)
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(300 * CKB + funding_capacity - gross)
                    .lock(funding)
                    .build(),
            )
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
            .output_data(Bytes::new().pack())
            .header_dep(deposit_header.hash())
            .header_dep(withdrawing_header.hash())
            .witness(
                WitnessArgs::new_builder()
                    .input_type(Some(request.as_bytes()).pack())
                    .output_type(Some(envelope.as_bytes()).pack())
                    .build()
                    .as_bytes()
                    .pack(),
            )
            .witness(
                WitnessArgs::new_builder()
                    .input_type(Some(Bytes::copy_from_slice(&0_u64.to_le_bytes())).pack())
                    .build()
                    .as_bytes()
                    .pack(),
            )
            .build(),
    );
    ContractCase {
        context,
        transaction,
        compensation_fixture: None,
    }
}

fn verify(case: &ContractCase) -> Result<u64, String> {
    case.context
        .verify_tx(&case.transaction, 10_000_000)
        .map_err(|error| error.to_string())
}

fn assert_setup_fails(mutation: SetupMutation, expected: ScriptError) {
    let error = verify(&build_setup_case(mutation)).expect_err("mutation must fail");
    assert!(
        error.contains(&(expected as i8).to_string()),
        "expected {expected:?}, got {error}"
    );
}

pub(crate) fn benchmark_cases() -> impl Iterator<Item = BenchmarkCase> {
    [
        (
            "dao-harvest-v2.setup.valid",
            build_setup_case(SetupMutation::None),
        ),
        (
            "dao-harvest-v2.prepare-preferred.valid",
            build_prepare_case(PrepareMutation::None),
        ),
        (
            "dao-harvest-v2.claim-preferred.valid",
            build_claim_case(ClaimMutation::None),
        ),
        (
            "dao-harvest-v2.claim-fallback.valid",
            build_claim_case_kind(ClaimMutation::None, false, true, false),
        ),
        (
            "dao-harvest-v2.sweep.valid",
            build_owner_maintenance_case(false),
        ),
        (
            "dao-harvest-v2.recover.valid",
            build_owner_maintenance_case(true),
        ),
        ("dao-harvest-v2.rotate.valid", build_rotation_case(false)),
        (
            "dao-harvest-v2.close.valid",
            build_terminal_close_case(true),
        ),
    ]
    .into_iter()
    .map(|(id, case)| BenchmarkCase::new(id, case.context, case.transaction, None))
}

#[test]
fn v2_setup_binds_job_vault_compensation_and_payload() {
    verify(&build_setup_case(SetupMutation::None)).expect("valid V2 setup");
}

#[test]
fn v2_setup_rejects_shadow_cross_version_and_duplicate_jobs() {
    assert_setup_fails(SetupMutation::Principal, ScriptError::PrincipalMismatch);
    assert_setup_fails(
        SetupMutation::JobId,
        ScriptError::CompensationBindingMismatch,
    );
    assert_setup_fails(
        SetupMutation::Payout,
        ScriptError::CompensationBindingMismatch,
    );
    assert_setup_fails(SetupMutation::Version, ScriptError::PolicyVersionMismatch);
    assert_setup_fails(SetupMutation::DuplicateJob, ScriptError::DuplicateJob);
    assert_setup_fails(SetupMutation::LockCode, ScriptError::InvalidDaoCell);
}

#[test]
fn preferred_prepare_commits_the_exact_operator_and_successor_credit() {
    verify(&build_prepare_case(PrepareMutation::None)).expect("valid preferred prepare");
}

#[test]
fn fallback_prepare_opens_only_for_a_committed_operator_after_takeover() {
    verify(&build_prepare_case_kind(PrepareMutation::None, true)).expect("valid fallback prepare");
    verify(&build_prepare_case_kind(PrepareMutation::Early, true))
        .expect_err("fallback prepare cannot execute early");
    verify(&build_prepare_case_kind(
        PrepareMutation::Unauthorized,
        true,
    ))
    .expect_err("uncommitted fallback operator cannot prepare");
}

#[test]
fn prepare_rejects_principal_authority_credit_time_and_progress_mutations() {
    for mutation in [
        PrepareMutation::Principal,
        PrepareMutation::Unauthorized,
        PrepareMutation::ForgedCredit,
        PrepareMutation::Early,
        PrepareMutation::SinceMetric,
        PrepareMutation::Progress,
    ] {
        verify(&build_prepare_case(mutation)).expect_err("mutated prepare must fail");
    }
}

#[test]
fn preferred_claim_redeposits_principal_and_settles_exact_compensation() {
    verify(&build_claim_case(ClaimMutation::None)).expect("valid preferred claim");
}

#[test]
fn fallback_claim_pays_the_preparer_and_claimant_separately_after_takeover() {
    verify(&build_claim_case_kind(
        ClaimMutation::None,
        false,
        true,
        false,
    ))
    .expect("valid fallback claim");
    verify(&build_claim_case_kind(
        ClaimMutation::Early,
        false,
        true,
        false,
    ))
    .expect_err("fallback claimant cannot execute early");
}

#[test]
fn owner_completion_settles_prepare_work_without_a_claim_charge() {
    verify(&build_claim_case_kind(
        ClaimMutation::None,
        false,
        false,
        true,
    ))
    .expect("valid owner completion");
}

#[test]
fn final_claim_releases_the_vault_to_owner_control_and_marks_compensation_terminal() {
    let case = build_claim_case_kind(ClaimMutation::None, true, false, false);
    verify(&case).expect("valid terminal preferred claim");
    assert_eq!(case.transaction.outputs().len(), 4);
    assert_eq!(
        case.transaction
            .outputs()
            .get(0)
            .unwrap()
            .lock()
            .args()
            .raw_data()[64..96],
        [0_u8; 32]
    );
    assert_eq!(
        case.transaction
            .outputs()
            .get(1)
            .unwrap()
            .lock()
            .args()
            .raw_data()[..32],
        [0_u8; 32]
    );
    assert!(
        case.transaction
            .outputs_data()
            .get(1)
            .unwrap()
            .raw_data()
            .is_empty()
    );
}

#[test]
fn terminal_compensation_close_requires_the_committed_owner_and_payout() {
    verify(&build_terminal_close_case(true)).expect("owner closes terminal compensation");
    verify(&build_terminal_close_case(false)).expect_err("another identity cannot close it");
}

#[test]
fn terminal_vault_exit_requires_the_committed_owner() {
    verify(&build_terminal_vault_exit_case(true)).expect("owner exits terminal vault");
    verify(&build_terminal_vault_exit_case(false)).expect_err("another identity cannot exit it");
}

#[test]
fn owner_sweep_preserves_the_live_job_and_recoverable_reserve() {
    verify(&build_owner_maintenance_case(false)).expect("valid owner sweep");
}

#[test]
fn owner_recovery_returns_job_vault_and_compensation_without_a_service() {
    verify(&build_owner_maintenance_case(true)).expect("valid deposited-state recovery");
}

#[test]
fn owner_rotation_changes_only_the_committed_operator_set() {
    verify(&build_rotation_case(false)).expect("valid owner rotation");
    verify(&build_rotation_case(true)).expect_err("rotation cannot change an economic term");
}

#[test]
fn withdrawing_recovery_settles_only_the_credited_prepare_work() {
    verify(&build_withdrawing_recovery_case()).expect("valid withdrawing-state recovery");
}

#[test]
fn claim_rejects_principal_fee_reward_credit_since_header_and_output_mutations() {
    for mutation in [
        ClaimMutation::Principal,
        ClaimMutation::Early,
        ClaimMutation::FeeInflation,
        ClaimMutation::RewardLock,
        ClaimMutation::ForgedCredit,
        ClaimMutation::SinceMetric,
        ClaimMutation::Header,
        ClaimMutation::DuplicateAccumulator,
    ] {
        verify(&build_claim_case(mutation)).expect_err("mutated claim must fail");
    }
}
