# Manual UAT plan for a human (risk order)

Every review so far was a same-model agent reading code and tests written by the same model family. Nothing here has been verified by a person. Treat each section below as NOT VERIFIED until a named person records Pass/Fail/Blocked at a named SHA. This file is a checklist, not evidence; the fuller journey catalogue is [raid-uat-plan.md](../raid-uat-plan.md).

**Ground rules.** Simulated funds only; synthetic accounts and data; throwaway local Postgres; never a production database or live wallet. Feature flags default off, so each section names the flags to turn on in the test environment. Record tester, SHA, date, observed result and screenshots per step. A Fail on a section marked HIGH blocks the dependent feature until fixed and retested.

**Provenance.** The steps were written from the docs, routes and flag list, not by driving the UI. Where a screen does not exist yet (several features are HTTP-only), use the API or test host and record how; a missing screen is a finding, not a skipped step.

**Setup once.** Check out the candidate SHA, `docker compose -p useraid-test -f compose.yaml -f compose.test.yaml up -d --wait db`, `export DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55432/useraid_test`, `npm ci && npm run db:migrate`, then `DEMO_MODE=false npm run dev` with the flags a section needs in `.env.local`. Use two browser profiles (a Founder and a Raider) and a third for an unrelated signed-in stranger; one signed-out window.

