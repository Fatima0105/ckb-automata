use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{Capacity, ScriptHashType, TransactionBuilder},
        packed::CellOutput,
        prelude::*,
    },
    context::Context,
};

use crate::fixtures::{create_cell, seeded_script};

const CKB: u64 = 100_000_000;

fn occupied_for_args(args_bytes: usize) -> u64 {
    let lock = seeded_script(0x91, ScriptHashType::Data1, &vec![0x22; args_bytes]);
    CellOutput::new_builder()
        .lock(lock)
        .build()
        .occupied_capacity(Capacity::bytes(0).expect("empty data capacity"))
        .expect("prototype occupied capacity")
        .as_u64()
}

fn settle(compensation: u64, prepare_cap: u64, claim_cap: u64) -> (u64, u64, u64) {
    let prepare = compensation.min(prepare_cap);
    let after_prepare = compensation - prepare;
    let claim = after_prepare.min(claim_cap);
    (prepare, claim, after_prepare - claim)
}

#[test]
fn compensation_and_payout_lock_capacities_are_exact() {
    assert_eq!(occupied_for_args(0), 41 * CKB);
    assert_eq!(occupied_for_args(20), 61 * CKB);
    assert_eq!(occupied_for_args(128), 169 * CKB);
    assert_eq!(occupied_for_args(160), 201 * CKB);

    let compensation_lock = seeded_script(0x92, ScriptHashType::Data1, &[0x33; 160]);
    let compensation_output = CellOutput::new_builder().lock(compensation_lock).build();
    let occupied = compensation_output
        .occupied_capacity(Capacity::bytes(Bytes::new().len()).expect("empty data capacity"))
        .expect("Compensation Cell occupied capacity")
        .as_u64();
    assert_eq!(occupied, 201 * CKB);
}

#[test]
fn accumulator_delta_works_below_direct_output_minimum() {
    let identity_input = occupied_for_args(20) + 5 * CKB;
    let payment = CKB;
    assert!(payment < occupied_for_args(20));
    let accumulator_output = identity_input
        .checked_add(payment)
        .expect("prototype accumulator capacity");
    assert_eq!(accumulator_output - identity_input, payment);
    assert!(accumulator_output >= occupied_for_args(20));
}

#[test]
fn insufficient_compensation_is_terminal_for_that_cycle() {
    let (prepare, claim, owner) = settle(15 * CKB, 20 * CKB, 30 * CKB);
    assert_eq!((prepare, claim, owner), (15 * CKB, 0, 0));
    assert_eq!(prepare + claim + owner, 15 * CKB);
}

#[test]
fn sweep_and_close_conserve_the_recoverable_seed() {
    let seed = occupied_for_args(160);
    let accumulated = 80 * CKB;
    let input = seed + accumulated;

    let sweep_successor = seed;
    let sweep_payout = input - sweep_successor;
    assert_eq!(sweep_successor + sweep_payout, input);
    assert!(sweep_payout >= occupied_for_args(20));

    let close_payout = input;
    assert_eq!(close_payout, seed + accumulated);
    assert!(close_payout >= occupied_for_args(160));
}

#[test]
fn local_chain_claim_prototype_conserves_exact_cell_deltas() {
    let mut context = Context::new_with_deterministic_rng();
    let code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let compensation_lock = context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, Bytes::from(vec![0x11; 160]))
        .expect("Compensation Cell lock");
    let prepare_lock = context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, Bytes::from(vec![0x22; 20]))
        .expect("prepare operator lock");
    let claim_lock = context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, Bytes::from(vec![0x33; 20]))
        .expect("claim operator lock");
    let source_lock = context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, Bytes::from(vec![0x44; 20]))
        .expect("maximum-withdraw source lock");

    let compensation = create_cell(
        &mut context,
        0xa1,
        compensation_lock.clone(),
        None,
        Bytes::new(),
        7 * CKB,
    );
    let prepare = create_cell(
        &mut context,
        0xa2,
        prepare_lock.clone(),
        None,
        Bytes::new(),
        5 * CKB,
    );
    let claim = create_cell(
        &mut context,
        0xa3,
        claim_lock.clone(),
        None,
        Bytes::new(),
        5 * CKB,
    );
    let source = create_cell(
        &mut context,
        0xa4,
        source_lock.clone(),
        None,
        Bytes::new(),
        100 * CKB,
    );

    let compensation_before: u64 = compensation.output.capacity().unpack();
    let prepare_before: u64 = prepare.output.capacity().unpack();
    let claim_before: u64 = claim.output.capacity().unpack();
    let source_before: u64 = source.output.capacity().unpack();
    let compensation_after = compensation_before + 50 * CKB;
    let prepare_after = prepare_before + 20 * CKB;
    let claim_after = claim_before + 30 * CKB;
    let source_after = source_before - 100 * CKB;
    let total_input = compensation_before + prepare_before + claim_before + source_before;
    let total_output = compensation_after + prepare_after + claim_after + source_after;
    assert_eq!(total_input, total_output);
    let transaction = TransactionBuilder::default()
        .input(compensation.input.clone())
        .input(prepare.input)
        .input(claim.input)
        .input(source.input)
        .output(
            CellOutput::new_builder()
                .capacity(compensation_after)
                .lock(compensation_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(prepare_after)
                .lock(prepare_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(claim_after)
                .lock(claim_lock)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(source_after)
                .lock(source_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .output_data(Bytes::new().pack())
        .build();
    let transaction = context.complete_tx(transaction);
    context
        .verify_tx(&transaction, 10_000_000)
        .expect("local claim prototype");

    let canonical_compensation_input = transaction.inputs().get(0).expect("Compensation input");
    assert_eq!(
        canonical_compensation_input.previous_output(),
        compensation.out_point
    );
    assert_eq!(compensation_after - compensation_before, 50 * CKB);
    assert_eq!(prepare_after - prepare_before, 20 * CKB);
    assert_eq!(claim_after - claim_before, 30 * CKB);
}
