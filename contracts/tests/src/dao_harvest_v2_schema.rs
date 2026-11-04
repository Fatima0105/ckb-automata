use molecule::prelude::{Builder, Entity};
use serde::Deserialize;

use crate::{
    dao_harvest_v2::{
        COMPENSATION_LOCK_ARGS_LENGTH, CompensationLockArgsV2, DAO_HARVEST_V2_VERSION,
        PREFERRED_CLAIM_OPERATION, decode_compensation_lock_args, decode_fallback_operator_proof,
        encode_compensation_lock_args, fallback_operator_set_hash, operation_is_supported,
        payload_hash, prepare_credit_hash, progress_hash,
    },
    generated_dao_harvest_v2::{
        Bytes, DaoHarvestEnvelopeV2, DaoHarvestPayloadV2, DaoHarvestPrepareCreditV2,
        DaoHarvestProgressV2, DaoHarvestWitnessV2,
    },
};

#[derive(Deserialize)]
struct Fixture {
    payload: Payload,
    prepare_credit: PrepareCredit,
    progress: Progress,
    witness: Witness,
    envelope: Envelope,
    compensation_lock_args: CompensationArgs,
}

#[derive(Deserialize)]
struct Payload {
    version: u16,
    owner_lock_hash: String,
    payout_lock_hash: String,
    vault_lock_hash: String,
    compensation_lock_hash: String,
    dao_type_hash: String,
    principal_capacity: String,
    preferred_prepare_operator_lock_hash: String,
    fallback_prepare_executor_lock_hashes: Vec<String>,
    fallback_prepare_executor_set_hash: String,
    prepare_service_fee: String,
    claim_service_fee: String,
    compensation_seed_capacity: String,
    prepare_buffer_epochs: String,
    takeover_delay_epochs: String,
    confirmation_margin_epochs: String,
    total_cycles: u32,
    end_epoch_since: String,
    policy_script_hash: String,
    expected_hex: String,
    expected_hash: String,
}

#[derive(Deserialize)]
struct PrepareCredit {
    version: u16,
    job_id: String,
    cycle_index: u32,
    preparer_lock_hash: String,
    prepared_vault_output_index: u32,
    job_output_index: u32,
    expected_hex: String,
    expected_hash: String,
}

#[derive(Deserialize)]
struct Progress {
    version: u16,
    state: u8,
    cycle_index: u32,
    prepare_credit_hash: String,
    expected_hex: String,
    expected_hash: String,
}

#[derive(Deserialize)]
struct Witness {
    version: u16,
    operation: u8,
    flags: u8,
    job_input_index: u32,
    vault_input_index: u32,
    compensation_input_index: u32,
    identity_input_index: u32,
    prepare_accumulator_input_index: u32,
    claim_accumulator_input_index: u32,
    job_output_index: u32,
    vault_output_index: u32,
    compensation_output_index: u32,
    prepare_accumulator_output_index: u32,
    claim_accumulator_output_index: u32,
    payload_hash: String,
    progress_hash: String,
    prepare_credit_hash: String,
    expected_hex: String,
}

#[derive(Deserialize)]
struct CompensationArgs {
    job_id: String,
    owner_lock_hash: String,
    payout_lock_hash: String,
    policy_script_hash: String,
    payload_hash: String,
    expected_hex: String,
}

#[derive(Deserialize)]
struct Envelope {
    payload: String,
    progress: String,
    prepare_credit: String,
    operator_proof: String,
    successor_payload: String,
    expected_hex: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    assert_eq!(digits.len() % 2, 0);
    (0..digits.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&digits[index..index + 2], 16).unwrap())
        .collect()
}

fn byte32(value: &str) -> [u8; 32] {
    decode_hex(value).try_into().expect("fixture Byte32")
}

fn u64_bytes(value: &str) -> [u8; 8] {
    value.parse::<u64>().expect("fixture Uint64").to_le_bytes()
}

