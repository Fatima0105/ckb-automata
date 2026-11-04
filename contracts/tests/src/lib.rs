extern crate alloc;

pub fn native_harness_ready() -> bool {
    true
}

pub mod fixtures;

#[allow(
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
pub mod generated {
    include!("../../generated/job_v1.rs");
}

#[allow(
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
pub mod generated_campaign {
    include!("../../generated/campaign_v1.rs");
}

pub mod error_codes {
    include!("../../shared/error_codes.rs");
}

pub mod job_identity {
    include!("../../shared/job_identity.rs");
}

pub mod trigger {
    include!("../../shared/trigger.rs");
}

pub mod campaign {
    include!("../../shared/campaign.rs");
}

pub mod campaign_identity {
    include!("../../shared/campaign_identity.rs");
}

pub mod deadline_payload {
    include!("../../shared/deadline_payload.rs");
}

#[allow(
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
pub mod generated_recurring {
    include!("../../generated/recurring_v1.rs");
}

#[allow(
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
pub mod generated_dao_harvest {
    include!("../../generated/dao_harvest_v1.rs");
}

pub mod recurring {
    include!("../../shared/recurring.rs");
}

pub mod dao_harvest {
    include!("../../shared/dao_harvest.rs");
}

pub mod dao_harvest_witness {
    include!("../../shared/dao_harvest_witness.rs");
}

pub mod dao_harvest_v2 {
    include!("../../shared/dao_harvest_v2.rs");
}

pub mod dao_harvest_v2_validation {
    include!("../../shared/dao_harvest_v2_validation.rs");
}

#[allow(
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::useless_conversion,
    clippy::write_literal
)]
pub mod generated_dao_harvest_v2 {
    include!("../../generated/dao_harvest_v2.rs");
}

pub mod execution_witness {
    include!("../../shared/execution_witness.rs");
}

pub mod output_match {
    include!("../../shared/output_match.rs");
}

#[cfg(test)]
mod execution_mode;

#[cfg(test)]
mod benchmarks;

#[cfg(test)]
mod owner_mode;

#[cfg(test)]
mod recurring_successor;

#[cfg(test)]
mod trigger_validation;

#[cfg(test)]
mod top_up;

#[cfg(test)]
mod campaign_state;

#[cfg(test)]
mod campaign_lock;

#[cfg(test)]
mod campaign_creation;

#[cfg(test)]
mod campaign_success;

#[cfg(test)]
mod recurring_payload;

#[cfg(test)]
mod recurring_payout;

#[cfg(test)]
mod recurring_final;

#[cfg(test)]
mod dao_harvest_payload;

#[cfg(test)]
mod dao_harvest_contract;

#[cfg(test)]
mod dao_harvest_v2_cells;

#[cfg(test)]
mod dao_harvest_v2_schema;

#[cfg(test)]
mod dao_harvest_v2_contract;

#[cfg(test)]
#[path = "dao_harvest_v2_validation.rs"]
mod dao_harvest_v2_validation_tests;

#[cfg(test)]
mod conformance;

#[cfg(test)]
mod tests {
    use molecule::prelude::{Builder, Entity};
    use serde::Deserialize;

    use super::{
        campaign::refund_commitment,
        campaign_identity::derive_campaign_id,
        deadline_payload::deadline_campaign_payload_hash,
        error_codes::ScriptError,
        fixtures::{executor_identity, golden_transaction},
        generated::JobDataV1,
        job_identity::{CreationAnchor, derive_job_id},
        native_harness_ready,
        recurring::absolute_block_trigger_hash,
    };

    const GOLDEN_TRANSACTION_HASH: &str =
        "0xe21e7ae71e30551e43947e0430e239484f4dfb7ee1676e46a69f58fc5283ab50";

