# Problem 6: Live scoreboard module

## Purpose and scope

Specify a backend module that awards points for verified action completions and
publishes a live leaderboard of the ten highest scoring users. This document is
the implementation contract for the backend team; it does not implement a server.

The module must:

1. Award a server-defined positive integer score increase to the authenticated
   user who completed an authorized action.
2. Award each completion at most once, including concurrent requests and retries.
3. Return a deterministic top ten and push committed changes to connected browsers.
4. Recover from process failures and disconnected clients without losing awards.

Action mechanics, login, and profile management belong to existing services.
This specification is independent of the SQLite CRUD application in Problem 5.

## Assumptions and trust boundary

- There is one global, cumulative scoreboard. Scores start at zero, never decrease
  through the public API, and only users with a positive score appear on the board.
  With fewer than ten such users, return all of them.
- An existing authentication service establishes a server-validated session.
  Middleware supplies an immutable `principal.userId` and checks account eligibility.
  Never accept an identity supplied in the score request as authentication.
- A trusted action verifier can independently establish that an action completed.
  It creates a completion record and returns its opaque UUID to the browser.
  This verifier may be a module in the same backend or a service using authenticated
  internal communication and a narrowly scoped database role.
- The verifier assigns the owner, canonical action occurrence ID, positive points,
  policy version, completion time, and expiry. It derives points from server-side
  rules. Completion records are immutable after issuance and expire after 24 hours
  if unclaimed, unless product requirements set a different claim window.
- The browser calls the score API after completion, supplying only the completion
  ID. Possession of an ID is not sufficient: the record must belong to the session's
  user and be eligible for redemption.
- The initial deployment targets at most 20 awards/second and 5,000 connected
  viewers. These are planning assumptions to validate by load testing, not measured
  capacity guarantees.

**Required integration:** a client-only assertion such as `completed: true`, a
browser-generated signature, or an authenticated session does not prove an action
was completed. If no trusted verifier exists, the anti-cheating requirement cannot
be met. The action team must provide this integration before score writes go live.

## Architecture and execution flow

Use an Express/TypeScript API, PostgreSQL as the source of truth, and Server-Sent
Events (SSE) for browser updates. SSE fits the one-way notification requirement;
score writes remain ordinary HTTP requests.

Each API instance runs a lightweight broadcaster that polls committed scoreboard
snapshots every 250 ms. Instances share the database but maintain their own client
connections and polling cursor. No in-memory value is authoritative for awarding
points. The first implementation needs no Redis or message broker.

```mermaid
sequenceDiagram
    autonumber
    participant Browser
    participant Verifier as Trusted action verifier
    participant API as Score API
    participant DB as PostgreSQL
    participant Broadcaster as Broadcaster on each API instance
    participant Viewers as Connected browsers

    Browser->>Verifier: Perform action through existing action flow
    Verifier->>Verifier: Independently verify completion and determine points
    Verifier->>DB: Persist immutable completion, bound to user and occurrence
    Verifier-->>Browser: completionId
    Browser->>API: POST /v1/score-awards with session, CSRF token, completionId
    API->>API: Authenticate, check eligibility, validate and rate-limit
    API->>DB: BEGIN; lock singleton scoreboard revision row
    API->>DB: Look up completion and existing award
    alt Already credited to this user
        DB-->>API: Original award receipt
        API->>DB: End transaction without mutation
        API-->>Browser: 200, original receipt
    else Invalid, foreign, or expired completion
        API->>DB: ROLLBACK
        API-->>Browser: Structured 4xx error
    else Authorized new completion
        API->>DB: Insert award; atomically increment user's score
        API->>DB: Increment revision; build top ten; insert snapshot event
        API->>DB: COMMIT all changes together
        API-->>Browser: 201, award receipt and revision
        Broadcaster->>DB: Poll newest committed snapshot
        DB-->>Broadcaster: Revision and complete top ten
        Broadcaster-->>Viewers: SSE leaderboard event
    end
```

The browser opens the leaderboard stream when the page loads; it does not wait
for its own first action. The stream starts with a complete current snapshot.

## Data model and invariants

Use UUIDs for user, completion, and award IDs. Store scores and revisions as signed
64-bit integers, constrained to nonnegative values. Encode all scores and revisions
as decimal strings in JSON to avoid JavaScript integer precision loss.