fn molecule_bytes(value: &str) -> Bytes {
    Bytes::new_builder()
        .set(decode_hex(value).into_iter().map(Into::into).collect())
        .build()
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../../fixtures/dao_harvest_v2.json")).unwrap()
}

#[test]
fn rust_v2_types_and_hash_domains_match_the_canonical_fixture() {
    let value = fixture();
    assert_eq!(value.payload.version, DAO_HARVEST_V2_VERSION);
    let payload = DaoHarvestPayloadV2::new_builder()
        .version(value.payload.version.to_le_bytes())
        .owner_lock_hash(byte32(&value.payload.owner_lock_hash))
        .payout_lock_hash(byte32(&value.payload.payout_lock_hash))
        .vault_lock_hash(byte32(&value.payload.vault_lock_hash))
        .compensation_lock_hash(byte32(&value.payload.compensation_lock_hash))
        .dao_type_hash(byte32(&value.payload.dao_type_hash))
        .principal_capacity(u64_bytes(&value.payload.principal_capacity))
        .preferred_prepare_operator_lock_hash(byte32(
            &value.payload.preferred_prepare_operator_lock_hash,
        ))
        .fallback_prepare_executor_set_hash(byte32(
            &value.payload.fallback_prepare_executor_set_hash,
        ))
        .prepare_service_fee(u64_bytes(&value.payload.prepare_service_fee))
        .claim_service_fee(u64_bytes(&value.payload.claim_service_fee))
        .compensation_seed_capacity(u64_bytes(&value.payload.compensation_seed_capacity))
        .prepare_buffer_epochs(u64_bytes(&value.payload.prepare_buffer_epochs))
        .takeover_delay_epochs(u64_bytes(&value.payload.takeover_delay_epochs))
        .confirmation_margin_epochs(u64_bytes(&value.payload.confirmation_margin_epochs))
        .total_cycles(value.payload.total_cycles.to_le_bytes())
        .end_epoch_since(u64_bytes(&value.payload.end_epoch_since))
        .build();
    assert_eq!(payload.as_slice(), decode_hex(&value.payload.expected_hex));
    assert_eq!(
        payload_hash(
            &byte32(&value.payload.policy_script_hash),
            payload.as_slice()
        ),
        Some(byte32(&value.payload.expected_hash))
    );

    let mut fallback = value
        .payload
        .fallback_prepare_executor_lock_hashes
        .iter()
        .map(|hash| byte32(hash))
        .collect::<Vec<_>>();
    assert_eq!(
        fallback_operator_set_hash(&mut fallback),
        Some(byte32(&value.payload.fallback_prepare_executor_set_hash))
    );
    let proof = decode_hex(&value.envelope.operator_proof);
    assert_eq!(
        decode_fallback_operator_proof(
            &proof,
            &byte32(&value.payload.fallback_prepare_executor_set_hash)
        ),
        Some(fallback)
    );

    let credit = DaoHarvestPrepareCreditV2::new_builder()
        .version(value.prepare_credit.version.to_le_bytes())
        .job_id(byte32(&value.prepare_credit.job_id))
        .cycle_index(value.prepare_credit.cycle_index.to_le_bytes())
        .preparer_lock_hash(byte32(&value.prepare_credit.preparer_lock_hash))
        .prepared_vault_output_index(
            value
                .prepare_credit
                .prepared_vault_output_index
                .to_le_bytes(),
        )
        .job_output_index(value.prepare_credit.job_output_index.to_le_bytes())
        .build();
    assert_eq!(
        credit.as_slice(),
        decode_hex(&value.prepare_credit.expected_hex)
    );
    assert_eq!(
        prepare_credit_hash(credit.as_slice()),
        Some(byte32(&value.prepare_credit.expected_hash))
    );

    let progress = DaoHarvestProgressV2::new_builder()
        .version(value.progress.version.to_le_bytes())
        .state(value.progress.state)
        .cycle_index(value.progress.cycle_index.to_le_bytes())
        .prepare_credit_hash(byte32(&value.progress.prepare_credit_hash))
        .build();
    assert_eq!(
        progress.as_slice(),
        decode_hex(&value.progress.expected_hex)
    );
    assert_eq!(
        progress_hash(progress.as_slice()),
        Some(byte32(&value.progress.expected_hash))
    );

    let witness = DaoHarvestWitnessV2::new_builder()
        .version(value.witness.version.to_le_bytes())
        .operation(value.witness.operation)
        .flags(value.witness.flags)
        .job_input_index(value.witness.job_input_index.to_le_bytes())
        .vault_input_index(value.witness.vault_input_index.to_le_bytes())
        .compensation_input_index(value.witness.compensation_input_index.to_le_bytes())
        .identity_input_index(value.witness.identity_input_index.to_le_bytes())
        .prepare_accumulator_input_index(
            value.witness.prepare_accumulator_input_index.to_le_bytes(),
        )
        .claim_accumulator_input_index(value.witness.claim_accumulator_input_index.to_le_bytes())
        .job_output_index(value.witness.job_output_index.to_le_bytes())
        .vault_output_index(value.witness.vault_output_index.to_le_bytes())
        .compensation_output_index(value.witness.compensation_output_index.to_le_bytes())
        .prepare_accumulator_output_index(
            value.witness.prepare_accumulator_output_index.to_le_bytes(),
        )
        .claim_accumulator_output_index(value.witness.claim_accumulator_output_index.to_le_bytes())
        .payload_hash(byte32(&value.witness.payload_hash))
        .progress_hash(byte32(&value.witness.progress_hash))
        .prepare_credit_hash(byte32(&value.witness.prepare_credit_hash))
        .build();
    assert_eq!(value.witness.operation, PREFERRED_CLAIM_OPERATION);
    assert_eq!(witness.as_slice(), decode_hex(&value.witness.expected_hex));

    let envelope = DaoHarvestEnvelopeV2::new_builder()
        .payload(molecule_bytes(&value.envelope.payload))
        .progress(molecule_bytes(&value.envelope.progress))
        .prepare_credit(molecule_bytes(&value.envelope.prepare_credit))
        .operator_proof(molecule_bytes(&value.envelope.operator_proof))
        .successor_payload(molecule_bytes(&value.envelope.successor_payload))
        .build();
    assert_eq!(
        envelope.as_slice(),
        decode_hex(&value.envelope.expected_hex)
    );
}

