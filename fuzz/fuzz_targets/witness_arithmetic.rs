#![no_main]

extern crate alloc;

use libfuzzer_sys::fuzz_target;

mod execution_witness {
    include!("../../contracts/shared/execution_witness.rs");
}

mod output_match {
    include!("../../contracts/shared/output_match.rs");
}

#[allow(dead_code)]
mod recurring {
    include!("../../contracts/shared/recurring.rs");
}

#[allow(dead_code)]
mod dao_harvest {
    include!("../../contracts/shared/dao_harvest.rs");
}

mod dao_harvest_witness {
    include!("../../contracts/shared/dao_harvest_witness.rs");
}

#[allow(dead_code)]
mod dao_harvest_v2 {
    include!("../../contracts/shared/dao_harvest_v2.rs");
}

#[allow(dead_code)]
mod dao_harvest_v2_validation {
    include!("../../contracts/shared/dao_harvest_v2_validation.rs");
}

fuzz_target!(|data: &[u8]| {
    let _ = execution_witness::parse_witness_operation(data);
    let _ = dao_harvest_witness::parse_vault_operation(data);
    if data.len() < 97 {
        return;
    }

    let read_u64 = |offset: usize| {
        u64::from_le_bytes(
            data[offset..offset + 8]
                .try_into()
                .expect("eight-byte fuzz field"),
        )
    };
    let first = read_u64(0);
    let sequence = read_u64(8);
    let interval = read_u64(16);
    let _ = recurring::scheduled_block_lower_bound(first, sequence, interval);
    let _ = recurring::absolute_block_trigger_hash(read_u64(24));
    let _ = recurring::valid_recurring_schedule(
        read_u64(32),
        interval,
        first,
        u32::from_le_bytes(data[40..44].try_into().expect("four-byte fuzz field")),
        data[44],
    );

    let actual_hash: [u8; 32] = data[45..77].try_into().expect("actual hash");
    let expected_hash: [u8; 32] = data[65..97].try_into().expect("expected hash");
    let _ = output_match::matches_plain_output(
        &actual_hash,
        &expected_hash,
        read_u64(24),
        read_u64(32),
        data[0] & 1 != 0,
        data[0] & 2 != 0,
    );
    let _ = dao_harvest::maximum_withdraw_capacity(
        read_u64(0),
        read_u64(8),
        read_u64(16),
        read_u64(24),
    );
    let _ = dao_harvest::decode_relative_epoch_duration(read_u64(32));
    let _ = dao_harvest_v2_validation::allocate_compensation(
        read_u64(0),
        read_u64(8),
        read_u64(16),
        read_u64(24),
        data[44] & 1 != 0,
    );
    let _ = dao_harvest_v2_validation::epoch_at_or_after_delay(
        read_u64(0),
        read_u64(8),
        read_u64(16),
    );
});