| #   | Area                                    | Risk | Needs flags                                                                                 |
| --- | --------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 1   | Simulated funding, reservation, closure | HIGH | WORK_ACCEPTANCE_ENABLED, WORK_START_ENABLED, WORK_SUBMISSIONS_ENABLED, WORK_REVIEWS_ENABLED |
| 2   | Capacity and one active Raid            | HIGH | as 1                                                                                        |
| 3   | Sign-in, wallet links, account folds    | HIGH | WALLET_LINKS_ENABLED, ACCOUNT_FOLDS_ENABLED                                                 |
| 4   | Guild roles, grants, ownership transfer | HIGH | Guild flags (see #299 and `.env.example`)                                                   |
| 5   | Upgrade over existing data              | HIGH | none                                                                                        |
| 6   | Visibility and private data leaks       | MED  | all above                                                                                   |
| 7   | Applications, offers, amendments        | MED  | as 1                                                                                        |
| 8   | Practice trials, assessments, reviewers | MED  | PRACTICE\_\* and SKILL\_\*                                                                  |
| 9   | Notifications                           | MED  | notifications flag in `.env.example`                                                        |
| 10  | Guild drafts, proposals, onboarding     | LOW  | GUILD_DRAFTS_ENABLED, GUILD_PROJECT_PROPOSALS_ENABLED, RAIDER_ONBOARDING_ENABLED            |
| 11  | Public pages, feed, mobile, a11y        | LOW  | WORK_FEED_READS_ENABLED, GUILD_PUBLIC_READS_ENABLED                                         |
| 12  | Default-off proof                       | MED  | none                                                                                        |

## 1. Simulated funding, reservation, closure — HIGH

Risk: money-shaped state moves wrongly or twice; a label implies real funds. Agents tested the code they wrote, so look for what a user would be shown, not what the database holds.

1. As Founder create a funded Raid (`/creator/work/new`), set a reward, publish. Expected: every amount is labelled simulated; no screen says real USDC, escrow released or paid.
2. Fund twice quickly (double click, then reload and repeat). Expected: one reservation; a second attempt shows the same result, not a second charge.
3. Accept the offer as Raider with consent, then try to accept again from a second tab. Expected: second tab shows already accepted, no duplicate engagement.
4. Submit work, approve it as Founder, then try to approve or reject again. Expected: closure happens once; later attempts are refused with a readable reason.
5. Amend the reward after acceptance (see 7). Expected: the reserved amount the Raider consented to is unchanged unless they consent to the new one.
6. Check Founder and Raider balance/summary views after each step. Expected: totals add up by hand; nothing negative; nothing released that was not approved.

## 2. Capacity and one active Raid — HIGH

Risk: races that only appear with two humans acting at once; tests assert the database result, a person notices the experience.

1. Create a Raid with one slot. Two Raiders open it; both press Accept at the same moment (two windows, count down together). Expected: exactly one succeeds; the other sees a clear "full" message.
2. As a Raider with one active Raid, try to start or accept a second. Expected: refused with the reason; the first Raid is untouched.
3. Withdraw or close the first, then retry the second. Expected: now allowed.
4. Founder revokes an offer while the Raider is on the consent screen and presses Accept. Expected: refused cleanly, no engagement.
5. Let an offer expire (set a short deadline), then try to accept. Expected: refused, slot free again.

## 3. Sign-in, wallet links, account folds — HIGH

Risk: wrong person gets access; two accounts merge incorrectly. Use only throwaway wallets with no funds.

1. Sign in with a wallet; sign out; sign in again. Expected: same account.
2. Link a second wallet to the account. Expected: both sign in to the same account.
3. Try to link a wallet that already belongs to another account. Expected: refused; neither account changed.
4. Replay an old signed challenge (capture and resend). Expected: rejected.
5. Account fold (flag on): fold two synthetic accounts that each hold data. Expected: nothing lost, nothing duplicated, the folded identity cannot sign in separately afterwards; a stranger cannot trigger or see a fold.
6. As a signed-out visitor, request each `/creator/*`, `/raider/*`, `/admin/*`, `/evaluator/*` page. Expected: redirected or denied; no data shown in the page source.

## 4. Guild roles, grants, ownership transfer — HIGH

Risk: authority escalation. The Guild management HTTP routes cannot be reached as a Founder in production until activation exists (known gap), so test through the test host or API client with synthetic sessions and record exactly how you did it.

1. Founder grants a role (e.g. editor) to member A, then revokes it. Expected: A can act only while granted; revocation is immediate on the next request.
2. A member without a grant tries each management action. Expected: 403/denied for every one, including by guessing ids from another Guild.
3. Founder starts an ownership transfer; the target declines, then another attempt is accepted. Expected: ownership changes only after the target consents; the previous Founder loses Founder powers; grants issued by them keep or lose effect exactly as the docs say.
4. Publish a Guild update as editor versus Founder. Expected: publication needs Founder approval (W04); a draft is invisible to the public until approved.
5. Hit the draft limit. Expected: the readable `GUILD_UPDATE_LIMIT_REACHED` error, existing drafts still editable.
6. Repeat a command with the same idempotency key, then with a different payload and the same key. Expected: same response, then a clear conflict.

## 5. Upgrade over existing data — HIGH

Risk: migrations pass on an empty database and fail on real rows. Agents only ever tested empty or fixture databases.

1. Restore a dump of a realistic synthetic database from the previous release into a scratch Postgres (not the shared test one).
2. Run `npx prisma migrate deploy` from that state. Expected: all pending migrations apply, no manual step.
3. Run it again. Expected: nothing pending.
4. Open the main flows from 1–4 on the upgraded data. Expected: existing Raids, applications and balances still readable and consistent.
5. Run `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code`. Expected: no drift.

## 6. Visibility and private data leaks — MED

1. For each page and `GET /api/v1/*` route, load it signed-out, as a stranger and as the owner. Expected: strangers see only public fields.
2. View page source and the network tab of the Raid detail page. Expected: no private codes, emails, wallet addresses of others, or draft content.
3. Try the private-code / application-only Raid by URL as a stranger. Expected: not revealed.
4. Error responses (bad id, wrong method). Expected: no stack traces or SQL text.

## 7. Applications, offers, amendments — MED

1. Apply to an application Raid; withdraw; reapply. Expected: allowed within the limit; limit message at the cap.
2. Founder sends an offer on the exact version; amend the Raid; Raider opens the old offer. Expected: told the version changed; must re-consent.
3. Try to consent after the commitment deadline. Expected: refused.

## 8. Practice trials, assessments, reviewers — MED

1. Raider starts a practice trial, submits, sees "awaiting review".
2. An assigned evaluator opens the case, records an assessment, decides. An unassigned evaluator tries the same. Expected: only the assigned reviewer can; self-review blocked.
3. Administrator revokes an assignment mid-review. Expected: reviewer loses access at once.
4. Raider's skill/rank change shows only after the decision and matches it.

## 9. Notifications — MED

1. Trigger events from 1, 4 and 7. Expected: one notification per event, only to the intended person, mark-as-read persists, preferences respected.
2. Open another user's notification id. Expected: denied.

## 10. Guild drafts, proposals, onboarding — LOW

1. Create, edit, submit a Guild draft; add a project proposal. Expected: data saved, validation messages readable, nobody else can open it.
2. Complete Raider onboarding on mobile width.

## 11. Public pages, feed, mobile, accessibility — LOW

1. Home, Raids, Raid detail, Guild pages at 375px and 1280px. Expected: no overlap or horizontal scroll.
2. Keyboard only: reach and operate every primary action; focus visible; screen-reader names on buttons and form fields.
3. Read all copy as a newcomer. Expected: simulated funds are always called simulated; no promise of earnings.

## 12. Default-off proof — MED

1. Start the app with no flags set. Expected: every gated route returns the documented disabled response, no new page exposes data, and existing demo pages still work.
2. Turn one flag on at a time and confirm only its routes open.

## Sign-off

Reviewer name, date, SHA, environment, per-section Pass/Fail/Blocked, defects linked, accepted limitations. Passing this plan does not authorise live funds, real wallets or production enablement; those gates stay separate.