#[test]
fn compensation_args_bind_all_five_identities_in_order() {
    let value = fixture().compensation_lock_args;
    let args = CompensationLockArgsV2 {
        job_id: byte32(&value.job_id),
        owner_lock_hash: byte32(&value.owner_lock_hash),
        payout_lock_hash: byte32(&value.payout_lock_hash),
        policy_script_hash: byte32(&value.policy_script_hash),
        payload_hash: byte32(&value.payload_hash),
    };
    let encoded = encode_compensation_lock_args(&args);
    assert_eq!(encoded.len(), COMPENSATION_LOCK_ARGS_LENGTH);
    assert_eq!(encoded.as_slice(), decode_hex(&value.expected_hex));
    assert_eq!(decode_compensation_lock_args(&encoded), Some(args));
    assert_eq!(decode_compensation_lock_args(&encoded[..159]), None);

    for index in 0..5 {
        let mut mutated = encoded;
        mutated[index * 32] ^= 1;
        assert_ne!(decode_compensation_lock_args(&mutated), Some(args));
    }
}

#[test]
fn operation_codes_are_closed_and_fallback_sets_reject_ambiguity() {
    for operation in 0..=9 {
        assert!(operation_is_supported(operation));
    }
    assert!(!operation_is_supported(10));
    assert_eq!(fallback_operator_set_hash(&mut []), None);
    assert_eq!(fallback_operator_set_hash(&mut [[1; 32], [1; 32]]), None);
    assert_eq!(fallback_operator_set_hash(&mut [[1; 32]; 9]), None);
    assert_eq!(
        decode_fallback_operator_proof(&[[2; 32], [1; 32]].concat(), &[0; 32]),
        None
    );
}
