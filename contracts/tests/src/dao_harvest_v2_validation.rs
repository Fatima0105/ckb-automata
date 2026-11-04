use proptest::prelude::*;

use crate::{
    dao_harvest_v2::{
        ABSENT_INDEX, FALLBACK_PREPARE_OPERATION, HarvestVaultLockArgsV2, OWNER_COMPLETE_OPERATION,
        PREFERRED_CLAIM_OPERATION, PREFERRED_PREPARE_OPERATION, SETUP_OPERATION,
        decode_harvest_vault_lock_args, encode_harvest_vault_lock_args, vault_terms_hash,
    },
    dao_harvest_v2_validation::{
        allocate_compensation, epoch_at_or_after, epoch_at_or_after_delay, is_absolute_epoch_since,
        is_relative_epoch_since, validate_accumulator_delta, validate_progress_transition,
        validate_witness_layout,
    },
};

const EPOCH: u64 = 1 << 61;
const RELATIVE_EPOCH: u64 = (1 << 63) | EPOCH;

#[test]
fn compensation_priority_never_spends_principal_or_creates_debt() {
    let allocation = allocate_compensation(1_025, 1_000, 20, 20, false).unwrap();
    assert_eq!(allocation.prepare_payment, 20);
    assert_eq!(allocation.claim_payment, 5);
    assert_eq!(allocation.owner_payment, 0);
    assert_eq!(allocate_compensation(999, 1_000, 1, 1, false), None);

    let owner = allocate_compensation(1_025, 1_000, 20, 20, true).unwrap();
    assert_eq!(owner.prepare_payment, 20);
    assert_eq!(owner.claim_payment, 0);
    assert_eq!(owner.owner_payment, 5);
}

#[test]
fn progress_and_layouts_are_closed_by_operation() {
    assert!(validate_progress_transition(
        PREFERRED_PREPARE_OPERATION,
        0,
        2,
        Some(1),
        Some(2)
    ));
    assert!(validate_progress_transition(
        PREFERRED_CLAIM_OPERATION,
        1,
        2,
        Some(0),
        Some(3)
    ));
    assert!(validate_progress_transition(
        OWNER_COMPLETE_OPERATION,
        1,
        2,
        None,
        None
    ));
    assert!(!validate_progress_transition(
        FALLBACK_PREPARE_OPERATION,
        1,
        2,
        Some(1),
        Some(2)
    ));

    let mut setup = [ABSENT_INDEX; 11];
    for index in [3, 6, 7, 8] {
        setup[index] = index as u32;
    }
    assert!(validate_witness_layout(SETUP_OPERATION, &setup));
    setup[0] = 0;
    assert!(!validate_witness_layout(SETUP_OPERATION, &setup));
}

#[test]
fn takeover_uses_only_canonical_epoch_since_values() {
    let base = EPOCH | 100 | (1 << 40);
    let delay = RELATIVE_EPOCH | (1 << 24) | (20 << 40);
    let before = EPOCH | 99 | (19 << 24) | (20 << 40);
    let exact = EPOCH | 100 | (1 << 24) | (20 << 40);
    assert!(is_absolute_epoch_since(base));
    assert!(is_relative_epoch_since(delay));
    assert!(!epoch_at_or_after_delay(before, base, delay));
    assert!(epoch_at_or_after_delay(exact, base, delay));
    assert!(!epoch_at_or_after_delay(exact | (1 << 63), base, delay));
    assert!(!epoch_at_or_after(before, base));
    assert!(epoch_at_or_after(base, base));
    assert!(epoch_at_or_after(exact, base));
}

#[test]
fn vault_binding_is_rotation_stable_and_ordered() {
    let terms = vault_terms_hash(&[&[1; 32], &[2; 8], &[3; 32]]).unwrap();
    let args = HarvestVaultLockArgsV2 {
        job_id: [0x11; 32],
        owner_lock_hash: [0x22; 32],
        job_lock_hash: [0x33; 32],
        policy_script_hash: [0x44; 32],
        immutable_terms_hash: terms,
    };
    let encoded = encode_harvest_vault_lock_args(&args);
    assert_eq!(decode_harvest_vault_lock_args(&encoded), Some(args));
    assert_eq!(decode_harvest_vault_lock_args(&encoded[..159]), None);
    assert_ne!(
        vault_terms_hash(&[&[2; 8], &[1; 32], &[3; 32]]),
        Some(terms)
    );
}

proptest! {
    #[test]
    fn allocations_conserve_every_compensation_shannon(
        principal in 0_u64..=u64::MAX / 2,
        compensation in 0_u64..=u64::MAX / 2,
        prepare_fee in any::<u64>(),
        claim_fee in any::<u64>(),
        owner_completion in any::<bool>(),
    ) {
        let maximum = principal + compensation;
        let allocation = allocate_compensation(
            maximum,
            principal,
            prepare_fee,
            claim_fee,
            owner_completion,
        ).unwrap();
        prop_assert_eq!(
            allocation.prepare_payment as u128
                + allocation.claim_payment as u128
                + allocation.owner_payment as u128,
            compensation as u128,
        );
        prop_assert!(allocation.prepare_payment <= prepare_fee);
        prop_assert!(allocation.claim_payment <= claim_fee);
        if owner_completion {
            prop_assert_eq!(allocation.claim_payment, 0);
        }
    }

    #[test]
    fn accumulator_delta_is_exact(input in any::<u64>(), payment in any::<u64>()) {
        if let Some(output) = input.checked_add(payment) {
            prop_assert!(validate_accumulator_delta(input, output, payment));
            if payment > 0 {
                prop_assert!(!validate_accumulator_delta(input, output - 1, payment));
            }
        }
    }

    #[test]
    fn unsupported_layouts_fail_closed(operation in 10_u8..=u8::MAX) {
        prop_assert!(!validate_witness_layout(operation, &[ABSENT_INDEX; 11]));
    }
}
