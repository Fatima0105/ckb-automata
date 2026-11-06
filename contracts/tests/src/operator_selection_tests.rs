use super::operator_selection::{execution_since_allowed, takeover_block};

#[test]
fn preferred_operator_can_execute_at_the_scheduled_block() {
    let preferred = [1_u8; 32];
    assert!(execution_since_allowed(
        1_000, 1_012, 1_000, &preferred, &preferred, 12,
    ));
}

#[test]
fn another_operator_must_wait_for_takeover() {
    let preferred = [1_u8; 32];
    let fallback = [2_u8; 32];
    assert!(!execution_since_allowed(
        1_000, 1_012, 1_000, &preferred, &fallback, 12,
    ));
    assert!(execution_since_allowed(
        1_000, 1_012, 1_012, &preferred, &fallback, 12,
    ));
}

#[test]
fn an_uncommitted_takeover_block_is_rejected() {
    let preferred = [1_u8; 32];
    assert!(!execution_since_allowed(
        1_000,
        1_011,
        1_011,
        &preferred,
        &[2_u8; 32],
        12,
    ));
    assert_eq!(takeover_block(u64::MAX, 12), None);
}