| Table | Required columns and constraints |
| --- | --- |
| `users` (existing) | `id UUID PRIMARY KEY`, approved public `display_name`; account/session eligibility is supplied by authentication |
| `action_completions` | `id UUID PRIMARY KEY`, `user_id` FK, `issuer`, `action_occurrence_id`, `points BIGINT CHECK(points > 0)`, `policy_version`, `completed_at`, `expires_at`; unique `(issuer, action_occurrence_id)` and `expires_at > completed_at` |
| `user_scores` | `user_id UUID PRIMARY KEY` FK, `score BIGINT NOT NULL CHECK(score >= 0)`, `updated_at`; index `(score DESC, user_id ASC)` |
| `score_awards` | `id UUID PRIMARY KEY`, `completion_id UUID UNIQUE` FK, `user_id` FK, `points BIGINT CHECK(points > 0)`, `score_after BIGINT CHECK(score_after >= points)`, `board_revision BIGINT UNIQUE CHECK(board_revision > 0)`, `credited_at`; immutable audit and retry receipt |
| `scoreboard_state` | Exactly one row: `id = 1`, `revision BIGINT NOT NULL CHECK(revision >= 0)` |
| `scoreboard_events` | `revision BIGINT PRIMARY KEY`, `snapshot JSONB NOT NULL`, `committed_at`; durable publication record containing the full leaderboard response |

Initialize revision `0` and its empty snapshot in a migration. Retain at least the
latest event during cleanup. Event creation must be part of the award transaction,
not a second write after commit. This is a transactional outbox: a committed score
always has a durable notification record, even if the application crashes before
responding or broadcasting.

`score_awards.user_id` and `points` must match the corresponding completion. Enforce
this through a constrained write routine or a trigger in addition to application
checks; the ordinary API database role must not insert arbitrary completion records.
Use separate least-privilege roles for completion issuance and score redemption.
Expose score mutation through the constrained redemption routine and deny direct
score/award/event writes to the ordinary API role. The broadcaster uses read-only
permissions. All required columns above are `NOT NULL` unless explicitly optional.

Invariant: a user's score equals the sum of their committed award points. The unique
completion constraint is the final protection against duplicate awards. Never
delete award or completion identifiers to make an old occurrence redeemable again.
Archival must preserve their deduplication constraints.

## HTTP contracts

All endpoints use HTTPS. Successful JSON responses have `Cache-Control: no-store`.
Unknown write fields are rejected; request bodies are limited to 2 KB. IDs must be
valid UUIDs. Public responses expose only public user IDs, display names, and scores,
not completion records, session data, email addresses, or internal action details.

### `POST /v1/score-awards`

Requires a valid session and CSRF protection. Accept exactly:

```json
{ "completionId": "758ef9ac-2d09-4696-8097-07f210ea324a" }
```

There is no `score`, `delta`, `points`, or `userId` input. The completion UUID serves
as the operation's idempotency identifier, so a separate idempotency key is not
required. Clients must retry with the same ID after a timeout or ambiguous response.

Return `201 Created` for a new award and `200 OK` for a retry of an existing award
owned by the authenticated user. Both return the original stored receipt:

```json
{
  "awardId": "a98e6d9a-b5dc-477c-a812-0702b4d76e50",
  "completionId": "758ef9ac-2d09-4696-8097-07f210ea324a",
  "pointsAwarded": "25",
  "scoreAfterAward": "125",
  "boardRevision": "42",
  "creditedAt": "2026-10-14T08:00:00.000Z"
}
```

`scoreAfterAward` is the total immediately after this award, not necessarily the
user's current total when a later retry arrives. `boardRevision` identifies the
committed snapshot containing the award. A retry never creates another event.

### `GET /v1/leaderboard`

Public, read-only endpoint. Return `200 OK` with the latest committed snapshot:

```json
{
  "revision": "42",
  "generatedAt": "2026-10-14T08:00:00.000Z",
  "entries": [
    {
      "rank": 1,
      "userId": "781e0c6d-a154-451e-a6a8-d193ba2c6ea6",
      "displayName": "Player One",
      "score": "125"
    }
  ]
}
```

