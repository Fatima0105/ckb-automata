# Operator Selection V1

Scheduled payments, recurring payments, and DAO Harvest let the user choose an operator during setup. The choice does not give that operator custody of the user's funds or permission to change the automation.

For scheduled and recurring payments, the Job Cell commits:

- the exact preferred operator lock hash;
- the scheduled block;
- a fixed takeover delay; and
- the resulting takeover block.

At the scheduled block, only the preferred operator can process the payment. At the takeover block, any compatible operator can process it. The operator must co-spend a fee cell controlled by the same lock that receives the fixed executor reward. CKB accepts only one spend of the Job Cell, so competing transactions cannot both succeed.

The `OperatorPayloadV1` envelope contains the preferred operator, takeover delay, and the existing policy payload. Its domain-separated hash is committed by `JobDataV1.payload_hash`. `job-lock-v3` enforces operator identity and timing, while `deadline-policy-v2` or `recurring-policy-v2` continues to enforce the recipient, amount, state transition, and value conservation.

Recurring successors advance both bounds from the immutable schedule. A late execution never shifts a future payment date. Existing V1 jobs remain on their original contracts and wire format.

DAO Harvest uses its V2 payload and operator-set rules because preparation and claiming are separate actions. The product presents the selection consistently, but the DAO wire format remains separate from `OperatorPayloadV1`.

An owner may run the public operator with their own key after takeover. An independent operator needs no CKAutomata database or Redis access. Full recipient scripts that are not visible in the creation transaction must be supplied as lock-resolution data; their hashes are verified against the immutable job commitment.
