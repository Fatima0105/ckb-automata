#![no_main]

use libfuzzer_sys::fuzz_target;
use molecule::prelude::Entity;

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
    include!("../../contracts/generated/job_v1.rs");
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
    include!("../../contracts/generated/campaign_v1.rs");
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
mod recurring_generated {
    include!("../../contracts/generated/recurring_v1.rs");
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
mod dao_harvest_generated {
    include!("../../contracts/generated/dao_harvest_v1.rs");
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
mod dao_harvest_v2_generated {
    include!("../../contracts/generated/dao_harvest_v2.rs");
}

fuzz_target!(|data: &[u8]| {
    let _ = job_generated::JobDataV1::from_slice(data);
    let _ = campaign_generated::CampaignDataV1::from_slice(data);
    let _ = recurring_generated::RecurringPayloadV1::from_slice(data);
    let _ = dao_harvest_generated::DaoHarvestPayloadV1::from_slice(data);
    let _ = dao_harvest_v2_generated::DaoHarvestPayloadV2::from_slice(data);
    let _ = dao_harvest_v2_generated::DaoHarvestProgressV2::from_slice(data);
    let _ = dao_harvest_v2_generated::DaoHarvestPrepareCreditV2::from_slice(data);
    let _ = dao_harvest_v2_generated::DaoHarvestEnvelopeV2::from_slice(data);
    let _ = dao_harvest_v2_generated::DaoHarvestWitnessV2::from_slice(data);
});