Rank by `score DESC, user_id ASC`, limit to ten, and assign consecutive ranks 1 to
10. Equal scores use the stable UUID order; shared ranks are not used. Build the
snapshot inside the write transaction with this query:

```sql
SELECT s.user_id, u.display_name, s.score
FROM user_scores AS s
JOIN users AS u ON u.id = s.user_id
WHERE s.score > 0
ORDER BY s.score DESC, s.user_id ASC
LIMIT 10;
```

The read endpoint selects the latest `scoreboard_events` row. It must not read
scores and revision through separate queries that could describe different commits.

### `GET /v1/leaderboard/stream`

Public SSE endpoint, responding with `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-transform`, and proxy buffering disabled. Flush headers
immediately. Send a complete snapshot on every connection, followed by newer full
snapshots. Use event name `leaderboard-reset` for the first snapshot and
`leaderboard` for subsequent updates. Example update wire format, with a blank line
terminating each event:

```text
retry: 3000

id: 42
event: leaderboard
data: {"revision":"42","generatedAt":"2026-10-14T08:00:00.000Z","entries":[]}

```

The wire example illustrates framing; actual event data must contain the complete
stored entries for that revision. Send a comment heartbeat `: keepalive` followed
by a blank line every 15 seconds. Configure proxy idle timeouts above 45 seconds.

Connection initialization must not lose an update between fetching the snapshot
and attaching the client:

1. Register the client with the local broadcaster in a buffering state.
2. Fetch the newest committed snapshot from PostgreSQL and send it as `leaderboard-reset`.
3. Flush any buffered snapshot with a higher revision, then enter normal delivery.
4. On every send, discard revisions less than or equal to the last one sent.

The broadcaster polls the highest committed event revision and broadcasts it when
newer than its local cursor. It may coalesce intermediate revisions because every
message replaces the entire board. Each instance polls independently; there is no
global `published` flag that could cause other instances to miss an update.

EventSource reconnects automatically and can send `Last-Event-ID`. This protocol
intentionally resynchronizes with the latest full snapshot rather than replaying
every award. Treat the header as an untrusted hint, not authorization or permission
to skip initialization. On reconnect, send the latest snapshot even if the client's
reported cursor is ahead of the server.

The frontend accepts `leaderboard-reset` as the current baseline for that connection,
including after a restored database or misleading reconnect cursor. It compares
subsequent revisions using `BigInt`, replaces the board atomically, and ignores
older or duplicate snapshots. Events from an abandoned connection must not overwrite
the active connection's state. It uses the GET endpoint every five seconds
as a fallback when SSE is unavailable, and refreshes immediately when the tab
becomes active. Scores are rendered as strings; names are rendered as text, not HTML.

### Errors

```json
{
  "error": {
    "code": "COMPLETION_UNAVAILABLE",
    "message": "Completion cannot be redeemed",
    "requestId": "d8bc3323-7d96-45a4-a610-859c530511c1"
  }
}
```

| Status | Code and behavior |
| --- | --- |
| 400 | `INVALID_REQUEST`: malformed JSON, invalid UUID, or unexpected fields |
| 401 | `UNAUTHENTICATED`: missing or expired session |
| 403 | `FORBIDDEN`: ineligible account, invalid CSRF token, or disallowed origin |
| 404 | `COMPLETION_UNAVAILABLE`: nonexistent completion or one owned by someone else; same response prevents ownership disclosure |
| 409 | `COMPLETION_EXPIRED`: owned, uncredited completion past its claim window; `COMPLETION_INVALID` for an owned record that fails issuer, timestamp, or policy checks; `SCORE_LIMIT_REACHED` for integer overflow |
| 413 / 415 | `BODY_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED`: include `Retry-After` |
| 503 | `TEMPORARILY_UNAVAILABLE`: database unavailable or transaction retry budget exhausted; client retries the same completion ID |

Unexpected failures return a generic 500 error and a request ID; never return SQL,
tokens, stack traces, or completion details belonging to another user. SSE failures
after headers are flushed close the stream, causing reconnection; do not attempt
to write a JSON HTTP error into an established stream.

## Award transaction and concurrency

