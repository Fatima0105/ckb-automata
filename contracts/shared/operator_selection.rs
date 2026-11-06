use ckb_hash::new_blake2b;

const POLICY_PAYLOAD_DOMAIN: &[u8] = b"ckb-automata/policy-payload/v1";

pub fn payload_hash(policy_script_hash: &[u8; 32], payload: &[u8]) -> [u8; 32] {
    let body_length = policy_script_hash.len() + payload.len();
    let mut hasher = new_blake2b();
    hasher.update(POLICY_PAYLOAD_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&(body_length as u32).to_le_bytes());
    hasher.update(policy_script_hash);
    hasher.update(payload);
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    result
}

pub fn takeover_block(not_before: u64, delay: u64) -> Option<u64> {
    if delay == 0 || not_before >> 56 != 0 {
        return None;
    }
    let takeover = not_before.checked_add(delay)?;
    (takeover >> 56 == 0).then_some(takeover)
}

#[allow(dead_code)]
pub fn execution_since_allowed(
    committed_since: u64,
    takeover_since: u64,
    actual_since: u64,
    preferred_executor: &[u8],
    executor: &[u8],
    delay: u64,
) -> bool {
    takeover_block(committed_since, delay) == Some(takeover_since)
        && ((actual_since == committed_since && executor == preferred_executor)
            || actual_since == takeover_since)
}
