use crate::dao_harvest_v2::{
    ABSENT_INDEX, CLOSE_OPERATION, FALLBACK_CLAIM_OPERATION, FALLBACK_PREPARE_OPERATION,
    OWNER_COMPLETE_OPERATION, PREFERRED_CLAIM_OPERATION, PREFERRED_PREPARE_OPERATION,
    RECOVER_OPERATION, ROTATE_OPERATION, SETUP_OPERATION, SWEEP_OPERATION,
};

const RELATIVE_FLAG: u64 = 1 << 63;
const METRIC_MASK: u64 = 0b11 << 61;
const EPOCH_METRIC: u64 = 0b01 << 61;
const RESERVED_MASK: u64 = 0b1_1111 << 56;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompensationAllocation {
    pub prepare_payment: u64,
    pub claim_payment: u64,
    pub owner_payment: u64,
}

pub fn allocate_compensation(
    maximum_withdraw: u64,
    principal: u64,
    prepare_fee_cap: u64,
    claim_fee_cap: u64,
    owner_completion: bool,
) -> Option<CompensationAllocation> {
    let gross = maximum_withdraw.checked_sub(principal)?;
    let prepare_payment = gross.min(prepare_fee_cap);
    let after_prepare = gross.checked_sub(prepare_payment)?;
    let claim_cap = if owner_completion { 0 } else { claim_fee_cap };
    let claim_payment = after_prepare.min(claim_cap);
    let owner_payment = after_prepare.checked_sub(claim_payment)?;
    Some(CompensationAllocation {
        prepare_payment,
        claim_payment,
        owner_payment,
    })
}

pub fn validate_accumulator_delta(
    input_capacity: u64,
    output_capacity: u64,
    expected_payment: u64,
) -> bool {
    output_capacity.checked_sub(input_capacity) == Some(expected_payment)
}

pub fn validate_progress_transition(
    operation: u8,
    input_state: u8,
    input_cycle: u32,
    output_state: Option<u8>,
    output_cycle: Option<u32>,
) -> bool {
    match operation {
        PREFERRED_PREPARE_OPERATION | FALLBACK_PREPARE_OPERATION => {
            input_state == 0
                && output_state == Some(1)
                && output_cycle == Some(input_cycle)
        }
        PREFERRED_CLAIM_OPERATION | FALLBACK_CLAIM_OPERATION | OWNER_COMPLETE_OPERATION => {
            input_state == 1
                && output_state.is_none_or(|state| state == 0)
                && output_cycle.is_none_or(|cycle| cycle == input_cycle.saturating_add(1))
        }
        SWEEP_OPERATION | ROTATE_OPERATION => {
            output_state == Some(input_state) && output_cycle == Some(input_cycle)
        }
        CLOSE_OPERATION | RECOVER_OPERATION => output_state.is_none() && output_cycle.is_none(),
        _ => false,
    }
}

pub fn validate_witness_layout(operation: u8, indices: &[u32; 11]) -> bool {
    let required: &[usize] = match operation {
        SETUP_OPERATION => &[3, 6, 7, 8],
        PREFERRED_PREPARE_OPERATION | FALLBACK_PREPARE_OPERATION => &[0, 1, 3, 6, 7],
        PREFERRED_CLAIM_OPERATION => &[0, 1, 2, 3, 4, 7, 8, 9],
        FALLBACK_CLAIM_OPERATION => &[0, 1, 2, 3, 4, 5, 7, 8, 9, 10],
        OWNER_COMPLETE_OPERATION => &[0, 1, 2, 3, 4, 7, 8, 9],
        SWEEP_OPERATION => &[0, 2, 3, 6, 8],
        CLOSE_OPERATION => &[2, 3],
        ROTATE_OPERATION => &[0, 2, 3, 6, 8],
        RECOVER_OPERATION => &[0, 1, 2, 3],
        _ => return false,
    };
    for (index, value) in indices.iter().enumerate() {
        let must_exist = required.contains(&index);
        let optional = (matches!(
            operation,
            PREFERRED_CLAIM_OPERATION | FALLBACK_CLAIM_OPERATION | OWNER_COMPLETE_OPERATION
        ) && index == 6)
            || (operation == PREFERRED_CLAIM_OPERATION && (index == 5 || index == 10))
            || (operation == RECOVER_OPERATION && (index == 4 || index == 9));
        if (must_exist && *value == ABSENT_INDEX) || (!must_exist && !optional && *value != ABSENT_INDEX)
        {
            return false;
        }
    }
    let prepare_pair = (indices[4] == ABSENT_INDEX) == (indices[9] == ABSENT_INDEX);
    let claim_pair = (indices[5] == ABSENT_INDEX) == (indices[10] == ABSENT_INDEX);
    prepare_pair && claim_pair
}

pub fn is_absolute_epoch_since(value: u64) -> bool {
    value & RELATIVE_FLAG == 0
        && value & METRIC_MASK == EPOCH_METRIC
        && value & RESERVED_MASK == 0
        && valid_epoch_fraction(value)
}

pub fn is_relative_epoch_since(value: u64) -> bool {
    value & RELATIVE_FLAG != 0
        && value & METRIC_MASK == EPOCH_METRIC
        && value & RESERVED_MASK == 0
        && valid_epoch_fraction(value)
}

fn valid_epoch_fraction(value: u64) -> bool {
    let index = (value >> 24) & 0xffff;
    let length = (value >> 40) & 0xffff;
    (length == 0 && index == 0) || (length != 0 && index < length)
}

pub fn epoch_at_or_after_delay(actual: u64, base: u64, relative_delay: u64) -> bool {
    if !is_absolute_epoch_since(actual)
        || !is_absolute_epoch_since(base)
        || !is_relative_epoch_since(relative_delay)
    {
        return false;
    }
    let (actual_n, actual_d) = epoch_fraction(actual);
    let (base_n, base_d) = epoch_fraction(base);
    let (delay_n, delay_d) = epoch_fraction(relative_delay);
    let left = (actual_n as u128)
        .checked_mul(base_d as u128)
        .and_then(|value| value.checked_mul(delay_d as u128));
    let right = (base_n as u128)
        .checked_mul(actual_d as u128)
        .and_then(|value| value.checked_mul(delay_d as u128))
        .and_then(|value| {
            (delay_n as u128)
                .checked_mul(actual_d as u128)
                .and_then(|delay| delay.checked_mul(base_d as u128))
                .and_then(|delay| value.checked_add(delay))
        });
    left.zip(right).is_some_and(|(left, right)| left >= right)
}

pub fn epoch_at_or_after(actual: u64, base: u64) -> bool {
    if !is_absolute_epoch_since(actual) || !is_absolute_epoch_since(base) {
        return false;
    }
    let (actual_n, actual_d) = epoch_fraction(actual);
    let (base_n, base_d) = epoch_fraction(base);
    (actual_n as u128)
        .checked_mul(base_d as u128)
        .zip((base_n as u128).checked_mul(actual_d as u128))
        .is_some_and(|(actual, base)| actual >= base)
}

fn epoch_fraction(value: u64) -> (u64, u64) {
    let number = value & 0x00ff_ffff;
    let index = (value >> 24) & 0xffff;
    let length = (value >> 40) & 0xffff;
    let denominator = if length == 0 { 1 } else { length };
    (number * denominator + index, denominator)
}