Use a short PostgreSQL transaction at `READ COMMITTED`. Do not call an external
verifier while holding locks; the verified completion must already be persisted.
All scoreboard mutations acquire locks in this order:

1. Begin and acquire `SELECT revision FROM scoreboard_state WHERE id = 1 FOR UPDATE`.
   This serializes awards for the initial global-board implementation and establishes
   a revision order matching commit order.
2. Read the completion and require its `user_id` to equal the authenticated principal.
   Unknown and foreign completions return the same 404 response.
3. Look up the existing award by `completion_id`. If it exists, return its stored
   receipt without changing scores, revision, or event history. Check ownership
   before returning anything. This check precedes expiry so previously successful
   awards remain safely retryable after the claim window ends.
4. For an uncredited completion, validate its expiry against database wall-clock
   time at redemption (`clock_timestamp()` after lock acquisition), completion time,
   positive points, trusted issuer, and supported policy version. Reject a future
   completion time or untrusted record. The verifier is responsible for enforcing
   per-action eligibility before issuing a completion.
5. Create a zero-score row for the user if needed. Atomically add the stored points
   with `UPDATE ... SET score = score + :points ... RETURNING score`; do not perform
   an unlocked application read-modify-write. Check score and revision overflow.
6. Increment the singleton revision, insert the immutable award receipt, query the
   deterministic top ten, and insert its full snapshot event with that revision.
7. Commit, then respond to the caller. Any error rolls back every write together.

Use parameterized SQL throughout. Give lock waits a two-second budget and the
transaction a three-second statement-timeout ceiling; use at most two retries with
jitter for deadlocks or serialization failures, within a ten-second request budget.
The application must also bound total transaction time; a per-statement timeout
alone is not a total transaction deadline.
Do not retry invalid completions or authorization errors. A unique-constraint
conflict requires rolling back and resolving the existing receipt in a fresh
transaction; never continue using an aborted transaction.

Keeping the revision lock until commit means snapshot creation observes all earlier
scoreboard transactions and its own award. It also prevents revision 43 from
committing before revision 42. Publishing can lag the HTTP response, but must never
include an uncommitted score.

All future operations that affect board contents, including profile-name changes,
account hiding, or administrative score corrections, must use this mutation and
event protocol. They cannot bypass the revision lock or alter published snapshots
in place. Those workflows are outside the first release and require explicit
authorization and audit design before implementation.

## Authorization and abuse controls

- Validate the session through the existing authentication middleware on every
  write. Use Secure, HttpOnly session cookies and `SameSite=Lax` or stricter.
  Validate both the CSRF token and the exact approved Origin for POST requests;
  reject a missing or unapproved origin on the browser-facing write endpoint.
- Restrict CORS to configured frontend origins. CORS is not authentication: direct
  HTTP callers must still pass all session, ownership, and completion checks.
- Only the trusted verifier may issue completions. Internal service credentials
  must never be available to the browser. Enforce a unique canonical occurrence
  across retries so repeatedly issuing fresh UUIDs cannot multiply one action's reward.
- Make completion ownership and points immutable. The public API cannot change
  records, choose a recipient, or request an arbitrary increase.
- Start with a shared token-bucket limit of 30 award requests/minute/user, burst 10,
  and 120/minute/IP, burst 30. Implement counters at the shared gateway or shared
  rate-limit store, not separately in each API process. Tune legitimate action
  frequency and shared-network behavior before launch. Fail closed for score writes
  if required abuse-control infrastructure is unavailable.
- Limit public reads to 120/minute/IP and streams to five concurrent connections/IP,
  adjustable for shared networks. Enforce a tested per-instance stream capacity.
  Bound slow-client buffers to one pending snapshot; coalesce or disconnect clients
  whose writes remain blocked beyond ten seconds.
- Record audit metadata and request IDs without logging session cookies or CSRF
  secrets. Alert on repeated invalid redemptions, unusual issuance volume, and
  unexpected score growth. Rate limiting supplements verified completion; it does
  not itself prove that an action was authorized.

## Reliability, operations, and acceptance criteria

Target live delivery within one second of commit at the planned load under healthy
conditions (p95), and score-write latency below 500 ms (p95). These are acceptance
targets to measure. Database failure must cause writes to fail rather than award
points in memory. If SSE polling fails, retain the last visible board, mark the UI
as reconnecting/stale, retry with backoff, and resynchronize from the newest snapshot
when the database recovers.

