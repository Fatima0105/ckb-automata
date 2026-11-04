use std::{fs, path::PathBuf};

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{Capacity, ScriptHashType, TransactionView},
        packed::CellOutput,
        prelude::*,
    },
    context::Context,
};
use molecule::prelude::{Builder, Entity};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

use crate::{
    campaign_creation, campaign_success, dao_harvest_contract, execution_mode,
    fixtures::{job_data, seeded_script},
    generated_campaign::CampaignDataV1,
    generated_dao_harvest::DaoHarvestPayloadV1,
    generated_recurring::RecurringPayloadV1,
    owner_mode, recurring_final, recurring_payout, top_up,
};

const MEASUREMENT_LIMIT: u64 = 40_000_000;
const REPORT_PATH: &str = "../benchmarks.json";

pub(crate) struct BenchmarkCase {
    id: &'static str,
    context: Context,
    transaction: TransactionView,
    expected_error: Option<i8>,
}

impl BenchmarkCase {
    pub(crate) fn new(
        id: &'static str,
        context: Context,
        transaction: TransactionView,
        expected_error: Option<i8>,
    ) -> Self {
        Self {
            id,
            context,
            transaction,
            expected_error,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    measurement: String,
    cycles: Vec<CycleMeasurement>,
    capacities: Vec<CapacityMeasurement>,
    payloads: Vec<PayloadMeasurement>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CycleMeasurement {
    id: String,
    outcome: String,
    measured_cycles: u64,
    budget_cycles: u64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CapacityMeasurement {
    id: String,
    data_bytes: usize,
    #[serde(
        serialize_with = "serialize_u64_string",
        deserialize_with = "deserialize_u64_string"
    )]
    occupied_shannons: u64,
}

fn serialize_u64_string<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.to_string())
}

fn deserialize_u64_string<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer)?
        .parse()
        .map_err(D::Error::custom)
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PayloadMeasurement {
    id: String,
    encoded_bytes: usize,
}

fn measure_rejection(case: &BenchmarkCase, expected_code: i8) -> u64 {
    let full_error = case
        .context
        .verify_tx(&case.transaction, MEASUREMENT_LIMIT)
        .expect_err("invalid benchmark transaction must fail");
    let full_error = format!("{full_error:?}");
    assert!(
        full_error.contains(&expected_code.to_string()),
        "{} returned an unexpected error: {full_error}",
        case.id
    );

    let mut low = 0;
    let mut high = MEASUREMENT_LIMIT;
    while low < high {
        let midpoint = low + (high - low) / 2;
        let result = case.context.verify_tx(&case.transaction, midpoint);
        let exhausted = result
            .as_ref()
            .err()
            .is_some_and(|error| format!("{error:?}").contains("ExceededMaximumCycles"));
        if exhausted {
            low = midpoint + 1;
        } else {
            high = midpoint;
        }
    }
    low
}

fn round_budget(measured: u64) -> u64 {
    let padded = measured + measured / 4;
    padded.div_ceil(100_000) * 100_000
}

fn cycle_measurements() -> Vec<CycleMeasurement> {
    let cases = execution_mode::benchmark_cases()
        .into_iter()
        .chain(owner_mode::benchmark_cases())
        .chain(top_up::benchmark_cases())
        .chain(campaign_creation::benchmark_cases())
        .chain(campaign_success::benchmark_cases())
        .chain(recurring_payout::benchmark_cases())
        .chain(recurring_final::benchmark_cases())
        .chain(dao_harvest_contract::benchmark_cases());

    cases
        .map(|case| {
            let (outcome, measured_cycles) = match case.expected_error {
                Some(code) => ("rejected", measure_rejection(&case, code)),
                None => (
                    "valid",
                    case.context
                        .verify_tx(&case.transaction, MEASUREMENT_LIMIT)
                        .unwrap_or_else(|error| panic!("{} failed: {error:?}", case.id)),
                ),
            };
            CycleMeasurement {
                id: case.id.to_owned(),
                outcome: outcome.to_owned(),
                measured_cycles,
                budget_cycles: round_budget(measured_cycles),
            }
        })
        .collect()
}

fn occupied(output: CellOutput, data: &Bytes) -> u64 {
    output
        .occupied_capacity(Capacity::bytes(data.len()).expect("benchmark data capacity"))
        .expect("benchmark occupied capacity")
        .as_u64()
}