    #[derive(Deserialize)]
    struct JobFixture {
        version: u16,
        flags: u16,
        job_id: String,
        sequence: String,
        state: u8,
        trigger_kind: u16,
        trigger_params_hash: String,
        policy_script_hash: String,
        payload_hash: String,
        reward: String,
        remaining_budget: String,
        not_before: String,
        not_after: String,
        remaining_runs: u32,
        cancel_lock_hash: String,
        expected_hex: String,
    }

    #[derive(Deserialize)]
    struct JobIdentityAnchorFixture {
        kind: String,
        output_index: String,
    }

    #[derive(Deserialize)]
    struct JobIdentityFixture {
        genesis_hash: String,
        protocol_version: u16,
        creation_commitment: String,
        anchor: JobIdentityAnchorFixture,
        creator_nonce: String,
        policy_script_hash: String,
        expected_job_id: String,
    }

    #[derive(Deserialize)]
    struct DeadlinePledgeFixture {
        tx_hash: String,
        index: String,
        refund_lock_hash: String,
        amount: String,
    }

    #[derive(Deserialize)]
    struct DeadlineExpectedFixture {
        campaign_id: String,
        campaign_type_hash: String,
        policy_script_hash: String,
        payload_hash: String,
        trigger_params_hash: String,
        refund_commitment: String,
    }

