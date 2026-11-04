use ckb_hash::new_blake2b;

pub const DAO_HARVEST_V2_VERSION: u16 = 2;
pub const MAX_FALLBACK_PREPARE_OPERATORS: usize = 8;
pub const ABSENT_INDEX: u32 = u32::MAX;
pub const COMPENSATION_LOCK_ARGS_LENGTH: usize = 160;

pub const SETUP_OPERATION: u8 = 0;
pub const PREFERRED_PREPARE_OPERATION: u8 = 1;
pub const FALLBACK_PREPARE_OPERATION: u8 = 2;
pub const PREFERRED_CLAIM_OPERATION: u8 = 3;
pub const FALLBACK_CLAIM_OPERATION: u8 = 4;
pub const OWNER_COMPLETE_OPERATION: u8 = 5;
pub const SWEEP_OPERATION: u8 = 6;
pub const CLOSE_OPERATION: u8 = 7;
pub const ROTATE_OPERATION: u8 = 8;
pub const RECOVER_OPERATION: u8 = 9;

pub const DEPOSITED_STATE: u8 = 0;
pub const WITHDRAWING_STATE: u8 = 1;

const PAYLOAD_DOMAIN: &[u8] = b"ckb-automata/dao-harvest-payload/v2";
const PROGRESS_DOMAIN: &[u8] = b"ckb-automata/dao-harvest-progress/v2";
const PREPARE_CREDIT_DOMAIN: &[u8] = b"ckb-automata/dao-harvest-prepare-credit/v2";
const FALLBACK_SET_DOMAIN: &[u8] = b"ckb-automata/dao-harvest-fallback-set/v2";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompensationLockArgsV2 {
    pub job_id: [u8; 32],
    pub owner_lock_hash: [u8; 32],
    pub payout_lock_hash: [u8; 32],
    pub policy_script_hash: [u8; 32],
    pub payload_hash: [u8; 32],
}

fn domain_hash(domain: &[u8], parts: &[&[u8]]) -> Option<[u8; 32]> {
    let body_length = parts
        .iter()
        .try_fold(0_usize, |total, part| total.checked_add(part.len()))?;
    let body_length = u32::try_from(body_length).ok()?;
    let mut hasher = new_blake2b();
    hasher.update(domain);
    hasher.update(&[0]);
    hasher.update(&body_length.to_le_bytes());
    for part in parts {
        hasher.update(part);
    }
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    Some(result)
}

pub fn payload_hash(policy_script_hash: &[u8; 32], payload: &[u8]) -> Option<[u8; 32]> {
    domain_hash(PAYLOAD_DOMAIN, &[policy_script_hash, payload])
}

pub fn progress_hash(progress: &[u8]) -> Option<[u8; 32]> {
    domain_hash(PROGRESS_DOMAIN, &[progress])
}

pub fn prepare_credit_hash(credit: &[u8]) -> Option<[u8; 32]> {
    domain_hash(PREPARE_CREDIT_DOMAIN, &[credit])
}

pub fn fallback_operator_set_hash(
    operator_lock_hashes: &mut [[u8; 32]],
) -> Option<[u8; 32]> {
    if operator_lock_hashes.is_empty()
        || operator_lock_hashes.len() > MAX_FALLBACK_PREPARE_OPERATORS
    {
        return None;
    }
    operator_lock_hashes.sort_unstable();
    if operator_lock_hashes
        .windows(2)
        .any(|pair| pair[0] == pair[1])
    {
        return None;
    }
    let count = u32::try_from(operator_lock_hashes.len()).ok()?;
    let count_bytes = count.to_le_bytes();
    let mut parts = Vec::with_capacity(operator_lock_hashes.len() + 1);
    parts.push(count_bytes.as_slice());
    parts.extend(operator_lock_hashes.iter().map(<[u8; 32]>::as_slice));
    domain_hash(FALLBACK_SET_DOMAIN, &parts)
}

pub fn decode_fallback_operator_proof(
    bytes: &[u8],
    expected_hash: &[u8; 32],
) -> Option<Vec<[u8; 32]>> {
    if bytes.is_empty()
        || !bytes.len().is_multiple_of(32)
        || bytes.len() > MAX_FALLBACK_PREPARE_OPERATORS * 32
    {
        return None;
    }
    let operators = bytes
        .chunks_exact(32)
        .map(|chunk| chunk.try_into().ok())
        .collect::<Option<Vec<[u8; 32]>>>()?;
    if operators.windows(2).any(|pair| pair[0] >= pair[1]) {
        return None;
    }
    let mut hashed = operators.clone();
    (fallback_operator_set_hash(&mut hashed)? == *expected_hash).then_some(operators)
}

pub fn encode_compensation_lock_args(input: &CompensationLockArgsV2) -> [u8; 160] {
    let mut encoded = [0_u8; COMPENSATION_LOCK_ARGS_LENGTH];
    for (index, value) in [
        input.job_id,
        input.owner_lock_hash,
        input.payout_lock_hash,
        input.policy_script_hash,
        input.payload_hash,
    ]
    .iter()
    .enumerate()
    {
        let start = index * 32;
        encoded[start..start + 32].copy_from_slice(value);
    }
    encoded
}

pub fn decode_compensation_lock_args(bytes: &[u8]) -> Option<CompensationLockArgsV2> {
    if bytes.len() != COMPENSATION_LOCK_ARGS_LENGTH {
        return None;
    }
    Some(CompensationLockArgsV2 {
        job_id: bytes[0..32].try_into().ok()?,
        owner_lock_hash: bytes[32..64].try_into().ok()?,
        payout_lock_hash: bytes[64..96].try_into().ok()?,
        policy_script_hash: bytes[96..128].try_into().ok()?,
        payload_hash: bytes[128..160].try_into().ok()?,
    })
}

pub fn operation_is_supported(operation: u8) -> bool {
    operation <= RECOVER_OPERATION
}