fn capacity_measurements() -> (Vec<CapacityMeasurement>, Vec<PayloadMeasurement>) {
    let wallet_lock = seeded_script(0x11, ScriptHashType::Type, &[0x22; 20]);
    let short_payout_lock = seeded_script(0x13, ScriptHashType::Type, &[]);
    let compensation_lock = seeded_script(0x14, ScriptHashType::Data1, &[0x77; 160]);
    let permissionless_lock = seeded_script(0x12, ScriptHashType::Data1, &[]);
    let job_lock = seeded_script(0x33, ScriptHashType::Data1, &[]);
    let policy = seeded_script(0x44, ScriptHashType::Data1, &[0x55; 32]);
    let job = job_data([0x66; 32], policy.calc_script_hash().unpack(), 1, 1, 1);
    let campaign = CampaignDataV1::new_builder()
        .version(1_u16.to_le_bytes())
        .state(0)
        .campaign_id([0x11; 32])
        .pledged(1_u64.to_le_bytes())
        .pledge_count(1_u32.to_le_bytes())
        .target(1_u64.to_le_bytes())
        .deadline_since(1_u64.to_le_bytes())
        .success_lock_hash([0x22; 32])
        .refund_commitment([0x33; 32])
        .build()
        .as_bytes();
    let recurring = RecurringPayloadV1::new_builder()
        .version(1_u16.to_le_bytes())
        .owner_lock_hash([0x11; 32])
        .recipient_lock_hash([0x22; 32])
        .amount(1_u64.to_le_bytes())
        .interval_blocks(1_u64.to_le_bytes())
        .first_not_before(1_u64.to_le_bytes())
        .total_runs(1_u32.to_le_bytes())
        .reward(1_u64.to_le_bytes())
        .final_refund_kind(0)
        .build()
        .as_bytes();
    let dao_harvest = DaoHarvestPayloadV1::new_builder()
        .version(1_u16.to_le_bytes())
        .owner_lock_hash([0x11; 32])
        .payout_lock_hash([0x22; 32])
        .vault_lock_hash([0x33; 32])
        .dao_type_hash([0x44; 32])
        .principal_capacity(1_u64.to_le_bytes())
        .prepare_executor_set_hash([0x55; 32])
        .executor_reward(1_u64.to_le_bytes())
        .min_compensation(1_u64.to_le_bytes())
        .prepare_buffer_epochs(2_u64.to_le_bytes())
        .confirmation_margin_epochs(1_u64.to_le_bytes())
        .total_cycles(1_u32.to_le_bytes())
        .end_epoch_since(0_u64.to_le_bytes())
        .build()
        .as_bytes();

    let plain_output = CellOutput::new_builder().lock(wallet_lock.clone()).build();
    let short_payout_output = CellOutput::new_builder().lock(short_payout_lock).build();
    let compensation_output = CellOutput::new_builder().lock(compensation_lock).build();
    let job_output = CellOutput::new_builder()
        .lock(job_lock)
        .type_(Some(policy.clone()).pack())
        .build();
    let campaign_output = CellOutput::new_builder()
        .lock(permissionless_lock)
        .type_(Some(policy).pack())
        .build();

    (
        vec![
            CapacityMeasurement {
                id: "plain-wallet-cell".to_owned(),
                data_bytes: 0,
                occupied_shannons: occupied(plain_output, &Bytes::new()),
            },
            CapacityMeasurement {
                id: "short-payout-cell-v2-prototype".to_owned(),
                data_bytes: 0,
                occupied_shannons: occupied(short_payout_output, &Bytes::new()),
            },
            CapacityMeasurement {
                id: "compensation-cell-v2-prototype".to_owned(),
                data_bytes: 0,
                occupied_shannons: occupied(compensation_output, &Bytes::new()),
            },
            CapacityMeasurement {
                id: "job-cell-v1".to_owned(),
                data_bytes: job.len(),
                occupied_shannons: occupied(job_output, &job),
            },
            CapacityMeasurement {
                id: "campaign-cell-v1".to_owned(),
                data_bytes: campaign.len(),
                occupied_shannons: occupied(campaign_output, &campaign),
            },
        ],
        vec![
            PayloadMeasurement {
                id: "job-data-v1".to_owned(),
                encoded_bytes: job.len(),
            },
            PayloadMeasurement {
                id: "campaign-data-v1".to_owned(),
                encoded_bytes: campaign.len(),
            },
            PayloadMeasurement {
                id: "recurring-payload-v1".to_owned(),
                encoded_bytes: recurring.len(),
            },
            PayloadMeasurement {
                id: "deadline-campaign-payload-v1".to_owned(),
                encoded_bytes: 33,
            },
            PayloadMeasurement {
                id: "dao-harvest-payload-v1".to_owned(),
                encoded_bytes: dao_harvest.len(),
            },
        ],
    )
}

fn measured_report() -> Report {
    let (capacities, payloads) = capacity_measurements();
    Report {
        schema_version: 1,
        measurement: "ckb-testtool 1.1.1 CKB-VM fixture run".to_owned(),
        cycles: cycle_measurements(),
        capacities,
        payloads,
    }
}

#[test]
fn measured_contract_costs_match_the_committed_report() {
    let report_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(REPORT_PATH);
    let measured = measured_report();
    if std::env::var_os("AUTOMATA_UPDATE_BENCHMARKS").is_some() {
        fs::write(
            &report_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&measured).expect("serialize benchmark report")
            ),
        )
        .expect("write benchmark report");
        return;
    }

    let committed: Report = serde_json::from_slice(
        &fs::read(&report_path).expect("read committed contract benchmark report"),
    )
    .expect("parse committed contract benchmark report");
    assert_eq!(measured.schema_version, committed.schema_version);
    assert_eq!(measured.measurement, committed.measurement);
    assert_eq!(measured.capacities, committed.capacities);
    assert_eq!(measured.payloads, committed.payloads);
    assert_eq!(measured.cycles.len(), committed.cycles.len());
    for (measurement, budget) in measured.cycles.iter().zip(&committed.cycles) {
        assert_eq!(measurement.id, budget.id);
        assert_eq!(measurement.outcome, budget.outcome);
        assert!(
            budget.measured_cycles <= budget.budget_cycles,
            "{} has an invalid committed cycle budget",
            budget.id
        );
        assert!(
            measurement.measured_cycles <= budget.budget_cycles,
            "{} used {} cycles and exceeds its committed {} cycle budget",
            measurement.id,
            measurement.measured_cycles,
            budget.budget_cycles,
        );
    }
}