    #[derive(Deserialize)]
    struct DeadlineCreationFixture {
        pledges: Vec<DeadlinePledgeFixture>,
        deadline_block: String,
        expected: DeadlineExpectedFixture,
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        let digits = value.strip_prefix("0x").unwrap_or(value);
        assert_eq!(digits.len() % 2, 0, "hex value has an odd length");
        (0..digits.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&digits[index..index + 2], 16).unwrap())
            .collect()
    }

    fn byte32(value: &str) -> [u8; 32] {
        decode_hex(value)
            .try_into()
            .expect("fixture must contain 32 bytes")
    }

    #[test]
    fn native_harness_compiles_and_runs() {
        assert!(native_harness_ready());
        assert_eq!(i8::from(ScriptError::InvalidData), 10);
        assert_eq!(i8::from(ScriptError::InvalidExecutorSet), 42);
    }

    #[test]
    fn rust_binding_matches_cross_language_fixture() {
        let fixture: JobFixture =
            serde_json::from_str(include_str!("../../fixtures/job_data_v1.json")).unwrap();
        let encoded = JobDataV1::new_builder()
            .version(fixture.version.to_le_bytes())
            .flags(fixture.flags.to_le_bytes())
            .job_id(byte32(&fixture.job_id))
            .sequence(fixture.sequence.parse::<u64>().unwrap().to_le_bytes())
            .state(fixture.state)
            .trigger_kind(fixture.trigger_kind.to_le_bytes())
            .trigger_params_hash(byte32(&fixture.trigger_params_hash))
            .policy_script_hash(byte32(&fixture.policy_script_hash))
            .payload_hash(byte32(&fixture.payload_hash))
            .reward(fixture.reward.parse::<u64>().unwrap().to_le_bytes())
            .remaining_budget(
                fixture
                    .remaining_budget
                    .parse::<u64>()
                    .unwrap()
                    .to_le_bytes(),
            )
            .not_before(fixture.not_before.parse::<u64>().unwrap().to_le_bytes())
            .not_after(fixture.not_after.parse::<u64>().unwrap().to_le_bytes())
            .remaining_runs(fixture.remaining_runs.to_le_bytes())
            .cancel_lock_hash(byte32(&fixture.cancel_lock_hash))
            .build();

        assert_eq!(encoded.as_slice(), decode_hex(&fixture.expected_hex));
    }

    #[test]
    fn fixture_builders_are_deterministic() {
        let first = golden_transaction();
        let second = golden_transaction();
        assert_eq!(first.data().as_slice(), second.data().as_slice());
        assert_eq!(format!("{:#x}", first.hash()), GOLDEN_TRANSACTION_HASH);

        let executor = executor_identity(0x55);
        assert_eq!(
            executor.lock.calc_script_hash().as_slice(),
            executor.lock_hash
        );
    }

    #[test]
    fn rust_job_identity_matches_cross_language_fixture() {
        let fixture: JobIdentityFixture =
            serde_json::from_str(include_str!("../../fixtures/job_identity_v1.json")).unwrap();
        assert_eq!(fixture.anchor.kind, "output_index");
        let actual = derive_job_id(
            &byte32(&fixture.genesis_hash),
            fixture.protocol_version,
            &byte32(&fixture.creation_commitment),
            CreationAnchor::OutputIndex(fixture.anchor.output_index.parse().unwrap()),
            fixture.creator_nonce.parse().unwrap(),
            &byte32(&fixture.policy_script_hash),
        );
        assert_eq!(actual, byte32(&fixture.expected_job_id));
    }

    #[test]
    fn rust_deadline_hashes_match_cross_language_creation_fixture() {
        let fixture: DeadlineCreationFixture =
            serde_json::from_str(include_str!("../../fixtures/deadline_creation_v1.json")).unwrap();
        let mut pledges = fixture.pledges;
        pledges.sort_by(|left, right| {
            left.tx_hash.cmp(&right.tx_hash).then_with(|| {
                left.index
                    .parse::<u32>()
                    .unwrap()
                    .cmp(&right.index.parse().unwrap())
            })
        });
        let anchor = &pledges[0];
        let mut anchor_out_point = [0_u8; 36];
        anchor_out_point[..32].copy_from_slice(&decode_hex(&anchor.tx_hash));
        anchor_out_point[32..].copy_from_slice(&anchor.index.parse::<u32>().unwrap().to_le_bytes());
        assert_eq!(
            derive_campaign_id(&anchor_out_point, 0),
            byte32(&fixture.expected.campaign_id)
        );

        let mut records = Vec::with_capacity(pledges.len() * 76);
        for pledge in &pledges {
            records.extend_from_slice(&decode_hex(&pledge.tx_hash));
            records.extend_from_slice(&pledge.index.parse::<u32>().unwrap().to_le_bytes());
            records.extend_from_slice(&decode_hex(&pledge.refund_lock_hash));
            records.extend_from_slice(&pledge.amount.parse::<u64>().unwrap().to_le_bytes());
        }
        assert_eq!(
            refund_commitment(pledges.len() as u32, &records),
            byte32(&fixture.expected.refund_commitment)
        );
        assert_eq!(
            absolute_block_trigger_hash(fixture.deadline_block.parse().unwrap()),
            byte32(&fixture.expected.trigger_params_hash)
        );
        assert_eq!(
            deadline_campaign_payload_hash(
                &byte32(&fixture.expected.policy_script_hash),
                &byte32(&fixture.expected.campaign_type_hash),
            ),
            byte32(&fixture.expected.payload_hash)
        );
    }

    #[test]
    fn job_identity_inputs_are_collision_resistant() {
        let genesis = [0x11; 32];
        let creation = [0x22; 32];
        let policy = [0x33; 32];
        let baseline = derive_job_id(
            &genesis,
            1,
            &creation,
            CreationAnchor::OutputIndex(0),
            7,
            &policy,
        );

        let mut other_network = genesis;
        other_network[0] ^= 1;
        assert_ne!(
            baseline,
            derive_job_id(
                &other_network,
                1,
                &creation,
                CreationAnchor::OutputIndex(0),
                7,
                &policy,
            )
        );
        assert_ne!(
            baseline,
            derive_job_id(
                &genesis,
                2,
                &creation,
                CreationAnchor::OutputIndex(0),
                7,
                &policy,
            )
        );
        assert_ne!(
            baseline,
            derive_job_id(
                &genesis,
                1,
                &creation,
                CreationAnchor::TypeId(&[0; 32]),
                7,
                &policy,
            )
        );
    }
}
