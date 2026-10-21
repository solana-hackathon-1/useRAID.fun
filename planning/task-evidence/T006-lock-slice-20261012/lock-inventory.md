# A1 acquisition inventory — reviewed2992a78 candidate

All existing explicit blocking/try transaction advisory sites were inspected and routed through the shared builder. Closed order: global → finance → reward → x-endpoint → tracking → post → balance → wallet-subject → x-auth. Actual acquisitions are sequential, IDs code-unit sorted. Root/child stages follow. No new global mutex or changed label/seed was introduced.

| Sources | Existing acquisition/composition preserved |
| --- | --- |
| lib/providers/x | global729102 usage reservation; endpoint keys in separate endpoint transactions |
| lib/queue | global729104 job queue transaction |
| lib/campaigns, pump-launch, studio-targets, API launch renew/admin | global729103 coordination; downstream declared tracking/balance prefixes follow it |
| lib/studio-campaigns | publish729103 → tracking → balance; draft tracking scopes remain separate |
| lib/studio-finance | tracking → sorted balances → full sorted User set (creator SHARE, recipient KEY SHARE) before all bulk User FKs; release tracking/balance remains |
| lib/rewards | finance:launch coordinator; reward:launch → tracking on reviewed settlement transactions |
| lib/tracking | tracking:raid → sorted post IDs; source tracking rehome uses only a nonblocking try-lock and cannot introduce a wait at that acquisition |
| lib/usdc | balance:user prefix, now shared key builder; money arithmetic/business SQL unchanged |
| wallet/X/absorb/public identity modules | declared balance prefix where necessary → all old/new wallet subjects → all X keys → sorted final User roots → ordered concrete children |
| cleanup/logout/attempt claim/discard | bounded autonomous leaf, no later advisory/root acquisition |

Runtime rejects a new lower blocking class or any new advisory after roots. Within-plan aliases/fixed-key collisions reject before acquisition; cross-plan unseen hash aliases remain an assumption/risk. Triggers take the already-held wallet subject for new-version identity writes; both trigger equality checks pass. The existing trigger alone does not acquire a moved WalletIdentity's subject, so explicit old/new/moved-key acquisition remains required.

This inventory is complete for the pinned local candidate, not GitHub148b95f: new onboarding/Guild consumers and User FKs need reconciliation and independent review. Passing deterministic suites do not prove every financial/network/implicit unique-index wait or all load schedules.