Keep all award receipts for audit and deduplication. Prune older snapshot events
after 24 hours while always retaining the newest event; clients do not require
historical replay. Back up PostgreSQL, test restoration, and reconcile stored user
scores against the award ledger. Recovery must preserve both receipts and scores.

Measure write latency, rejection reasons, duplicate redemptions, revision-lock wait
time, active streams, slow-client disconnects, poll failures, and publication lag.
Do not interpret an old latest-event timestamp as lag when no new award exists:
publication lag is the time between an unprocessed commit and its broadcast.

The backend team must verify these cases before release:

| Scenario | Expected result |
| --- | --- |
| Valid completion and session | One award, one score increment, one committed revision/event |
| Missing session, invalid CSRF, or blocked account | Rejected with no persistent mutation |
| Forged UUID or another user's completion | Same generic 404; no mutation or ownership leak |
| Request contains `points`, `userId`, or `score` | 400; client cannot influence reward values |
| Completion issuance retries | Unique canonical occurrence prevents multiple redeemable records |
| Repeated or simultaneous requests for one completion | Exactly one award; successful retries return the same receipt |
| Different completions redeemed concurrently by one user | Both legitimate increases retained; no lost update |
| Different users score concurrently | Unique ordered revisions and snapshots consistent with committed scores |
| Completion expires while waiting for the lock | Rejected unless it was already credited |
| Response lost after commit | Retry returns original receipt; no additional score or event |
| Failure before commit | Award, score, revision, and snapshot all rolled back |
| Process dies after commit, before broadcast | Other or restarted instance discovers persisted snapshot |
| More than ten users or tied scores | Correct top ten, ordered by score then UUID, consecutive ranks |
| Reconnect, misleading Last-Event-ID, or update during connection setup | Latest complete board delivered without a stale initialization overwriting it |
| Two API instances and multiple viewers | Each instance updates its own clients; no globally consumed notification |
| Duplicate or reordered events | Frontend ignores nonincreasing revisions |
| Overflow or database/rate-limit outage | No partial award; documented error and safe retry behavior |
| Slow viewer or repeated connects | Bounded memory and connection counts; healthy viewers continue receiving updates |

## Improvements and decisions for later releases

1. **Scale writes after measuring lock contention.** The singleton lock deliberately
   favors a simple, provably consistent first release, but serializes all awards.
   For higher throughput, partition by independent board/season or maintain a
   leaderboard projection asynchronously from the award ledger. That redesign must
   define ordering, freshness, and recovery; a database sequence alone does not
   guarantee commit ordering.
2. **Reduce database polling when needed.** Add a broker or Redis to signal new
   snapshots and distribute fan-out. Keep PostgreSQL outbox recovery as the durable
   path; ephemeral pub/sub alone can lose changes during disconnects. Benchmark a
   Redis sorted-set projection before adding it, including matching the UUID tie
   rule and rebuilding from authoritative data.
3. **Strengthen action-specific anti-cheating.** Ask the action owner to define
   eligibility, completion verification, frequency limits, and bot detection.
   Additional human verification can be applied to suspicious flows. A trusted
   verifier that issues rewards too freely remains a security gap despite correct
   score API authorization.
4. **Define product policies before extending the board.** Seasons, resets, negative
   corrections, bans, hidden users, and profile changes need explicit rules. Use
   audited compensating ledger entries for corrections rather than rewriting awards.
   Partition completion deduplication and revisions carefully if seasons are added.
5. **Validate performance and recovery.** Load-test the stated traffic assumptions,
   SSE proxy settings, and slow-client behavior. Run crash-injection and restore
   drills. Consider HTTP/2 and sharing one stream between browser tabs if connection
   limits become a practical concern.

## References

- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
  and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
  describe the database concurrency primitives used by the proposed transaction.
- [WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)
  defines event framing, reconnection, and `Last-Event-ID` behavior.
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
  provides guidance on endpoint authorization and request validation.
- [OWASP API6: Unrestricted Access to Sensitive Business Flows](https://api-security.owasp.org/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/)
  explains why authenticated business flows still need abuse controls.
