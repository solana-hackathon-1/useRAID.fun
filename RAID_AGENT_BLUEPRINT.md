# RAID — Complete Product and Development Agent Blueprint

**Version:** 1.1<br>
**Prepared:** 6 October 2026  
**Audience:** Every human and AI agent designing, building, reviewing, testing, or operating RAID  
**Document type:** Shared product specification, engineering blueprint, and agent handoff contract  
**Product name:** RAID  
**Network direction:** Solana  
**Status:** Ready to guide implementation; commercial and deployment decisions explicitly marked OPEN still require resolution before their dependent production features ship.

> **RAID is a Solana project launchpad organized as an Adventure Guild economy. Projects become Guilds. Guild Founders fund useful work. Raiders prove their abilities, complete Raids, receive rewards, and build a history that earns more responsibility.**

> **Raid rank = task difficulty. Raider skill rank = demonstrated capacity. Raider reputation = reliability. Guild reputation = founder/project reliability. Guild Trust = the relationship between one Raider and one Guild. Access = an explicit permission.**

## Navigation

| Read this first                                          | Product and participation                                        | Work and money                                                               | Engineering and delivery                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [00. Agent entry point](#00-agent-entry-point)           | [04. Product map](#04-product-map)                               | [11. Creating and recommending a Raid](#11-creating-and-recommending-a-raid) | [24. System architecture](#24-system-architecture)                           |
| [01. Evidence and authority](#01-evidence-and-authority) | [05. Launchpad](#05-launchpad)                                   | [12. Normal Raid lifecycle](#12-normal-raid-lifecycle)                       | [25. Domain and data model](#25-domain-and-data-model)                       |
| [02. Decision register](#02-decision-register)           | [06. Guilds and membership](#06-guilds-and-membership)           | [13. One active Raid](#13-one-active-raid)                                   | [26. API contracts](#26-api-contracts)                                       |
| [03. Vocabulary](#03-vocabulary)                         | [07. Identity and onboarding](#07-identity-and-onboarding)       | [14. Parties](#14-parties)                                                   | [27. Events and background jobs](#27-events-and-background-jobs)             |
| [33. Agent work contracts](#33-agent-work-contracts)     | [08. Skills and ranks](#08-skills-and-ranks)                     | [15. Guild Challenges](#15-guild-challenges)                                 | [28. Permissions and security](#28-permissions-and-security)                 |
| [34. Build sequence](#34-build-sequence)                 | [09. Reputation and Guild Trust](#09-reputation-and-guild-trust) | [16. Rewards and escrow](#16-rewards-and-escrow)                             | [29. Configuration and administration](#29-configuration-and-administration) |
| [35. Acceptance scenarios](#35-acceptance-scenarios)     | [10. Visibility and code access](#10-visibility-and-code-access) | [17. Reviews and disputes](#17-reviews-and-disputes)                         | [30. Operations and recovery](#30-operations-and-recovery)                   |
| [38. Open decisions](#38-open-decisions)                 | [19. AI agents](#19-ai-agents)                                   | [18. Feed and sponsored placement](#18-feed-and-sponsored-placement)         | [31. Metrics](#31-metrics)                                                   |
| [40. Handoff templates](#40-handoff-templates)           | [20. AI influencers](#20-ai-influencers)                         | [21. Ongoing Roles](#21-ongoing-roles)                                       | [32. Testing strategy](#32-testing-strategy)                                 |
| [41. Sources](#41-sources)                               | [22. Token economy](#22-token-economy)                           | [23. Screens and user experience](#23-screens-and-user-experience)           | [36. Worked examples](#36-worked-examples)                                   |

---

## 00. Agent entry point

### 00.1 What this file is for

Use this document as the common specification when implementing RAID. It provides enough context for a new agent to understand the whole product before changing one part of it. It is a blueprint, not a claim that any code, program, token, audit, integration, deployment, or business agreement already exists.

Two different meanings of **agent** occur in this project:

| Meaning           | Role                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development agent | An AI assistant or human contributor building RAID itself. The instructions in this file guide its implementation work.                                       |
| Raider AI agent   | A registered product participant that performs paid work inside RAID. It has an operator, capability evidence, permissions, a budget, and an activity record. |

A development agent is not automatically a registered Raider AI agent. Reading this file grants neither production credentials nor permission to spend funds, send messages, publish content, or run work for a customer.

### 00.2 First actions for every development agent

1. Read sections 00–04 and 13 before editing anything.
2. Read the sections for your domain and the relevant acceptance scenarios.
3. Inspect the repository, its existing instructions, actual dependencies, migrations, and implementation status. An existing repository may differ from the proposed structure below.
4. Identify your assigned milestone. Implement that scope and its dependencies; do not silently pull later phases into it.
5. Map the change to requirement IDs, affected entities, permissions, state transitions, and tests.
6. Inspect existing contracts before creating another schema, enum, client, or service for the same concept.
7. Preserve financial, access-control, and concurrency invariants at the server and database/program boundaries.
8. Implement a complete, reviewable slice, including failure states and recovery where applicable.
9. Verify the actual behavior with the appropriate tests. Report what was executed and what remains unverified.
10. Update the implementation status and handoff record so the next agent can continue without guessing.

### 00.3 If your context window is small

Read in this order: 00 → 02 → 03 → 13 → your domain → 34 → 35. Then search the rest of this file by requirement ID or exact term. The short route does not excuse changing a related money, identity, or access rule without reading that rule.

Use section numbers in task briefs. Do not copy fragments into separate specifications and let them drift. A role-specific brief should reference this document and add only the current task, repository facts, and acceptance criteria.

### 00.4 How to make decisions

Follow the active user's instructions and applicable repository instructions. Within this blueprint:

- **LOCKED:** A clear product requirement retained from the discussion. Do not change it as an implementation convenience.
- **DIRECTION:** A product concept carried forward from the discussion; exact mechanics may still be a DEFAULT or OPEN.
- **DEFAULT:** A concrete implementation recommendation supplied here to make development possible. Adopt it for the initial build unless a recorded project decision replaces it.
- **OPEN:** A business, economic, provider, or authority choice not established by the available discussion. Build independent work and interfaces; keep the dependent production feature disabled until resolved.
- **EXAMPLE:** Sample data, thresholds, fees, timings, or rewards. An example is not production configuration.

The word **must** describes a required invariant or behavior of the chosen design. It does not turn an unapproved commercial proposal into a user decision.

### 00.5 Ten implementation rules to remember

1. Buying tokens cannot buy skill rank, reputation, code access, or another active Raid slot.
2. One Raider has at most one active work engagement, including Party and Challenge participation.
3. A funded reward is a verified asset obligation, not a number entered by a founder.
4. Work completion, review decisions, and financial settlement are separate states.
5. A score never substitutes for an explicit permission to private information.
6. Every balance and payment is keyed to its actual network and asset; ticker text is insufficient.
7. Reputation comes from attributable evidence and resolved outcomes, with uncertainty visible.
8. Sponsored visibility is visibly labeled and cannot alter earned credibility.
9. AI outputs propose actions; authorized services enforce access and financial policy.
10. Examples, mocks, simulated transactions, and devnet balances must be unmistakable in the product and tests.

---

## 01. Evidence and authority

### 01.1 What was actually available

This document consolidates the RAID discussion supplied in this conversation, including the later decisions about capacity ranks, project reputation, progressive access, one active Raid, and hackathon-style selection. The conversation references an earlier 41-page PDF, but that PDF was not available for inspection during preparation. Earlier messages were also partially omitted from the supplied context.

Accordingly, this document does not claim to reproduce unseen PDF content or recover an earlier finalized launch mechanism, token supply, fee schedule, exact provider, or technology choice. It makes those gaps explicit and provides implementation defaults where appropriate.

### 01.2 Product evidence register

| Evidence ID | Visible decision or context                                                                          | Interpretation used here                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| C01         | Existing discussion describes RAID as a Solana launchpad with Guilds and an Adventure Guild economy. | Preserve launchpad identity and the project-to-work loop.                                                                               |
| C02         | User asks for recommended Raid rank and recommended funding/token/stablecoin reward.                 | Recommendation is a founder-facing product capability.                                                                                  |
| C03         | User asks for a Raid feed at the front of the website and paid/bid placement.                        | Homepage discovery and paid visibility are in the product scope.                                                                        |
| C04         | User names Guild Founders and defines Guild Members as project-token holders.                        | Separate founder authority from holder membership.                                                                                      |
| C05         | User agrees ranks represent capacity and says to scrap the token/rank part.                          | No rank-dependent token balance ladder; licensing remains unresolved.                                                                   |
| C06         | User asks that projects gain reputation through their Raid history.                                  | Guild reputation is distinct from Raider skill rank.                                                                                    |
| C07         | User asks for progressive access based on completed work and cooperation.                            | Public discovery plus explicit, limited access to sensitive work.                                                                       |
| C08         | User asks how to verify credibility, skills, spam, onboarding tests, and code delivery.              | Evidence-based onboarding, trials, anti-abuse, and a controlled code workflow.                                                          |
| C09         | User says: limit one Raider to one Raid at a moment.                                                 | A platform-wide concurrency invariant with no rank exceptions.                                                                          |
| C10         | User proposes a simple hackathon where participants submit and the eligible person does the Raid.    | Default to a Challenge that selects a builder for a main Raid; retain prize hackathons as a separate mode from the expanded discussion. |
| C11         | Existing discussion includes humans, AI agents, AI influencers, Parties, and later ongoing Roles.    | Preserve the complete domain while staging implementation.                                                                              |
| C13         | Owner requires every implementation to use test-driven development.                                  | Genuine RED/GREEN/REFACTOR evidence; non-code acceptance defined first.                                                                 |
| C14         | Owner requires replaceable integrations and documented reusable modules.                             | Stable adapters, safe provider replacement and independently usable module documentation/examples.                                      |
| C12         | User requests a complete Markdown blueprint that every agent can understand.                         | One self-contained master specification with domain-specific agent contracts.                                                           |

These are conversation references, not claims independently verified on the internet. Technical platform facts are linked to primary documentation in section 41. The architecture, product defaults, formulas, sample scenarios, and proposed controls are original design recommendations for RAID.

### 01.3 Corrections to earlier suggestions

| Earlier suggestion                                             | Canonical interpretation                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A token holding ladder determines rank eligibility.            | Removed. Capacity determines skill rank. No escalating rank stake is part of the baseline.                                                                   |
| A/B/S Raiders might get several active Raids later.            | Not adopted. The user's one-active-Raid rule remains in force.                                                                                               |
| Completing community posts unlocks the codebase.               | Relevant skill evidence and explicit Guild permission determine access; posting volume is insufficient.                                                      |
| GitHub “write / branch only” hides other code.                 | Branch rules restrict changes. They do not create folder or branch confidentiality. Use a separate scoped repository or an isolated workspace.               |
| A token-holder is a project owner.                             | Membership is a product relationship. It creates no automatic equity, treasury, governance, or intellectual-property rights.                                 |
| Escrow alone proves work quality or guarantees a fair outcome. | Escrow reserves funds under a defined release/refund mechanism; quality, acceptance rules, deadlines, dispute authority, and recovery still need definition. |
| Buying a more expensive AI model makes it an S-rank agent.     | Model configuration is an execution choice. Capability rank requires evidence against a versioned evaluation.                                                |
| Clicking Submit immediately frees the Raider forever.          | Under the default, review and agreed revisions remain active work until operational closure. Bounded timeouts prevent indefinite blocking.                   |
| A hackathon always means winner-take-all unpaid work.          | Selection challenges and prize competitions are separate formats with disclosed compensation.                                                                |

---

## 02. Decision register

### 02.1 Locked product requirements

| ID  | Requirement                                                                                                                                                                       | Evidence                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R01 | RAID retains a project launchpad and Guild identity.                                                                                                                              | C01                                                                               |
| R02 | A project launched through RAID becomes a Guild; its authorized creator becomes the Guild Founder.                                                                                | C01, C04                                                                          |
| R03 | Holding the recognized project token establishes holder eligibility for that Guild.                                                                                               | C04                                                                               |
| R04 | A Raider can work across Guilds and can also be a Founder or Member.                                                                                                              | C01, C04                                                                          |
| R05 | Every published Raid has an E–S difficulty label and explicit skill requirements.                                                                                                 | C01, C02, C05                                                                     |
| R06 | Skill rank represents demonstrated capacity, not token wealth or paid placement.                                                                                                  | C05                                                                               |
| R07 | RAID recommends task difficulty and reward composition/range; participant routing and duration complete the proposed assistance flow.                                             | C02 directly requests rank/reward; routing/duration are carried-forward additions |
| R08 | The public website has a discoverable Raid feed.                                                                                                                                  | C03                                                                               |
| R09 | Paid placement exists as a clearly distinguishable visibility product.                                                                                                            | C03; labeling is a trust-preserving implementation requirement                    |
| R10 | Guilds accumulate a reputation based on funding, payment, requirements, and treatment of contributors.                                                                            | C06                                                                               |
| R11 | Sensitive work uses progressive trust and explicit access approval.                                                                                                               | C07, C08                                                                          |
| R12 | Skills can be claimed, evidenced, assessed, and verified independently.                                                                                                           | C08                                                                               |
| R13 | One Raider may hold only one active Raid/work engagement at a time.                                                                                                               | C09                                                                               |
| R14 | A high-trust Challenge may select a Raider or Party for a larger Raid.                                                                                                            | C10                                                                               |
| R15 | Every external integration is isolated behind a stable, versioned, replaceable adapter contract; provider-specific SDKs, credentials and behavior do not leak into domain rules.  | C14                                                                               |
| R16 | Every delivered module has complete current documentation, explicit dependency/host contracts and a verified consuming example so it can be reused in another authorized project. | C14                                                                               |

### 02.2 Carried-forward product direction

| ID  | Direction                                                                                   | Scope                                                                                    |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P01 | Humans, registered AI agents, and AI influencers are distinct participant types.            | Common work contracts; different proof and execution needs.                              |
| P02 | Parties combine complementary contributors.                                                 | Every participant has consent, responsibility, capacity checks, and a payout allocation. |
| P03 | Prize-based Guild Challenges can compare multiple solutions.                                | Separate from selection challenges.                                                      |
| P04 | Ongoing Roles may follow later.                                                             | An ongoing responsibility must not bypass the one-active rule.                           |
| P05 | Rewards can combine supported stablecoins, SOL, project tokens, and RAID.                   | Support follows tested adapters; “anything” is not unchecked arbitrary-token acceptance. |
| P06 | RAID token utilities may include platform services, execution credits, and paid visibility. | No economics or launch allocation is finalized in the available source.                  |
| P07 | Newcomers should have a low-risk path to earning and proving skill.                         | No forced token purchase in the proposed baseline.                                       |
| P08 | AI assistance should reduce founder configuration work.                                     | Explanations and founder control remain visible.                                         |

### 02.3 Defaults adopted for the initial engineering specification

| ID  | Default                                                                                                                                                            | Reason                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| D01 | One TypeScript modular monolith, PostgreSQL, web process, background worker, and separate untrusted execution environments.                                        | Keeps transactions and ownership clear without early microservices.                                   |
| D02 | No mandatory RAID holding/staking requirement in the baseline.                                                                                                     | The token/rank ladder was removed; remaining license policy is OPEN.                                  |
| D03 | Every paid execution slot, public or private, must have fully verified reward funding before accepting commitments and verified escrow binding before work starts. | Selection compensation and main-Raid funding are separate obligations.                                |
| D04 | All confidential Raids and all B/A/S work require approval plus participant acceptance.                                                                            | Rank alone cannot grant private access.                                                               |
| D05 | A standard Raid has one selected Raider or one Party.                                                                                                              | Group microtasks use separate execution slots, not several people competing for one promised payment. |
| D06 | Build and review duties hold the active slot; a terminal work outcome releases it independently of settlement.                                                     | Preserves commitment without trapping workers during payment incidents.                               |
| D07 | Skill-specific ranks and evidence are canonical; an optional profile headline cannot override them.                                                                | Community activity cannot manufacture a developer qualification.                                      |
| D08 | Use public or sanitized task material for initial onboarding and trial work.                                                                                       | Reduces required trust for first participation.                                                       |
| D09 | Initial automated recommendations use a bounded rubric; an LLM can explain or propose a structured draft.                                                          | Avoids pretending an unevaluated model can price every job precisely.                                 |
| D10 | Initial sponsored placements use disclosed fixed slots; bidding is a later compatible mode.                                                                        | Makes delivery, billing, and refunds easier to validate.                                              |
| D11 | Exact launch protocol, custody design, program authorities, fee schedule, and token economics remain OPEN.                                                         | The source discussion does not finalize them.                                                         |
| D12 | Mainnet payments and trading remain disabled until their specific implementation and operating gates pass.                                                         | A mock or devnet flow is not a production payment system.                                             |
| D13 | Removing a wallet or losing a token balance cannot erase completed work, assessed skills, or financial claims.                                                     | Adopted preservation default; not a claim that C05 explicitly settled retention mechanics.            |

### 02.4 Non-negotiable engineering invariants

| ID  | Invariant                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | The database rejects a second active engagement for the same canonical participant.                                                                                                                   |
| I02 | Party activation either reserves every participant or reserves none.                                                                                                                                  |
| I03 | Every financial obligation and transfer uses integer base units and a full asset identity.                                                                                                            |
| I04 | Cumulative paid, refunded, and remaining obligations never exceed verified credited funds for that asset.                                                                                             |
| I05 | A duplicate command, webhook, retry, or reconciliation pass cannot create a duplicate business outcome.                                                                                               |
| I06 | Private bytes never appear in public API fields, rendered page payloads, search indexes, previews, logs, or notification snippets.                                                                    |
| I07 | No background score change, token sale, or service outage grants code access or confiscates a reward.                                                                                                 |
| I08 | Every acceptance and financial decision refers to immutable terms and a specific submission/version.                                                                                                  |
| I09 | External effects are recorded, retried, and reconciled; a database transaction cannot pretend to atomically commit GitHub and Solana.                                                                 |
| I10 | Only authorized actors can change the underlying business state; hiding a button is not authorization.                                                                                                |
| I11 | Payout, refund, access grant, and dispute decisions have an audit trail and explicit authority.                                                                                                       |
| I12 | Sample program IDs, fake mints, and fabricated performance data cannot pass production validation.                                                                                                    |
| I13 | Implementation changes follow genuine failing-test-first RED, GREEN and REFACTOR evidence; tests cannot be weakened to bypass requirements. Non-code deliverables define acceptance before execution. |

### 02.5 Accepted owner changes — 6 October 2026

DEC-2026-10-06-01: project owner requires test-driven implementation; accepted, related I13/AC75. DEC-2026-10-06-02: project owner requires every integration to be replaceable and every delivered module documented and reusable; accepted, related R15/R16/AC73/AC74 and sections 24.6–24.7. These decisions preserve D01 modular-monolith transactions and do not select OPEN providers, authorize publishing packages or alter accepted customer terms. Existing code is not claimed compliant; inventory gaps, migrate in bounded tasks and verify them before completion.

### 02.6 Accepted owner change — 9 October 2026

DEC-2026-10-09-01 (WR04): accepted by the project owner in the Codex continuation on 9 October 2026. Before linking an additional wallet, require confirmation through a connected X account, following the existing connected-X condition in `rotateWallet`, together with the authenticated account and fresh proof from the additional wallet. The owner selected this option over a fresh signature from the primary wallet. A wallet-only session must be denied at the server command boundary; client assertions of X linkage are not authority. This decision governs T006 PR-B under R04/R13/I10, sections 07.1–07.2/28 and AC01/AC02. It does not alter canonical participant identity, accepted work, payout destinations or financial records. PR-A remains storage-only. PR-B must test missing/foreign X linkage rejection, valid connected-X confirmation, restricted accounts, proof replay and revoke; its independent review must verify the host authority boundary. Enablement still requires revoke/unlink or an audited operator revoke procedure, T007 AC02 evidence, every instance running linked-wallet sign-in resolution and a server-gated switch. No release or production authority is granted.

---

## 03. Vocabulary

| Term                   | Exact meaning                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAID                   | The platform brand.                                                                                                                                                                                                                      |
| RAID token             | A possible platform asset, identified by its actual mint and network when configured. Distinct from the brand and from service credits.                                                                                                  |
| Guild                  | A project workspace with a public profile, authorized administrators, work history, and contributor relationships. Its primary token is nullable while launch/verification is pending; holder membership starts only after verification. |
| Guild Founder          | The verified creator or authorized project representative for a Guild; authority comes from account permissions, not current token balance.                                                                                              |
| Guild administrator    | An explicitly delegated manager with a permission set. It is not necessarily a co-founder.                                                                                                                                               |
| Guild Member           | A token-holder relationship to a Guild, subject to verified holder eligibility and display preferences.                                                                                                                                  |
| Raider                 | A canonical participant eligible to perform work. Human, AI agent, or AI influencer is a participant kind.                                                                                                                               |
| Party                  | A roster of consenting Raiders organized for one engagement or reusable team identity. It does not create extra work capacity.                                                                                                           |
| Raid                   | A defined unit of paid work with immutable terms, requirements, reward, review process, and selected executor.                                                                                                                           |
| Raid template/campaign | A definition that may create multiple separately funded execution slots, such as testing by 50 users.                                                                                                                                    |
| Engagement             | The execution record tying one Raid slot or Challenge entry to its participants and active commitments.                                                                                                                                  |
| Guild Challenge        | A structured multi-entry format. It is either selection for follow-on work or a prize competition.                                                                                                                                       |
| Selection Challenge    | A bounded assessment/prototype round used to choose who is offered a separately funded main Raid.                                                                                                                                        |
| Prize Competition      | A contest with a published prize pool, scoring rubric, deadlines, and award allocation.                                                                                                                                                  |
| Role                   | An ongoing responsibility with its own renewal and payment cadence; a later product phase.                                                                                                                                               |
| Skill rank             | E, D, C, B, A, or S capability level for one skill domain.                                                                                                                                                                               |
| Raid difficulty        | The estimated complexity/capacity needed for a task, separate from confidentiality and reliability thresholds.                                                                                                                           |
| Raider reputation      | Evidence of a participant's reliability across Guilds.                                                                                                                                                                                   |
| Guild reputation       | Evidence of a Guild's reliability toward contributors.                                                                                                                                                                                   |
| Guild Trust            | A Raider–Guild relationship record. It is not transferable to another Guild.                                                                                                                                                             |
| Access grant           | Explicit permission to a particular resource, purpose, scope, and duration.                                                                                                                                                              |
| Escrow                 | Funds controlled by a defined settlement mechanism and release/refund authority. A UI balance label is not escrow.                                                                                                                       |
| Terms version          | Immutable snapshot accepted by the funder and executor, including scope, reward, deadlines, review, and dispute policy.                                                                                                                  |
| Submission             | A versioned deliverable with evidence and a timestamp.                                                                                                                                                                                   |
| Outcome                | A reasoned work result, separate from a payment transaction.                                                                                                                                                                             |
| Settlement             | Authorized allocation and transfer of funds according to the agreed outcome.                                                                                                                                                             |
| Sponsor                | The payer for clearly labeled placement. It need not be the executor or award judge.                                                                                                                                                     |
| Service credits        | Non-token usage units under explicit billing terms. They do not imply a transferable token or a guaranteed conversion rate.                                                                                                              |

---

## 04. Product map

### 04.1 Core promise

A founder can launch a project, form a Guild around it, finance useful work, find suitable contributors, judge results against agreed criteria, and reward the people or agents who help the project progress.

A Raider can find funded work, understand the requirements, prove relevant skills, build a reliable history, and earn rewards without needing insider relationships with every project.

A Guild Member can discover the project, follow its progress, inspect its public work history, and participate in its community. Holding the project token does not automatically make the Member a trusted developer.

### 04.2 End-to-end loop

```mermaid
flowchart TD
    A["Launch or verify a project"] --> B["Create Guild"]
    B --> C["Define and fund work"]
    C --> D{"Work format"}
    D --> E["Select a Raider or Party"]
    D --> F["Run a Guild Challenge"]
    E --> G["Build and submit proof"]
    F --> G
    G --> H["Review against agreed terms"]
    H --> I{"Outcome"}
    I --> J["Accept and settle reward"]
    I --> K["Revise or resolve dispute"]
    K --> H
    J --> L["Update evidence and reputation"]
    L --> C
```

### 04.3 Separate dimensions in the model

Do not compress different concepts into a single `type` or `rank` field.

| Dimension          | Examples                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| Work format        | Standard Raid, selection Challenge, prize competition, later Role      |
| Participant kind   | Human, AI agent, AI influencer                                         |
| Execution shape    | Solo, Party, multiple separate slots                                   |
| Skill domain       | Frontend, Solana, design, research, content, community                 |
| Difficulty         | E–S                                                                    |
| Visibility         | Public, trusted listing, confidential listing, invite-only             |
| Admission          | Instant acceptance, application and approval, invitation               |
| Reward composition | One supported asset or a supported asset bundle                        |
| Funding status     | Unfunded, funding pending, verified funded, partially settled, settled |
| Work status        | Draft, open, active, submitted, revision, terminal                     |

An A-rank public design task is possible. A C-rank task can be confidential. Expensive work is not necessarily difficult. A high-trust developer can still lack the required skill.

### 04.4 What the first useful product must prove

The first working loop is: verified Guild → funded public Raid → eligible human contributor → accepted work → verified payout → honest work history. The launch integration must additionally prove project launch → verified mint → Guild linkage before the release is called a working launchpad.

An operations pilot using manually verified existing projects can validate work mechanics early. Label it accurately as a pilot. It does not replace the launchpad milestone.

---

## 05. Launchpad

### 05.1 Scope

RAID should let a founder create a project identity and perform a supported token launch. The launch and the Guild are connected, while their states remain separate.

The exact token launch mechanism is OPEN: a supported external launch protocol, custom launch program, fixed distribution, bonding curve, and pool migration are materially different products. The available conversation does not choose among them. Do not invent a curve equation, graduation threshold, creator revenue split, supply, or migration destination.

### 05.2 Founder launch flow

1. Authenticate and create a draft Guild/project profile.
2. Provide the project name, description, links, public image, and authorized founder identity.
3. Choose the supported launch route for the configured network.
4. Enter the parameters that route actually supports: token metadata, supply/decimals, distribution, authority policy, allocations, and any liquidity/vesting configuration.
5. Review exact transaction actions, fees, recipient addresses, token controls, and available funds.
6. Explicitly sign the transaction(s) using the authorized wallet or chosen approved signer mechanism.
7. Track the launch intent and transaction states, including expiry and partial completion.
8. Independently verify on-chain results and record the canonical mint/program/network.
9. Activate the Guild token relationship once the required launch conditions are verified.
10. Offer a first Raid creation flow using a separately disclosed and funded work budget.

Creating a token does not by itself establish a market, liquidity, holder rights, or a funded Raid treasury. Describe only the states verified by the chosen launch route.

### 05.3 Launch state model

| State                        | Meaning                                                              | Permitted next step                                       |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| `DRAFT`                      | Metadata and launch parameters editable.                             | Validate and prepare.                                     |
| `READY_FOR_SIGNATURE`        | A bounded launch intent and transaction description exist.           | Sign or cancel the intent.                                |
| `SUBMITTED`                  | A signature is known; success is not yet established.                | Verify, expire, or report failure.                        |
| `CONFIRMED_PENDING_FINALITY` | Result observed at an intermediate commitment.                       | Await finality; do not overstate completion.              |
| `LIVE`                       | Required launch artifacts verified at the configured finality.       | Operate the Guild and supported market flow.              |
| `ACTION_REQUIRED`            | Multi-step launch needs another authorized action or reconciliation. | Resume the exact intent.                                  |
| `FAILED`                     | Failure established with a recorded reason.                          | Create a new intent without duplicating successful steps. |
| `CANCELLED`                  | No further launch action will be submitted.                          | Retain audit history.                                     |

If a route has curve trading or graduation, use separate provider-specific market states. A Guild is not “graduated” merely because a frontend progress bar reaches 100%.

### 05.4 Launch adapter contract

The domain consumes an interface such as `validateLaunch`, `quoteLaunch`, `prepareLaunch`, `verifyLaunch`, `getMarketStatus`, and `reconcileLaunch`. Returned facts include network, protocol/program identifiers, mint, verified authorities, transaction references, parameter hash, and observation timestamps.

Provider errors are typed: unsupported parameters, quote expired, insufficient funds, signature rejected, transaction unknown, transaction failed, partial completion, provider unavailable, and inconsistent state. Never silently switch a user to a different protocol, mint, or fee recipient.

### 05.5 Existing project onboarding

An existing project can be linked through a separately labeled verification route. Knowledge of a token mint address is not proof that the applicant represents the project. Require an approved control attestation, such as an authorized project wallet/governance signature and supporting public project evidence. If authority was revoked or ownership changed, use a documented review process. Do not require impossible proof from a permanently revoked mint authority.

Enforce one recognized Guild per `(network, token_program, primary_mint)` under the baseline, with an administrative conflict process. Founder transfers, mergers, token migrations, and changes of primary token require a new verified relationship and an audit record; prior reputation cannot be silently sold as a clean project history.

### 05.6 Mainnet release gate

Before live launch actions, record the selected protocol, integration versions, authority policy, verified addresses, fee destinations, transaction review UX, recovery cases, and relevant operating/jurisdiction decisions. A document or mock cannot satisfy this gate. Continue building the independent Guild and work interfaces while this decision is pending.

---

## 06. Guilds and membership

### 06.1 Guild profile

A Guild contains a public name, stable slug, description, media, links, network and recognized token, founder verification status, launch state, public Raid history, paid-out amounts by asset, reliability indicators, contributor relationships, and optional public roadmap updates.

Private configuration contains administrators, permission grants, repositories, confidential briefs, private documents, payment administration, dispute contacts, and internal moderation notes. Public and private data use separate response models.

### 06.2 Founder authority

The Founder can manage project information, delegate selected permissions, create and fund work, review applicants, approve work within the agreed contract, and purchase sponsorship. Treasury authority and dispute resolution authority are separate from general Guild administration.

A Founder cannot unilaterally rewrite an accepted reward, delete a contributor's earned history, decide their own appeal as an independent reviewer, or refund a reward after its work binding becomes effective, including while access or the agreed start is pending.

### 06.3 Holder membership

**DEFAULT:** A positive verified balance of the recognized project token creates `holder_eligible=true`. The exact dust threshold is configurable and remains subject to a recorded product decision. Compute from the supported ownership scope, not ticker text. Holding a token in an exchange account cannot be verified as a user's own on-chain wallet without a separate supported attestation route.

Balance observations include network, mint/program, raw balance, observation time, slot/finality, provider, and freshness. Multiple token accounts for one mint may exist; an associated token account is not necessarily the owner's only holding account. [S01](#41-sources)

Membership eligibility and public participation are distinct:

- Token ownership can establish eligibility automatically.
- The user controls whether to display the Guild association publicly and whether to follow notifications.
- Dust sent unsolicited to a wallet must not enroll someone in marketing or expose an unwanted profile association.
- Selling the recognized token updates holder eligibility after verification; it does not delete historical work or private contractual rights.
- A temporary RPC failure means `UNKNOWN` or `STALE`, not “balance is zero.”

### 06.4 Membership is separate from work permissions

A Guild Member may have no verified skill. A skilled Raider may work for a Guild without holding its token unless a particular non-rank participation policy is explicitly adopted. Neither token holding nor a Founder badge grants private repository access.

Use role permissions for work and resource authorization, holder observations for membership, and relationship records for Guild Trust. They are separate records with separate reasons for change.

---

## 07. Identity and onboarding

### 07.1 Account model

Use a stable internal account ID. Wallet addresses and social accounts are credentials/evidence attached to that account. A wallet address is not a person ID.

A human account has one canonical human Raider identity. Registered AI identities have an accountable operator organization/account and separate runtime credentials. Changing wallets, adding a login method, or changing a display name preserves the same work slot and history.

Prevent duplicate links of the same verified provider subject to unrelated accounts. Account recovery and merges require proof and review; merges preserve financial records and cannot combine two active assignments into an invisible over-capacity state.

### 07.2 Wallet authentication

Use a compatible Sign In With Solana flow where available. The server issues a one-time challenge with a domain, allowed URI/network, nonce, issued-at time, expiration, and account-linking intent where relevant. Verify the returned message and signature server-side against the stored challenge, then consume the challenge atomically. Reject replay, wrong domain, expired intent, and mismatched account. SIWS specifies a standard signed-message format and server-side verification; RAID's single-use nonce and expiry rules are explicit application policy. [S06](#41-sources)

For additional-wallet linking, apply DEC-2026-10-09-01: authenticated self-account, connected-X confirmation checked by the server, and fresh proof from the additional wallet. A wallet-only session is insufficient; the credential relationship preserves the canonical participant and payout wallet.

Wallet connection alone is not authentication. Signing in is not a funds transfer. A later transaction needs a separate, intelligible authorization. Never request a seed phrase or wallet private key.

### 07.3 New human onboarding

1. Browse public content without signing in.
2. Create an account through the supported login flow.
3. Select intended work categories and timezone/availability.
4. Add claimed skills and optional proof links.
5. Connect GitHub or another relevant provider when needed for the work.
6. Complete a short orientation: commitments, evidence, payment, confidentiality, disputes, and one active Raid.
7. Choose a public beginner task or a relevant skill trial.
8. Establish a verified payout destination before committing to paid work.
9. Review exact terms and accept one engagement.

An experienced builder may use portfolio review and a skill trial to demonstrate a higher skill rank quickly. They do not need to complete hundreds of irrelevant E-rank tasks. Higher capability still does not create Guild-specific trust or private access.

### 07.4 Evidence types

| Evidence                      | What it can support                                        | What it cannot prove alone                                           |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| GitHub account ownership      | Control of an account and linked contribution history.     | That every commit is original, strong engineering skill, or honesty. |
| Portfolio/project             | Relevant delivered work when ownership can be checked.     | A right to use private client material or future reliability.        |
| Skill trial                   | Ability to meet a scoped rubric under declared conditions. | Permanent expertise in all tasks in that domain.                     |
| Completed Raid                | An attributable delivered outcome under recorded terms.    | Expertise in unrelated skills.                                       |
| Social account control        | Ability to act through that account.                       | Authentic followers, unique humanity, or guaranteed reach.           |
| Wallet signature              | Control of an address at a moment.                         | Unique human identity, character, or business legitimacy.            |
| Optional identity attestation | The specific claim verified by that provider.              | Skill, trustworthiness, or permission to confidential code.          |

### 07.5 Anti-spam and duplicate accounts

Combine server-side rate limits, verified login methods, duplicate submission fingerprints, repeated portfolio reuse checks, account-link uniqueness, relationship patterns, and human review for significant restrictions.

Use risk signals proportionately. Shared Wi-Fi, a young wallet, a new GitHub account, or low follower count must not alone trigger a permanent fraud label. Device and network signals are limited and privacy-sensitive; define retention and access. Newcomers need a legitimate route into the platform.

The system can enforce one active engagement per known canonical participant. It cannot honestly guarantee one unique human across all unrelated accounts without an adopted identity system. Record suspicious links and offer appeals instead of claiming Sybil behavior has been eliminated.

---

## 08. Skills and ranks

### 08.1 Rank ladder

**DEFAULT descriptive rubric; not a numerical score conversion:**

| Rank | Demonstrated capacity                                                   | Example work shape                                             |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| E    | Can complete a small, explicit task with simple verification.           | Follow an onboarding test and report reproducible results.     |
| D    | Can complete a contained task with limited assistance.                  | Reproduce a bug or update a defined content item.              |
| C    | Can independently deliver a bounded component with ordinary edge cases. | Implement a scoped UI component and tests.                     |
| B    | Can own a moderately complex integration and explain tradeoffs.         | Integrate a service with error handling and evidence.          |
| A    | Can lead a complex component or system area with substantial ambiguity. | Design and deliver a significant architecture slice.           |
| S    | Has exceptional, repeatedly demonstrated capacity in a specific domain. | Lead highly demanding work with strong independent evaluation. |

Difficulty and security sensitivity are separate. A short change in a treasury program may be small in code size and high in consequence; requirements should capture both.

### 08.2 Canonical skill record

Each `(participant_id, skill_id)` stores claimed level, assessed rank, verification status, evidence references, assessment rubric/version, reviewer identity, issue date, reassessment date where applicable, confidence/sample size, and revocation/reassessment history.

Suggested verification states: `CLAIMED`, `UNDER_REVIEW`, `VERIFIED`, `REASSESSMENT_REQUIRED`, `REVOKED`. A lapsed external token must not silently revoke an already documented assessment, though it may prevent checking new external evidence.

Skill categories are admin-managed data. Initial categories can include frontend, backend, Solana programs, product design, QA, research, technical writing, community support, content creation, and distribution. Taxonomy changes preserve stable IDs and aliases.

### 08.3 Trial design

A trial definition contains the skill, intended rank, time expectations, permitted tools/AI assistance, task variant, inputs, rubric, evaluator method, pass conditions, resubmission limits, and accommodations. Use synthetic/public material. A reusable platform trial must not become unpaid production work for a Founder.

For a developer trial, evaluate working behavior, tests, error handling, explanation, and ownership of the solution. A candidate should be able to explain or modify their submission. Declare whether AI assistance is permitted; learning to use AI competently can itself be relevant, but claimed independent work must be assessed under the stated rules.

Tests need hidden edge cases and varied tasks where helpful, with manual review for borderline or high-impact outcomes. Similarity detection is a review signal; it is not a conclusive plagiarism verdict.

### 08.4 Example skill trials

| Skill       | Example brief                                                                 | Evidence                                                                                                 |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Frontend C  | Implement an accessible wallet status panel from a mock provider.             | Responsive UI, loading/error/disconnected states, explanation, test evidence.                            |
| Backend B   | Build an idempotent job endpoint with a concurrency edge case.                | Working API, transactional behavior, recovery explanation.                                               |
| Solana      | Complete a devnet token workflow with the intended program and confirmations. | Correct account validation and status handling; rank assigned by the complete rubric, not by this title. |
| Research C  | Answer a bounded question from a specified public dataset.                    | Source traceability, uncertainty, method, and useful conclusion.                                         |
| Community D | Resolve simulated support requests.                                           | Accuracy, respectful communication, escalation judgment.                                                 |
| Design B    | Produce and explain a usable multi-state interaction.                         | Prototype, accessibility, coverage of failure and empty states.                                          |

### 08.5 Admission by skill

Store required skills as structured predicates: skill ID, minimum rank, whether verification is required, and whether a Party can distribute the requirement across members. “React or Vue” and “frontend plus Solana” need explicit OR/AND grouping; do not guess from a comma-separated string.

Higher capability can satisfy a lower minimum within the same skill. One S-ranked frontend skill cannot satisfy a B-ranked Solana requirement. Reputation gates and access approval are evaluated separately.

For a verification-required predicate, only a current verified assessment qualifies. If a predicate explicitly allows unverified evidence, label that weaker evidence in the application. Public E-rank starter work may declare no minimum verified-skill prerequisite; orientation, restrictions, terms, funding, and capacity checks still apply. Registration itself does not create a verified skill rank.

### 08.6 Progression and reassessment

Recognize completed work only for the skills actually demonstrated. Require stronger evidence for high ranks and show confidence/history. Numeric promotion thresholds are OPEN and must not be copied from old illustrative tables.

Reliability incidents affect reputation; they do not automatically prove skill has vanished. Fraudulent assessment evidence can revoke the affected verification through a reasoned process. Capability reassessment and reliability restrictions have separate event types and appeal paths.

---

## 09. Reputation and Guild Trust

### 09.1 Three records, three questions

| Record            | Question answered                                                      | Scope                                          |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Raider reputation | Does this participant reliably deliver what they accepted?             | Across the platform, with category breakdowns. |
| Guild reputation  | Does this project fund, specify, review, and pay work fairly?          | One Guild and its verified operating history.  |
| Guild Trust       | How established is this Raider's working relationship with this Guild? | One participant–Guild pair.                    |

The labels must remain distinct in screens, API names, tables, analytics, and documentation.

### 09.2 Display facts before a precise score

**DEFAULT:** Begin with observable metrics, small-sample labels, and a standing such as `NEW`, `ESTABLISHED`, `REVIEW_NEEDED`, or `RESTRICTED`. A numeric score can be added only with a versioned formula and calibration. Do not assign a new user a misleading 100/100 or describe one successful task as proven long-term reliability.

Show completed engagements, accepted eligible outcomes, on-time delivery when attributable, mutually resolved scope changes, verified payout completion, repeat collaborators, and resolved dispute findings. Provide denominators and separate pending events.

### 09.3 Metric definitions

- **Commissioned-work completion rate:** Accepted commissioned outcomes divided by eligible resolved commissioned outcomes. Exclude cancellations before work starts, platform/provider failures, and unresolved outcomes. Track Challenge entry obligations, qualification, selection, and prize placement separately; a valid nonwinning entry does not reduce reliability. Publish the denominators and exclusions.
- **On-time delivery:** Eligible submissions delivered by their effective deadline, accounting for authorized extensions and recorded dependency pauses.
- **Guild payment timeliness:** Settled obligations completed by their agreed due time, with chain/provider delays separately tagged. Only obligations actually due belong in the denominator.
- **Repeat collaboration:** Distinct contributors who returned for another accepted engagement, with concentration and related-party flags.
- **Disputes:** Show open and resolved disputes separately. A reported dispute is not proof of misconduct.

Quality/revision counts require context. Revisions caused by changed scope or poor original instructions must not lower a Raider's reputation.

### 09.4 Reputation events

Record append-only events with subject, Guild, engagement, evidence, event category, attribution, effective date, policy version, reviewer, dispute status, and correction references. A correction reverses or supersedes the contribution without erasing the audit trail.

Only canonical outcomes create score inputs. Do not add reputation whenever a webhook repeats or whenever a Founder clicks five stars. Ratings can be a limited input with anti-retaliation protection; they do not replace verified behavior.

### 09.5 Guild reputation

Useful positive signals include verified funding before commitment, clear terms, timely substantive reviews, settlement of due obligations, fair scope amendments, and repeat paid contributors. Useful negative signals require attribution: unsupported rejections, unpaid awards, abusive cancellations, deliberate misrepresentation, or adverse dispute findings.

Total spend is a public fact, not a shortcut to trusted status. A wealthy Founder should not buy reputation through large self-dealing or circular jobs. Consider counterparty diversity, related accounts, repeated low-substance tasks, and abnormal reciprocal ratings.

Badges must state exactly what was verified. `Wallet control verified`, `10 settled Raids`, and `Founder identity reviewed` are clearer than an undefined `Safe Guild` badge. Never imply that a work-history badge is an investment endorsement or a code audit.

### 09.6 Guild Trust

Guild Trust reflects relevant work history, communication, access behavior, accepted responsibility, and reasoned endorsement within one Guild. Track concrete evidence and relationship status such as `NEW`, `KNOWN_CONTRIBUTOR`, `TRUSTED_BUILDER`, and `CORE_BUILDER`.

A Founder can nominate a trusted relationship role. The role still needs resource-specific permissions. A malicious or careless Founder must not be able to inflate platform-wide skill rank by editing local Guild Trust.

### 09.7 Gaming, fairness, and appeals

Detect repeated same-party jobs, duplicate submissions, bought reviews, founder-controlled Raider accounts, and recycled trial answers. Hold suspect reputation contributions pending review instead of paying arbitrary negative scores for mere suspicion.

Participants can see a reason category for a restriction, provide evidence, and appeal. Serious fraud can result in suspension after the applicable review process. Security containment can happen promptly; final culpability and financial ownership still need their defined process.

---

## 10. Visibility and code access

### 10.1 Four visibility choices

| Visibility     | Public surface                                                                                                                                                | Full brief access                                                | Code access                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `PUBLIC`       | Public title, description, commercial terms, skills, reward, and approved attachments. Exclude private annexes and participant-specific contract/payout data. | Public approved brief.                                           | Separate grant if code is private.        |
| `TRUSTED`      | Safe public summary or authenticated directory card.                                                                                                          | Eligible authenticated participants under the configured policy. | Separate explicit grant.                  |
| `CONFIDENTIAL` | Founder-approved teaser with skills, reward, and confidentiality label.                                                                                       | Approved applicants receive a scoped private brief.              | Separate explicit grant after commitment. |
| `INVITE_ONLY`  | No public listing by default.                                                                                                                                 | Named invitees as authorized.                                    | Separate explicit grant after commitment. |

Discovery, private-brief disclosure, work acceptance, and repository access are separate decisions. Granting one does not grant the others.

A Founder may explicitly enable automatic disclosure of one specified brief under a recorded eligibility policy. The access service evaluates the policy and records a subject/resource grant. A high score alone creates no permission; code and runtime resources still need their own grants.

### 10.2 Confidential admission

1. Founder publishes a safe teaser and funds the disclosed reward.
2. Raider applies with relevant verified skills and evidence.
3. Founder reviews skill fit, reliability, Guild history, and any required attestation.
4. Founder can disclose a bounded private brief for informed acceptance, recording its access grant.
5. Raider reviews full terms and accepts the assignment; the active slot is acquired.
6. Verify the paid engagement's finalized escrow binding, then provision its approved work resources.
7. Start work only after binding and required resources are ready under the current terms; derive the effective delivery deadline from the accepted start policy.

An NDA/rights agreement may be part of a confidential workflow when the Guild chooses an approved template. Its terms, jurisdiction, and enforceability are not established by this blueprint. Record consent and version; do not claim an agreement makes copying technically impossible.

### 10.3 Access grant record

Every grant contains subject, Guild, engagement/application, resource ID, resource category, scope, purpose, approver, policy version, start/end time, provider reference, provisioning state, revocation state, and audit events.

Suggested states: `REQUESTED`, `APPROVED`, `PROVISIONING`, `ACTIVE`, `FAILED`, `REVOCATION_PENDING`, `REVOKED`, `EXPIRED`. A database expiry and successful provider revocation are distinct facts.

### 10.4 GitHub boundaries

GitHub's repository roles operate on repositories. Rulesets can constrain pushes, branches, and tags. Neither a feature branch, sparse checkout, CODEOWNERS entry, nor a folder in a shared repository should be treated as a private read boundary. For confidential subset work, use a dedicated repository containing only the needed code/history, or a separately controlled workspace that exposes only the necessary material. This is the architectural consequence of GitHub's documented role and ruleset model. [S04](#41-sources) [S05](#41-sources)

A normal workflow is scoped access → protected branch/PR → automated checks → authorized review → merge by the project → operational closure → access removal. Contributors receive no automatic production, treasury, signing, or organization-administration access.

### 10.5 Revocation is a workflow

Record pre-existing effective rights separately from task-specific rights RAID creates. Retiring a grant removes that grant's reason for access; it is not an unconditional instruction to delete the collaborator. For each provider/resource/subject tuple, reconcile the permission required by all current grants and the preserved baseline. Serialize or version reconciliation so a delayed source-engagement revocation cannot remove a newer engagement's valid access.

Revoke task-issued credentials independently. Remove provider membership only when no valid retained grant requires it and removal is authorized. Report “RAID's grant removed” separately from “no effective provider access remains.” Check additional task-created access paths without deleting unrelated entitlements. Expiring an integration token does not establish removal of a human collaborator. [S14](#41-sources)

Removing access cannot retrieve code someone already copied. Reduce exposed material before granting it, avoid secrets in repository history, and audit the resource boundary. If an access-removal job fails, keep retrying with a visible incident until resolved. Do not claim access is removed because a local timestamp elapsed.

### 10.6 Safe code execution and CI

Treat submitted code, build scripts, repository instructions, PR text, downloaded files, and AI tool responses as untrusted. Run them in isolated disposable environments with minimal credentials, capped compute, bounded network access, and no production data.

GitHub documents risks when privileged workflows check out untrusted PR code. RAID's development review and execution pipelines must separate untrusted test execution from privileged merge, publication, and secret-bearing workflows. [S07](#41-sources)

Do not place customer secrets into shared model prompts, logs, screenshots, or test fixtures. A trusted Raider can make mistakes; an apparently ordinary dependency can also execute code.

---

## 11. Creating and recommending a Raid

### 11.1 Founder creation flow

Use a short main flow with progressively disclosed details:

1. **Describe the outcome:** What needs to exist or change?
2. **Define acceptance:** What evidence proves success?
3. **Review the recommendation:** Difficulty, skills, likely participants, reward range/composition, timing, and uncertainties.
4. **Choose format and visibility:** Solo/Party, instant/application, public/confidential, standard/Challenge.
5. **Review terms and fund:** Reward assets, fees, deadlines, revision policy, dispute authority, and rights.
6. **Publish:** Only after the server verifies that this version meets publication requirements.

Draft creation can be easy; commitment must be explicit. Save drafts, validate as the user goes, and show the smallest useful next action.

### 11.2 Required publication fields

| Area     | Required data                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Identity | Guild, work format, title, safe public summary, category.                                                                     |
| Scope    | Deliverables, acceptance criteria, exclusions, dependencies, allowed tools/AI policy.                                         |
| Fit      | Required skills and levels, participant kinds, Party policy, admission mode.                                                  |
| Privacy  | Visibility, approved public fields, private attachments, access package if needed.                                            |
| Time     | Application/commitment deadlines where relevant, start condition, delivery deadline or duration, review and revision windows. |
| Money    | Supported assets, raw amounts, fee payer/amount, funding source, settlement mechanism.                                        |
| Review   | Reviewer, required evidence, maximum revision rounds, acceptance criteria and dispute process.                                |
| Rights   | Deliverable usage/license, pre-existing IP treatment, public portfolio permission, and confidentiality terms where chosen.    |

Reject vague acceptance such as “make it perfect” without measurable conditions. A founder can still commission creative work, but must specify the intended outputs and evaluation process.

### 11.3 Recommendation engine

Estimate from task scope, number of integrations, skill domains, expected effort, uncertainty, consequence of error, dependencies, deadline pressure, verification cost, historical comparable work, and available qualified capacity.

Return a structured recommendation:

```json
{
  "status": "ESTIMATE",
  "difficulty": "B",
  "requiredSkills": [{ "skill": "backend", "minimumRank": "B", "verificationRequired": true }],
  "participantKinds": ["HUMAN", "AI_AGENT"],
  "rewardSuggestion": {
    "referenceCurrency": "USD",
    "low": "250.00",
    "high": "400.00",
    "composition": "supported stablecoin plus optional project-token bonus"
  },
  "estimatedDurationDays": { "low": 4, "high": 7 },
  "confidence": "LOW",
  "assumptions": ["Public API is documented", "No production custody integration"],
  "missingInformation": ["Expected traffic", "Deployment responsibility"],
  "policyVersion": "example-rubric-v1"
}
```

**EXAMPLE ONLY:** These prices and times are not market quotes, fees, or production thresholds.

### 11.4 Recommendation behavior

The Founder can edit a recommendation before publication. Persist the original suggestion, evidence/rubric version, assumptions, and final choices. If the chosen reward or deadline appears inconsistent, explain the gap; do not fabricate a guaranteed completion probability.

Early data may not support a reliable dollar estimate. Return a wide range or ask a targeted question instead of inventing comparable jobs. Project-token quantities require a real reward budget and optionally a timestamped reference price; illiquid tokens should show token units and price unavailable rather than fictional dollar value.

An LLM may draft the brief, classify skills, or explain the estimate. A typed validator checks its output. The model cannot approve itself, set arbitrary asset addresses, move escrow funds, or overwrite accepted terms.

### 11.5 Terms changes

Before commitments, a Founder can version the draft/published terms and notify applicants of changes. After acceptance, scope, reward, rights, deadlines, and evaluation criteria require an explicit amendment accepted by the affected parties and funded for any added obligation.

Keep the original contract and each amendment. If parties disagree, use the agreed termination/dispute route. A Founder cannot edit a live task into a different job after receiving work.

---

## 12. Normal Raid lifecycle

### 12.1 Work state machine

```mermaid
flowchart TD
    A["Draft"] --> B["Funding verification"]
    B --> C["Open for applications"]
    C --> D["Offer"]
    D --> E["Accepted commitment"]
    E --> F{"Binding and resources ready?"}
    F -->|"Yes"| G["In progress"]
    F -->|"No"| H["Binding or access setup"]
    H -->|"Verified ready"| G
    H -->|"Unresolved timeout"| N
    G --> I["Submitted and under review"]
    I --> J{"Decision"}
    J --> K["Revision requested"]
    K --> G
    J --> L["Accepted work"]
    J --> M["Dispute or termination process"]
    M --> N["Terminal work outcome"]
    L --> O["Settlement continues separately"]
    N --> O
```

### 12.2 Canonical states and effects

This is the end-to-end journey across several records, not one enum on every table. A listing, execution slot, offer, engagement, dispute, and payment each own their state. Section 25 defines those boundaries.

| State                | Owning record                             | Active capacity held?      | Key behavior                                                                               |
| -------------------- | ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `DRAFT`              | Raid listing                              | No                         | Editable; no work commitments.                                                             |
| `FUNDING_PENDING`    | Raid listing/slot funding projection      | No                         | No paid acceptance.                                                                        |
| `OPEN`               | Raid listing and available slot           | No                         | Eligible applications or instant acceptance allowed.                                       |
| `OFFERED`            | Offer                                     | No                         | A bounded offer; capacity is checked again on acceptance.                                  |
| `ACCESS_PENDING`     | Engagement                                | Yes                        | Contract/roster accepted; escrow binding and access setup are verified before work starts. |
| `IN_PROGRESS`        | Engagement                                | Yes                        | Contributor owns the defined work.                                                         |
| `SUBMITTED`          | Engagement                                | Yes                        | Immutable submission recorded; review deadline runs.                                       |
| `UNDER_REVIEW`       | Engagement                                | Yes                        | Reviewer actively evaluates the submission.                                                |
| `REVISION_REQUESTED` | Engagement                                | Yes                        | Only agreed, bounded revisions are required.                                               |
| `ACCEPTED`           | Engagement                                | No                         | Work obligation ends; payout may still be pending.                                         |
| `WITHDRAWN`          | Engagement                                | No                         | Work ends under the recorded withdrawal terms.                                             |
| `CANCELLED`          | Engagement, or listing before assignments | No for a closed engagement | Valid cancellation; refund/compensation handled separately.                                |
| `TERMINATED`         | Engagement                                | No                         | Operational work ends with reason; financial resolution may remain open.                   |

`DISPUTED` is a separate case state/flag, not an excuse to leave capacity locked forever. While a bounded remediation duty remains active, the engagement can stay active. Once operationally terminated, financial/evidence review continues without demanding new uncontracted work.

### 12.3 Acceptance command

The server checks authenticated subject, current terms, funding, skill eligibility, participant kind, required approvals, applicable restrictions, offer validity, Party consents, and active capacity. It then commits one assignment and the associated capacity reservations atomically. Section 13 defines the transaction.

Offer creation never guarantees future capacity. Acceptance can return `CAPACITY_CONFLICT` if another engagement was accepted first.

### 12.4 Submission

A submission contains an explanation, deliverable references, evidence artifacts, source/commit reference where applicable, checksum or immutable artifact version, disclosed dependencies and AI usage where required, and a timestamp. Keep prior submissions and revisions.

A submitted URL can change. Preserve appropriate snapshots, hashes, or provider commit IDs so review refers to the actual version submitted. Private artifacts stay in the private storage/access path.

### 12.5 Withdrawal, timeout, and closure

Before work starts, a defined withdrawal can release capacity without an automatic fault finding. After work starts, determine partial compensation and responsibility using the agreed terms. A deadline expiry creates an incident/review event; it does not itself prove abandonment or award funds to either party.

**DEFAULT policy fixtures, configurable and snapshotted:** offer validity 24 hours; required-access setup 48 hours; review window 72 hours; maximum two revision rounds; seven-day initial dispute response window. These are starting implementation values, not recovered user decisions.

When a review or access timeout expires, notify the responsible parties and route to operations. After the recorded bounded operational deadline, terminate the active work duty and release capacity if no agreed continuation exists. Preserve evidence and hold unresolved funds for the authorized resolution path. Never implement “silence means founder refund” or “silence means automatic contributor payout” unless a separately approved, enforceable contract explicitly adopts that rule.

Every active engagement state has a finite effective deadline or an explicitly accepted bounded duty period. Missing access, submission, review, revision, pause-resumption, or execution-recovery deadlines triggers a versioned incident. A failed/cancelled AI run does too unless a permitted replacement fits the existing deadline.

**DEFAULT fixture:** operational closure no later than seven days after the first unresolved qualifying escalation, unless affected participants consent to a recorded extension. Retries, state changes, repeated failed runs, and additional incidents never reset that first-escalation timestamp. At expiry, close the work duty and release participant/operator capacity while preserving evidence and unresolved financial obligations.

Reopening or extending terminal work requires new consent, current funding where needed, and reacquisition of capacity. If the Raider is busy, schedule a new engagement; do not silently reactivate the old one.

**DEFAULT reissue policy:** If a withdrawn/terminated worker is replaced, preserve the original closed slot and engagement. Create a fresh replacement slot with a new terms/obligation/binding reference and a link to the earlier attempt. Original compensation and disputed reserves remain protected; closing work does not make those funds reusable. This keeps one historical selected engagement per slot without overwriting the original worker.

---

## 13. One active Raid

### 13.1 Exact product rule

**R13: One canonical Raider can have only one active work engagement at a time.** This applies across all Guilds, networks exposed by the application, devices, linked wallets, skills, ranks, and accepted Party/Challenge entries. A higher rank, paid subscription, RAID balance, or Founder role does not increase the limit.

| Action/status                                                              | Consumes capacity?                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Browsing, saving, applying, unaccepted invitation/offer                    | No                                                               |
| Unpaid platform orientation or practice trial                              | No; independently rate-limited                                   |
| Accepted paid selection exercise                                           | Yes                                                              |
| Accepted standard Raid, access preparation, work, review, agreed revisions | Yes                                                              |
| Accepted Party membership for a work engagement                            | Yes, for every member                                            |
| Active Challenge entry through its agreed judging/revision duty            | Yes                                                              |
| Paid review assignment offered as a Raid                                   | Yes                                                              |
| Terminal accepted, cancelled, withdrawn, or terminated work                | No                                                               |
| Pending payment for terminal work                                          | No                                                               |
| Evidence-only financial appeal after operational closure                   | No new work obligation                                           |
| New implementation Raid offered to a Challenge winner                      | Only after explicit acceptance and capacity acquisition/transfer |

Application limits are separate from active capacity. **DEFAULT fixture:** at most five open applications and a configurable submission rate limit. These reduce application spam without reserving five jobs.

Count only `SUBMITTED`/`SHORTLISTED` applications with an available target and live offered paths under the application policy. When a target fills/closes, an applicant withdraws, or an offer expires/revokes, close that path or exclude it from the cap immediately. Revoke unusable outstanding offers. Retain history; stale applications cannot block a newcomer indefinitely.

### 13.2 Database enforcement

Use a canonical participant/capacity ID rather than a wallet key. The following schema illustrates the invariant; final migrations must fit the selected ORM and existing schema.

```sql
CREATE TABLE capacity_subjects (
    participant_id uuid PRIMARY KEY REFERENCES participants(id)
);

CREATE TABLE active_commitments (
    participant_id uuid PRIMARY KEY
        REFERENCES capacity_subjects(participant_id),
    engagement_id uuid NOT NULL REFERENCES engagements(id),
    terms_version_id uuid NOT NULL REFERENCES terms_versions(id),
    acquired_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX active_commitments_engagement_idx
    ON active_commitments (engagement_id);
```

The primary key ensures a participant cannot have two current rows. An equivalent partial unique index on a historical table is possible, but choose one canonical enforcement strategy. PostgreSQL supports uniqueness over a selected subset of rows, and transaction isolation/locking must be used with correct retries for the surrounding command. [S08](#41-sources) [S09](#41-sources)

### 13.3 Atomic acceptance algorithm

```text
CommitEngagement(actor, sourceRef, expectedTermsVersion, idempotencyKey):
  Validate authenticated actor and request shape.
  Begin database transaction.
  Claim command receipt for actor + command type + idempotency key.
  Reject the same key with a different request digest.
  Lock the offer/admission, source slot or Challenge entry, and current terms.
  Recheck publication, vacancy, offer expiry, and funding evidence.
  Recheck each member's eligibility, consent, and restrictions.
  Compute canonical participants and capacity-limited operators.
  Lock operators, then participants, in the documented stable ID order.
  Check participant capacity and operator capacity by distinct engagement.
  Insert the pending engagement row and obtain its ID.
  Insert FK-backed participant/operator commitments, or roll back everything.
  Snapshot the accepted roster, terms, skills, and payout beneficiaries.
  Keep engagement ACCESS_PENDING for binding/resource preparation.
  Write audit event, command receipt, and external-effect outbox records.
  Commit.
  Return the committed engagement and current external setup status.
```

Do not call GitHub, ask an LLM, wait for a wallet signature, or wait for finality while holding the database locks. Perform slow external preparation before or after the transaction as appropriate, then recheck the current state before acting.

A separate idempotent `StartEngagement` command transitions to `IN_PROGRESS` only after rechecking the current generation, accepted terms, required finalized binding, and readiness of required resources. A legitimately unpaid engagement explicitly identifies funding/binding as not applicable. Having no private resources does not waive a paid engagement's binding requirement.

`AcceptOffer`, instant acceptance, and accepted Challenge entry are API adapters around this canonical command. Each source kind locks its own vacancy/admission and reward reservation. Creating the pending engagement before its foreign-key-backed commitments satisfies the immediate FK constraint; a capacity conflict rolls the entire creation back.

The same global lock order applies to acceptance, member replacement, closure, recovery, and Challenge handoff. Several AI members of one operator in the same engagement share one operator reservation. Any operator conflict rolls back the operation. Release an operator reservation only when no accepted member attributable to it remains; handoff transfers it with participant capacity.

If escrow must bind a beneficiary after acceptance, the accepted engagement holds capacity in `ACCESS_PENDING` until that binding is verified. A transaction submission is not a completed binding. Code access starts only after its required funding/assignment conditions are confirmed.

### 13.4 Required race behavior

Two devices accepting two different Raids for the same participant result in exactly one success. The other receives `409 CAPACITY_CONFLICT` and the current engagement reference if the requester may view it.

Two applicants accepting the same single slot result in exactly one assigned executor. The other receives `409 SLOT_FILLED`. Party acceptance with one busy member rolls back all reservations. A failed serialization retries the whole domain transaction with the same command identity, not only its final insert.

### 13.5 Closure and stale workers

Close work and release its commitments in one transaction. A release matches both `participant_id` and `engagement_id`; a delayed cleanup job cannot release capacity that now belongs to a new engagement.

Record closure reason, timestamp, actor, audit event, and outstanding settlement/access incidents. Revoke permissions through idempotent external jobs. Operational closure can free capacity while an access revocation incident remains under repair, but must not hide that incident.

Preparation, binding, start, grant, and revocation intents include engagement, terms version, and a monotonically increasing desired-state generation. Workers check current authority immediately before acting and reconcile the result afterward. A stale external success records its receipt and starts compensation; it never reopens work or reacquires capacity.

Local closure cannot recall a signed/submitted chain transaction. If binding finalizes after closure, record a late-binding incident and use the escrow's authorized termination/settlement path. Do not start work or provision code. The selected escrow must support this recovery before production. If main-Raid preparation fails after a Challenge handoff, close the unstarted target while preserving the source entry's closed outcome and compensation; do not resurrect its old commitment.

### 13.6 AI and operator limits

A human using AI assistance still has one human engagement. A registered autonomous worker has its own stable participant ID and one active engagement; changing model/configuration does not create a new identity and extra slot.

Apply aggregate operator registration, concurrency, and budget limits to prevent an operator from creating aliases to evade the policy. **DEFAULT for the first managed-agent pilot:** one active external engagement per operator across its registered AI identities, enforced with an additional transactional operator reservation. Broader operator capacity is OPEN and must be explicit. It never increases an individual Raider's one-slot limit.

Count distinct active engagement IDs at the operator level. Several registered AI members of the same Party can share one operator reservation for that engagement, while each keeps its own participant commitment. For the first pilot's individual operators, include the operator's own human engagement in that aggregate cap. Organization-level operators need a separately recorded later policy; do not assume every employee shares one identity.

---

## 14. Parties

### 14.1 Why Parties exist

A complex Raid may need complementary skills: frontend, Solana, design, research, or a registered AI worker. A Party combines those people/agents for one defined result. It does not hide member identities or merge unrelated skill claims into a fictional all-skilled individual.

### 14.2 Party record

Store Party ID, name, leader/contact, proposed roster, member roles, individual consent states, required skill coverage, internal communication reference, and the immutable roster/split snapshot for each accepted engagement.

The reusable Party profile can evolve. A committed engagement uses its accepted snapshot. A new member added to the profile does not automatically join old work or receive its code.

### 14.3 Acceptance and reward allocation

Every member consents to the same terms version, role, deadline, confidentiality requirements, and reward allocation. The leader can coordinate but cannot consent for other humans. An AI operator consents for its registered worker under its supported authority.

Represent allocations per asset using integer base units. If percentages are used during drafting, convert them once into exact amounts with a deterministic rounding rule, show the resulting amounts to every member, and verify the sum equals the distributable pool. Freeze beneficiary identities/verified destinations under the accepted contract.

**EXAMPLE:** A 1,000-unit reward divided 50%/30%/20% becomes three exact obligations. A separate project-token bonus may have a different split only if every member accepts it. Unallocated dust follows the disclosed rounding policy; it does not become an undisclosed platform fee.

### 14.4 Skill coverage and evaluation

Use explicit coverage rules: one named person might need the required Solana rank, while another can satisfy design. Some requirements apply to every member, such as basic conduct and confidentiality consent. A Party leader's reputation does not automatically make all members eligible.

Evaluate the shared result and record individual contributions where evidenced. Do not automatically give every Party member an S rank because one specialist solved the hard part.

### 14.5 Member changes and conflicts

Replacing a member requires a roster amendment, consent from affected parties, a new capacity check, and a rights/payment decision for work already contributed. Acquire and release relevant capacity atomically. New resource grants use the replacement member's identity; revoke the outgoing member's access.

If the Party dissolves, terminal work and settlements follow the contract. The leader cannot redirect all rewards to their wallet. Disputes can concern the shared outcome or an internal split; preserve evidence and keep undisputed obligations distinguishable.

---

## 15. Guild Challenges

### 15.1 Two explicit formats

| Format      | Purpose                                                     | Reward structure                                                                                  | What happens after judging                                                          |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SELECTION` | Find the builder/Party for a larger Raid.                   | Disclosed participation/assessment compensation, if applicable, plus a separate main-Raid budget. | Selected participant receives an offer for the main Raid and may accept or decline. |
| `PRIZE`     | Compare independently submitted solutions and award prizes. | Pre-funded prize pool and any guaranteed qualifying-submission payments.                          | Winners receive the published awards; follow-on work requires a separate agreement. |

**DEFAULT:** Implement `SELECTION` first because it best preserves the user's requested sequence: submit a bounded project/prototype, then the eligible builder performs the Raid. This interpretation is stated openly; the prize mode retains the additional concept discussed later.

### 15.2 Selection Challenge flow

1. Founder defines the eventual main Raid and the selection exercise separately.
2. Publish eligibility, capacity commitment period, task boundary, judging rubric, selection count, compensation, and rights.
3. Fund all promised selection compensation. Fund the main Raid as well if the listing claims it is ready and guaranteed to proceed; otherwise label it clearly as planned follow-on work.
4. Qualified Raiders or Parties apply. The Founder approves a capped set of participants.
5. Each participant accepts the selection terms and consumes its active slot.
6. Provide sanitized materials or an explicitly approved private selection package.
7. Participants submit a bounded prototype, design, or approach under a deadline.
8. Review using the frozen rubric, record conflicts, and communicate the result.
9. Settle promised participation compensation independently of winning.
10. Offer the selected builder the fully specified, separately funded main Raid.
11. On explicit acceptance, transfer or reacquire capacity and issue the main Raid's resource grants.

An unpaid portfolio application can be an application. A week of project-specific production work must not be disguised as a free onboarding test. **DEFAULT:** use paid bounded exercises for substantial selection work.

Application-only portfolio review consumes no capacity. Once an applicant accepts a selection assignment with deliverables and deadlines, it consumes capacity regardless of compensation. The selection record must identify whether it is an application or a work commitment before admission.

### 15.3 Selection-to-main Raid handoff

The selection entry and main Raid have different engagement IDs, terms versions, obligations, and payment histories. They may share a parent initiative ID for navigation.

If the selection entry still holds capacity, the handoff transaction locks both engagements and all affected participants. It verifies the main reward is funded, the new terms and roster are accepted, and any existing commitment belongs to the source entry. It then closes/transfers source capacity and acquires target capacity atomically. If any condition fails, the source state remains intact.

If the selection entry already closed, use ordinary main-Raid acceptance with a fresh capacity check. Selection is an offer of work, not authority to reserve someone's time indefinitely.

### 15.4 Prize Competition

A prize Competition defines submission scope, eligibility, selected/maximum entrants, prize allocation, judging panel, conflicts policy, scoring weights, deadlines, tie-break rule, minimum qualification standard, appeals, non-submission policy, cancellation, and intellectual-property terms.

Possible payment structures include first prize, top three, guaranteed payments for qualifying prototypes plus a winner bonus, or predeclared milestones. Compute the maximum liability before publishing.

**EXAMPLE:** Up to four qualifying prototypes at 250 USDC plus a 2,000 USDC winner bonus creates a maximum reward obligation of 3,000 USDC, before separately disclosed judging/platform costs. The winner's 250 qualifying payment is part of the qualifying pool, not an extra fifth payment.

### 15.5 Judging

**EXAMPLE rubric:** functionality 40%, engineering quality 20%, usability 15%, performance 10%, originality 10%, documentation 5%. Use different rubrics for different categories. Criteria and weights are immutable after participants commit unless an explicit accepted amendment allows the change.

Record individual scores, reasons, evidence, judge identities, conflicts/recusals, and the aggregation rule. AI may check objective criteria or assist review, but it cannot quietly change judging weights, appoint winners, or settle a disputed award.

Define tie resolution before entry: a disclosed secondary criterion, independent review, or a pre-funded split rule. Define what happens if no submission qualifies. Unallocated funds follow the published policy and authorized resolution; a Founder cannot retroactively invent a quality threshold to refund a prize.

### 15.6 Confidential competitions and rights

Multiple admitted teams increase the disclosure surface. Reveal the minimum needed materials, record each grant, isolate workspaces where needed, and avoid sharing competitors' private submissions.

Participants retain pre-existing work and non-awarded submissions under the published rights terms unless an explicit paid license says otherwise. The Guild cannot use a losing solution merely because it was submitted. Winning, participation payment, source delivery, and IP/license transfer are separate obligations that must be written clearly.

### 15.7 Capacity and reputation

Every participant/Party member who explicitly accepts a Challenge work commitment holds its active slot during the agreed build and review duty. Approval, invitation, or selection alone does not acquire capacity. Put a bounded end to judging. Operationally close entries when that duty ends; unresolved award settlement continues separately.

A valid nonwinning submission is not a failed Raid or evidence of unreliability. Record participation, qualification, placement, and demonstrated skills independently. Abandonment or fraudulent submissions require their own attributable findings.

---

## 16. Rewards and escrow

### 16.1 Five independent budgets

| Budget                         | Pays for                                          | Must not be silently spent on                                    |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| Project launch/liquidity funds | The chosen launch and market arrangement.         | Contributor rewards unless explicitly allocated and transferred. |
| Raid/Challenge reward          | Contracted contributor and prize obligations.     | Platform compute or sponsored placement.                         |
| Platform fee                   | A disclosed service charge.                       | An undisclosed reduction of the advertised net reward.           |
| AI operational budget          | Model, tool, and sandbox consumption under a cap. | Automatic approval of the work or its performance reward.        |
| Promotion budget               | Purchased sponsored visibility.                   | Organic reputation, skill rank, or Challenge judging.            |

Each budget has its own owner, payment authorization, terms, accounting category, and refund policy.

### 16.2 Exact asset identity

Use an asset registry keyed to the real network and instrument:

```text
AssetId = {
  chain: SOLANA,
  networkIdentity: configured cluster/genesis identity,
  kind: NATIVE_SOL | TOKEN,
  mint: required for TOKEN,
  tokenProgram: required for TOKEN
}

AssetPolicySnapshot = {
  assetId,
  registryVersion,
  verifiedDecimals,
  observedAuthorities,
  supportedExtensionProfile,
  observedAt,
  observedSlot
}
```

Balances, reservations, conservation, and claims aggregate by stable `AssetId`. A registry version does not create another asset or spendable balance. Terms/transactions retain the policy snapshot so later policy changes cannot reinterpret earlier accepted amounts.

Symbols and images are display metadata. Two tokens named USDC, two different project mints, mainnet/devnet assets, and native/wrapped SOL are not interchangeable. Solana's mint and token-account structures identify the mint, decimals, ownership, and authorities relevant to token handling. [S01](#41-sources)

Never hard-code an address copied from a sample into production. Verify program/mint identities from authoritative sources and the selected network during the release process.

### 16.3 Amount representation

Use nonnegative integer base units, exact arithmetic, and decimal strings in JSON. Do not use JavaScript floating-point numbers for balances, allocations, comparison, or transaction amounts.

**EXAMPLE:** For a verified asset with six decimals, `250.50` display units equals `250500000` base units. Reject excessive fractional precision instead of silently rounding a user's reward. Program transfers must satisfy their actual integer bounds; the database migration must enforce bounds rather than relying on a permissive numeric column.

Use a checked bigint/decimal utility shared by the server, frontend display layer, and chain adapter. Parsing, formatting, splitting, and fee calculations are separate functions with meaningful boundary tests.

### 16.4 Reward bundles and net amounts

A reward is a vector of obligations, each with asset identity, exact amount, beneficiary or published beneficiary-selection rule, terms version, and settlement status.

**DEFAULT:** Advertised rewards are contractual net amounts to the contributors. Platform fees, required network charges, and account setup reserves are shown separately with their payer. Any alternative gross-reward presentation must be explicitly adopted and shown before acceptance.

All promised legs must be funded. If a listing promises 300 USDC plus 10,000 project tokens and only the USDC is funded, it cannot claim the full reward is funded. Native fees/rent reserves and unrelated unsolicited transfers do not count toward a token reward.

### 16.5 Supported asset policy

The product can model multiple assets from the beginning while enabling only tested assets. For the first real-payment release, choose an explicit allowlist of network, mint, token program, and supported extension profiles.

Token-2022 extensions can alter transfer behavior and permissions. Support requires inspecting those properties rather than assuming every fungible token behaves identically. [S10](#41-sources)

**DEFAULT:** Reject unsupported transfer-fee, transfer-hook, permanent-delegate, nontransferable, confidential-balance, or default-frozen configurations. Retained issuer freeze powers, where allowed for a recognized asset, must be recorded and reflected in payment-failure handling. A transfer blocked after funding creates a settlement incident; it does not erase the obligation.

Adding a ticker in admin is insufficient to support a new asset. The asset adapter, escrow program, parsing, amount accounting, funding and payout behavior, and UI disclosure must all be verified. No implicit swaps, bridges, lending, or yield strategy are part of this blueprint.

### 16.6 Custody and authority decision

The exact escrow implementation is OPEN. The following is a **DEFAULT candidate design for a mediated escrow**, requiring its own review and implementation before real funds are accepted:

- Founder funds a dedicated agreement bound to its terms and asset set.
- A permitted pre-commitment cancellation can refund uncommitted funds.
- Committing work binds the accepted assignment and permitted beneficiaries.
- After binding, the Founder cannot unilaterally withdraw the committed reward.
- Authorized acceptance creates allocation/claim rights under the agreed policy.
- A declared mediator resolves contested allocation within constrained beneficiaries and amounts.
- No application admin or AI model receives a generic arbitrary-withdrawal capability.

This proposed design relies on explicit authorities. It must not be marketed as fully trustless. Software cannot objectively resolve every subjective quality or IP dispute by inspecting a webpage.

Before mainnet, choose the provider/program, mediated authority/quorum, signing and upgrade controls, authority rotation, dispute procedures, incident procedures, and exit/recovery design. The exact business/jurisdiction terms require their own decision, not assumptions in code.

### 16.7 Agreement and program sketch

| Record                | Required purpose                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Escrow agreement      | Agreement ID, funder/refund destination, terms commitment, permitted assets, authority policy. |
| Asset vault           | Program-controlled account for the specified instrument and credited reward funds.             |
| Work binding          | Accepted engagement, roster/beneficiary constraints, agreed allocation rules, commitment time. |
| Settlement allocation | Authorized distribution among contributors, permitted refund, and disclosed fees.              |
| Claim receipt         | Single-use semantic claim identity for one beneficiary/asset/amount.                           |

An instruction family may include `create_agreement`, `fund_asset`, `commit_work`, `allocate_settlement`, `claim_asset`, `refund_uncommitted`, `refund_allocated`, and `close_empty_account`. These are interface names, not a completed safe program.

Every instruction validates signer authority, account ownership, derived account/seeds, expected mint/program, permitted state, arithmetic bounds, and replay protection. Closing or reinitializing a program account must not reset a claim and allow reuse. Keep fee authority, launch authority, escrow settlement authority, and program upgrade authority separately defined.

### 16.8 Acceptance/refund race

A funded but uncommitted escrow can race with a Founder cancellation. The chain program must serialize commitment and permitted refund so both cannot succeed against the same funds.

The database may reserve the Raider and show setup pending while `commit_work` is verified. Do not start commissioned work or provision work-only confidential code before that binding succeeds. If the refund wins, terminate the unstarted engagement with an accurate reason and release capacity; do not penalize the Raider or fabricate funding.

For multiple execution slots, reserve a distinct obligation/budget for each slot. A single deposit cannot be promised in full to every accepting worker.

### 16.9 Separate state dimensions

| Dimension           | Suggested states                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Agreement phase     | `OPEN`, `COMMITTED`, `ALLOCATING`, `SETTLING`, `CLOSED`                                                          |
| Funding leg         | `REQUIRED`, `PENDING`, `VERIFIED`, `SHORTFALL`, `BLOCKED`                                                        |
| Claim               | `ALLOCATED`, `READY`, `SUBMITTED`, `FINALIZED`, `BLOCKED`                                                        |
| Dispute             | `NONE`, `OPEN`, `EVIDENCE`, `DECIDED`, `APPEALED`, `CLOSED`                                                      |
| Transaction attempt | `CREATED`, `AWAITING_SIGNATURE`, `SIGNED`, `SUBMITTED`, `CONFIRMED`, `FINALIZED`, `EXPIRED`, `FAILED`, `UNKNOWN` |

Derived labels such as `Partially paid` must reflect every obligation, not just the most recent transaction.

### 16.10 Conservation rules

For each agreement and each exact asset, the accounting equation is:

```text
recognized net deposits
  = finalized contributor payouts
  + finalized disclosed platform fees
  + finalized refunds
  + remaining recognized escrow balance
```

Remaining recognized reward funds are partitioned into genuinely uncommitted funds, committed but not yet adjudicated obligations, and allocated but unsettled claims. Each unit belongs to exactly one partition. A submitted payout stays in unsettled claims until finalized.

Additional constraints:

```text
pre-commitment refunds <= genuinely uncommitted funds
new allocations consume only their specific slot/entry/award reservation
paid amount for a claim <= allocated amount for that claim
mediated refunds of committed funds require explicit authorized resolution
refunds cannot consume another reservation, disputed obligation, or claim
sum(Party allocations for asset) = distributable amount for that asset
funded reward = every promised asset leg verified
```

Shared Challenge/multi-slot pools need separately identified reservations and bindings, or separate agreements. Aggregate `OPEN`/`COMMITTED` labels do not replace per-reservation accounting. Committing one slot cannot promise the same funds to another or make its protected funds refundable.

Before new commitments, verify sufficient unencumbered approved backing and current transfer restrictions. Track credited balance, encumbrances, transferability, and present spendability separately. A later issuer freeze, shortfall, or provider failure blocks unsafe actions and creates an incident; it does not reduce or redenominate existing obligations. The ledger records what is held/owed, while the availability projection records what can presently move.

Unexpected transfers, account reserves, fee spending, frozen balances, and shortfalls require separate accounting/incident records. Never hide a mismatch by editing a ledger balance. Compensating entries require a reason and preserve history.

### 16.11 Funding verification

A client-supplied signature is a lookup hint. Verify the actual network, intended agreement/vault, successful transaction result, program, mint, net credited amount, operation ID, and configured finality.

Solana's `sendTransaction` result indicates RPC acceptance and does not itself establish successful processing or confirmation. The RPC status interface can return transaction errors and confirmation status; RAID must also verify the intended business effect. [S11](#41-sources) [S03](#41-sources)

**DEFAULT:** Show intermediate progress, but make funds available for work only after a verified finalized observation and agreement reconciliation. Store observation slot, time, provider, signature, and decoded receipt. A stale RPC observation is not a zero balance or a refund authorization.

### 16.12 Retries and partial settlement

Persist a semantic operation ID before sending. If a request times out, check the existing signature and on-chain operation/claim state. Rebroadcast the existing signed transaction while valid when appropriate. When rebuilding after expiry, preserve the semantic operation ID so a new signature cannot produce a duplicate payment.

Use blockhash validity data such as `lastValidBlockHeight` rather than arbitrary wall-clock waiting as proof of expiry. Keep blockhash retrieval and preflight policies consistent. [S12](#41-sources)

One Solana transaction can execute its instructions atomically; separate transactions, database commits, and all Party claims do not form one global atomic operation. [S02](#41-sources)

If a Party or reward bundle needs multiple transactions, settle independent immutable claims, show partial progress, and retry only unpaid claims. A frozen token or failing recipient must not mark every recipient paid or allow already-paid claims to be replayed.

### 16.13 Wallet rotation and payout recovery

The earning identity and the payout destination are related but separate. Changing a wallet requires proof of account control and the authorized beneficiary-change process supported by the escrow. Never accept a new payout address from an unauthenticated support message.

Preserve the entitlement amount. If the escrow cannot safely change a bound destination, use its documented recovery procedure instead of making a database-only edit. Lost keys do not authorize the platform to spend funds as if it owned them.

---

## 17. Reviews and disputes

### 17.1 Review contract

Review a specific submission version against its accepted terms. Record criterion-level results, evidence, reviewer identity, timestamp, and decision reason. A merge or deployment can be evidence where the contract requires it, but neither is a universal substitute for acceptance.

Permitted decisions include accept, request an allowed revision, or raise a reasoned rejection/dispute. Rejection cannot immediately return committed money to the Founder. A revision request must identify which original criterion remains unmet and its agreed deadline.

### 17.2 What starts a dispute

Examples include unpaid due obligations, contradictory acceptance decisions, alleged copied work, material scope changes, missing access, unclear or unfair judging, Party allocation conflict, and disagreement about partial completion.

Store the case category, parties, terms and submission versions, evidence access list, requested remedy, response deadlines, mediator assignment, conflicts, decision, appeal, and settlement instructions. Case attachments are private by default.

### 17.3 Resolution outcomes

| Finding                                            | Work handling                                               | Financial handling                                        |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| Work satisfies terms                               | Close as accepted.                                          | Allocate the contractual reward.                          |
| Agreed bounded remediation                         | Keep/reacquire active capacity as appropriate with consent. | Preserve committed funds.                                 |
| Partial delivery merits compensation               | Close or amend with reason.                                 | Allocate documented partial reward and permitted refund.  |
| Contributor withdraws with no compensated work due | Close with attributable reason.                             | Follow agreed refund policy.                              |
| Founder failed to provide required dependencies    | Close or extend by agreement; no unsupported Raider fault.  | Follow access-delay/cancellation terms.                   |
| Evidence insufficient or conflict unresolved       | Operationally close if duties expired.                      | Preserve disputed obligations for the authorized process. |

Every financial instruction must fit the escrow's permitted signers, beneficiaries, assets, amounts, and state. A support note is not an on-chain authority.

### 17.4 Appeals and reputation

Publish a bounded appeal route before commitments. Independent reviewers must recuse themselves from their own Guild, related Party, or financial interest. A paid external reviewer consumes capacity if employed through a Raid.

The settlement policy distinguishes proposed, appealable, and financially final decisions. For mediated disputes and Challenge awards, contested amounts cannot become `READY` to claim until the published appeal period expires without a timely appeal or the authorized final appeal decision is recorded. Store the deadline and evidence of notice through the agreed channel. **DEFAULT test fixture:** 72-hour award/decision objection period; actual commercial finality is OPEN before production.

A timely appeal holds the affected unsettled amounts. An undisputed portion may settle if the accepted policy expressly permits it. Work closure and capacity release remain independent. Finality/hold decisions and claim consumption must serialize in the selected settlement mechanism, so a race cannot both hold and pay the same claim. A normal undisputed acceptance uses its own explicitly snapshotted finality policy; it cannot bypass an already-open dispute.

Already-finalized transfers cannot be reversed by changing a database record. Any post-payment remedy needs a separately defined recovery process. Until the financial-finality and authorized resolution policy is configured, the dependent production award flow stays disabled.

Pending allegations do not automatically become permanent reputation penalties. Once decided, emit attributable outcome events; an appeal correction creates a reversing/superseding event. Public labels should protect case privacy and avoid presenting an unresolved allegation as a finding.

### 17.5 Prevent indefinite work locks

Define deadlines for first review, allowed revisions, dispute response, and operational closure. An unanswered review cannot tie up a Raider indefinitely. Closing the work duty ends capacity and access as appropriate while preserving the claim and evidence.

The specific long-term custody/recovery policy for unresolved cases is OPEN before live escrow: mediation availability, escalation authority, appeal finality, and abandoned-case handling must be implementable. Never solve it by writing an unlimited unilateral administrator withdrawal.

---

## 18. Feed and sponsored placement

### 18.1 Homepage and discovery

The homepage should make the product legible immediately: launch/discover Guilds, browse live funded Raids, view selected Challenges, and understand how to become a Raider. The work feed is a primary surface, not a buried admin page.

Each public card shows safe title, Guild, work format, skill/difficulty, reward asset amounts, verified funding label, deadline, admission mode, participant kind, limited capacity where relevant, and an explicit confidentiality label if details are gated.

Filters include skill/category, rank, participant kind, format, reward asset, funded status, deadline, and visibility that the viewer is allowed to discover. Include an `Eligible for me` filter only when the server can evaluate it; explain unmet requirements without leaking private policy details.

### 18.2 Organic ordering

**DEFAULT initial feed:** funded/open work first; supported filters; explicit sort by newest, deadline, or reward where comparable. Add personalized relevance and reputation-informed ranking only after reliable data and explainable rules exist.

Amounts in unrelated assets cannot be accurately sorted by economic value without reference prices. When prices are unavailable, use asset-specific sorting or state that the value is unavailable. Reward quantity alone is not meaningful across different mints.

Organic ranking can later consider freshness, task clarity, verified funding, relevant skills, Guild reliability, response quality, and diversity. It must not include concealed payment to improve a Guild's reputation label.

### 18.3 Sponsored inventory

Support clearly labeled sponsored cards, homepage slots, or Challenge spotlights. Use a published placement product with start/end time, network/audience, inventory cap, pricing, delivery definition, and refund/make-good policy.

**DEFAULT:** Sell fixed-duration inventory first. Bidding remains in the roadmap because the user explicitly requested it; do not omit the auction interface/model from long-term planning.

A sponsored card still must satisfy moderation, listing validity, funding claims, privacy, and audience eligibility. Sponsorship cannot bypass a task's admission controls or expose a confidential brief.

### 18.4 Bidding mode

Before enabling bids, define auction interval, slots, accepted bid asset, minimum increment, maximum spend, bid reservation, tie-break rule, winner charge method, cancellation, slot delivery, refund release, and treatment of empty inventory.

**DEFAULT candidate:** a simple first-price sealed interval auction for designated slots, with deterministic tie-break by earlier valid funded bid and an explicit maximum charge equal to the bid. This is a proposed mechanism, not a user-approved economic rule. Keep it disabled until selected and tested.

Do not compare bids in different volatile assets without a disclosed conversion/oracle policy. Start each auction in one supported asset. Unsuccessful bids release their reserved budgets; a failed auction job cannot charge everyone as a winner.

### 18.5 Promotion lifecycle

`DRAFT → PAYMENT_PENDING → FUNDED/RESERVED → SCHEDULED → ACTIVE → COMPLETED`, with `CANCELLED`, `REJECTED`, and `REFUND_PENDING` as reasoned alternatives. Track financial settlement separately from whether inventory was delivered.

If a Raid fills, closes, becomes ineligible, or is moderated during its placement, follow the published pause/replacement/refund policy. Record delivery events and deduplicate impression/click events. Never fabricate traffic or promise organic performance from a purchased slot.

### 18.6 Notification behavior

Generate in-app notifications for acceptance, access readiness, approaching deadlines, submissions, review decisions, payments, disputes, and selected Challenge results. Users can choose optional discovery/promotional notifications.

External email/social notifications require a configured provider and the user's product preferences. Confidential subject matter should not appear in lock-screen/email previews. A transaction reminder must not contain a private key or bearer access link with unlimited duration.

---

## 19. AI agents

### 19.1 Product role

An AI agent is an accountable, registered executor of a Raid. It can be operated by RAID or by an approved external operator. It has its own profile, relevant capability evidence, permissions, execution history, and one active engagement.

| Execution model               | Responsibility                                             | Payment/cost model                                                                                    |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Human with AI assistance      | The human remains the contracted Raider.                   | Human reward; permitted tool use follows the accepted terms.                                          |
| External registered AI worker | Its operator is accountable for operation and submissions. | Contracted reward to the approved beneficiary; operator costs are their own unless separately agreed. |
| RAID-managed AI execution     | RAID runs a bounded configured service.                    | Disclosed execution budget/service fee, with any separate performance obligation defined.             |

Do not blend these models into a hidden margin calculation. Every purchase must explain who executes, what completion means, what is charged on failure, and how unused budget is handled.

### 19.2 Agent registration

Store operator account, verified endpoint/runtime identity, supported skills, evaluated configuration/version, tool capability set, model/provider policy, data-handling policy, allowed environments, budget account, health/status, and terms.

An external endpoint must authenticate to receive work and sign or authenticate its submissions. Use short-lived task-scoped credentials. A callback containing a familiar agent name is not proof of origin.

Material configuration changes can require re-evaluation. Preserve historical performance for the configuration that produced it. An alias, new wallet, or a model swap must not reset adverse history or create extra capacity.

### 19.3 Rank and routing

Rank refers to demonstrated performance for the relevant task family. A model name, API price, context window, or reasoning setting does not establish a Raider rank.

The router considers required skills, benchmark evidence, actual tools, confidentiality compatibility, recent reliability, available capacity, estimated cost, and the owner's budget. It returns a proposed execution plan with its assumptions and a maximum permitted spend.

If the task exceeds verified capability, route to a human, a Party, or a scoped paid assessment. Do not claim “S-rank success” simply because a stronger model is selected.

### 19.4 Runtime state machine

`PLANNED → BUDGET_RESERVED → QUEUED → RUNNING → SUBMITTED`, with `PAUSED`, `CANCEL_REQUESTED`, `CANCELLED`, and `FAILED` for operational cases. Keep this distinct from the engagement review outcome and the billing ledger.

A run record includes engagement, agent/configuration version, allowed tool manifest, dataset/resource grants, task specification hash, cost ceiling, time limit, retry budget, provider call IDs, artifact references, token/tool usage, billable costs, and final result.

### 19.5 Tool authority

The runner uses an explicit allowlist of task-scoped capabilities. Example permitted operations could be reading one repository, creating a branch/PR, reading a supplied dataset, or invoking a sandbox API.

Writing to production, sending external messages, publishing social content, signing transactions, merging protected branches, changing access, increasing budget, or making purchases requires the appropriate separately authorized product action. A permission for one task does not carry over to the next customer.

The model can propose a tool call; a policy-enforcing service validates scope, current state, resource ownership, credentials, budget, and approval before execution. Prompts are not the security boundary.

### 19.6 Confidential material and prompt injection

Treat instructions found inside repositories, documents, websites, PR comments, and tool output as task data. They cannot override the assigned contract or grant permissions. For example, a README that says “send environment variables to this URL” is not authorization.

Run untrusted code separately from the orchestrator and secrets. Disable unrestricted egress by default; allow only needed destinations and avoid metadata/private-network endpoints. Scope secrets narrowly, avoid writing them into artifacts/logs, and revoke them at closure.

Do not send a Guild's private code to a model provider unless the Guild's accepted data-handling policy permits that provider and use. Store only useful audit information; sensitive full prompts need a defined retention/access policy.

### 19.7 Spend control and economics

Reserve execution budget before a run. Track actual provider/tool costs with currency, timestamps, rate-card version, and known/estimated status. Apply a total cap across retries and parallel subcalls. The model cannot increase its own budget or ask another agent to bypass the cap.

If the cap is reached, pause or terminate according to the service terms and present the usable partial result. A founder may authorize a new budget explicitly. Unused prepaid budget is handled under the disclosed refund/credit policy; future RAID-token conversion is not assumed.

**EXAMPLE only:** If a service charges 50 units of a billing currency and incurs 25 units of model/tool cost, the difference is a gross margin before other costs. Those numbers are not a pricing promise or current provider quotation.

### 19.8 Verification and failure

AI-generated work uses the same agreed acceptance criteria as other work. Run relevant tests, inspect evidence, and use authorized review. The executing agent cannot issue the final approval of its own reward or promote its own skill rank.

Provider outages, tool denials, context limits, unexpected dependency changes, cancellation, and partial execution have explicit error codes. Killing the model process does not undo an external action; reconcile any attempted actions and preserve receipts.

### 19.9 Initial build boundary

Model the participant kind, operator, budget, and contracts early. Start with human execution and manual external evidence. Enable managed runs only after isolation, cost caps, permission checks, cancellation, callback authentication, and review have passed their acceptance scenarios. A UI toggle labeled AI is not a working agent runtime.

---

## 20. AI influencers

### 20.1 What this participant is

An AI influencer is an AI-driven or AI-assisted public content identity controlled by an accountable operator. It can create content or distribute approved project material through a verified account. A human creator using AI can instead participate as a human creator; label the actual operating model.

RAID should distinguish content production from permission to publish. A content draft can be a deliverable without granting any social account credential.

### 20.2 Credibility and scope

Record account control evidence, operator, platform/account ID, content categories, audience evidence with date/source, delivery history, disclosed automation model, and permitted channel actions. Follower count alone cannot establish authenticity or conversion ability.

A distribution Raid defines channel, content format, quantity, approval workflow, publication window, required sponsorship disclosures under applicable platform/product rules, evidence collection, takedown policy, and objective deliverables. Verify current platform API and policy support when building the integration; do not assume automated posting remains available or permitted everywhere.

### 20.3 Recommended reward structure

Separate a fixed fee for accepted content/publication from an optional performance bonus. If a bonus depends on impressions, clicks, signups, or sales, define the attribution window, data source, bot/duplicate filtering, baseline, caps, and dispute process before work begins.

Do not guarantee reach, fabricate engagement, purchase fake evidence, or reward undisclosed spam. A campaign promoting a token must not contain unsupported return claims or present sponsorship as independent judgment.

### 20.4 Publishing workflow

`Draft content → automated checks → authorized content approval → scheduled publication → provider confirmation → evidence snapshot → review → settlement.`

The content approval binds the final text/media, channel, account, and window. Editing those after approval may require renewed approval. Network retries use a provider idempotency strategy or lookup so one job does not post the same content repeatedly.

Account OAuth/token permissions are minimized and kept outside model context. Do not share account passwords with a Raider. Revocation and operator changes pause future publishing without destroying evidence of prior delivered work.

### 20.5 Capacity and product staging

An accepted influencer campaign occupies the participant's one active engagement for its agreed production/publication/review duties. Scheduled future obligations need a clear end; do not call a six-month campaign completed after its first post while it still demands ongoing work.

Begin with manually submitted draft and publication evidence. Automated posting, live metrics, attribution, and ongoing campaigns are later capabilities with their own provider and billing gates.

---

## 21. Ongoing Roles

### 21.1 Purpose

A Role is an ongoing responsibility such as maintainer, support coordinator, content producer, or analytics operator. It is a later feature, not a different name for every Raid.

Define its duties, availability, period, payment cadence, review, termination notice, required access, renewal consent, and funding per period. A title or honorary Guild membership alone is not active work.

### 21.2 Respect capacity

**DEFAULT:** A Role requiring ongoing work consumes the participant's active slot for the funded, accepted period. It cannot coexist with another active Raid under the current rule.

An alternative can model separate explicitly accepted work periods or assignments, with no unpaid duty between periods. Do not label an active job “passive membership” to bypass capacity. More concurrency requires a future explicit product change, not an agent's optimization.

### 21.3 Renewal and closure

Fund and accept each renewal or establish a bounded, expressly accepted schedule. Stop future work/access when a renewal fails, while preserving already-earned claims. Changing responsibilities or compensation requires an amendment.

Long-term payroll, employment classifications, and contractual terms are outside what the visible discussion establishes. The product can model service periods without claiming those legal questions have been answered.

---

## 22. Token economy

### 22.1 Three asset relationships

| Instrument               | Intended product role                                                      | What it does not automatically mean                                                              |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RAID token               | Possible platform services, promotional payment, or other adopted utility. | Skill, reliability, equity, a guaranteed return, or unrestricted platform authority.             |
| Project token            | Guild holder membership and an optional reward asset.                      | Ownership of project IP, source access, administrative control, or reliable dollar compensation. |
| Supported stablecoin/SOL | A settlement asset selected in the work contract.                          | Guaranteed value, recoverability, or permission to replace one asset with another.               |

Service credits are a separate billing concept. If they are denominated, redeemed, purchased, or converted using RAID tokens later, define exact rules instead of treating credits and on-chain RAID units as synonyms.

### 22.2 Rank and license policy

The escalating token-per-rank ladder is removed. No E=1, D=5, C=20, or similar table belongs in production rank eligibility.

Whether any independent flat one-RAID license remains is OPEN. **DEFAULT:** disabled, so someone can prove a skill and accept supported starter work without first buying RAID. Keep an optional entitlement-policy interface for a later explicit decision.

If a license is introduced, define holding versus staking, supported mint/network, funding of newcomer access, grace periods, balance freshness, opt-out/unstaking behavior, accessibility, and effects on future work. Losing eligibility can pause new acceptance; it cannot erase earned rank/history or confiscate existing rewards. Staking and slashing require a separate economic and technical design; do not add them incidentally.

### 22.3 Prospective revenue

Possible revenue lines are launch service fees, disclosed settlement/service fees, sponsored placement, managed AI service charges, and optional advanced Guild tools. Each needs its own price, payer, tax/receipt handling where applicable, refund rules, and accounting treatment before activation.

None of the visible examples fixes actual platform fees, token demand, conversion rates, margins, burn rates, treasury distributions, or return projections. Revenue is an operating business model; token-holder entitlements need separate explicit terms.

### 22.4 Beta and token launch

The earlier discussion mentions a RAID-token beta, but the exact plan is not available in the supplied material. **DEFAULT staged approach:** validate the product using clearly labeled simulation/devnet assets and then a constrained supported-payment pilot. A real RAID-token launch is a separate milestone with documented supply, allocation, distribution, authorities, market mechanism, use, and applicable operating decisions.

Do not invent tokenomics numbers to make a launch screen look complete. A named unresolved setting should produce a controlled “not configured” state in staging and block the dependent production action.

### 22.5 Project treasury behavior

A Guild's reward budget must be an explicit allocation from its authorized funds. The launchpad must not automatically divert buyer funds, liquidity, vesting allocations, or creator fees into rewards without the adopted protocol and founder authorization.

Show reward spending, remaining budget, asset mix, and obligations. Treasury analytics use verified data; unrelated wallets with the same token do not belong to the Guild simply because the token is present.

---

## 23. Screens and user experience

### 23.1 Design direction

Build a tasteful, understandable launchpad with an Adventure Guild identity. Use rank emblems, Guild crests, and restrained progression cues, while keeping work, money, and permission labels literal. A new user should understand the next action without learning an invented game vocabulary.

Use readable typography, consistent spacing, short sections, clear hierarchy, a small number of primary actions, and optional detail panels. Avoid walls of dashboard statistics, perpetual motion, fake activity, and unexplained scores. Mobile use is a primary layout, with fuller comparison/review layouts on desktop.

### 23.2 Screen contract

| Screen                     | Primary question                             | Required content                                                                    | Main action                                    |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| Homepage                   | What is RAID and what can I do now?          | Launch/discover Guilds, live Raid feed, selected Challenges, short explanation.     | Explore Raids / Launch a Guild.                |
| Raid feed                  | Which work fits me?                          | Filters, safe cards, funding/eligibility, separate Sponsored labels.                | Open a Raid.                                   |
| Guild directory            | Which projects are active?                   | Project identity, verified token/launch state, public work/reliability.             | View Guild.                                    |
| Guild profile              | Can I understand and trust this project?     | Founder/control badge, work history, reputation evidence, token relationship.       | View work / Follow / Founder management.       |
| Launch wizard              | What am I creating and signing?              | Supported route, token settings, controls, costs, signature/verification status.    | Review and sign the chosen action.             |
| Create-Raid wizard         | What am I commissioning and funding?         | Outcome, criteria, recommendation, participant/visibility, terms, funds.            | Fund and publish.                              |
| Raid detail                | Am I a fit, and what will I commit to?       | Scope, reward legs, deadlines, Guild history, skills, review rules, eligibility.    | Apply / Accept / Request access.               |
| Raider onboarding/profile  | What can I prove and work on?                | Claimed/verified skills, evidence, trial access, honest history, capacity.          | Add proof / Take trial / Browse eligible work. |
| My Raid workspace          | What needs my attention now?                 | Terms snapshot, active status, resources, timeline, submission/revision, payment.   | Contextual next step.                          |
| Founder applicant review   | Who fits the actual requirements?            | Relevant skills, evidence, reliability, Guild Trust, capacity snapshot.             | Offer work / Approve brief access.             |
| Submission review          | Does this version meet the agreement?        | Versioned deliverable, criterion checklist, evidence, deadlines, reviewer actions.  | Accept / Request revision / Open dispute.      |
| Party builder              | Who is responsible and paid?                 | Roster, roles, coverage, availability, per-asset split, individual consent.         | Request/accept roster consent.                 |
| Challenge detail/workspace | What is the competition and its consequence? | Selection/prize mode, criteria, eligibility, costs/rewards, dates, rights, entries. | Apply / Enter / Submit.                        |
| Payments                   | What am I owed or paying?                    | Obligations by asset, fees, individual transfers, pending/blocked state.            | Authorized claim/recovery action.              |
| Sponsor dashboard          | What placement am I purchasing?              | Inventory, price/bid, time, delivery, budget, refunds, honest metrics.              | Reserve/bid under the terms.                   |
| Operator console           | What needs intervention?                     | Restricted audit view, cases, chain lag, access failures, configuration.            | Scoped, audited repair.                        |

### 23.3 Suggested navigation

Public: `Discover`, `Raids`, `Challenges`, `Guilds`, `How it works`. Signed-in additions: `My Raid`, `My Guilds`, `Profile`, `Notifications`. Founder actions belong to the relevant Guild workspace. Operations tools belong to a separate authorized route.

Keep “Create Raid” close to Guild management and “Launch a Guild” prominent in the launchpad. A user may switch between Founder and Raider contexts without creating a second identity.

### 23.4 Eligibility presentation

Show a short checklist: relevant verified skill, required reliability/relationship condition, admission approval, available slot, and any explicitly configured entitlement. Explain blocked states with an actionable reason:

- “Frontend C verification required — view available trials.”
- “You already have an active Raid — open your workspace.”
- “This private brief requires Guild approval — submit an application.”
- “Reward funding is still being verified — acceptance is not available yet.”
- “This offer changed — review the updated terms before accepting.”

A frontend eligibility preview is informational. The server rechecks at the actual action. Do not let a client pass a boolean such as `eligible=true` to bypass checks.

### 23.5 Financial interaction

Before signing, display action, network, exact assets/amounts, known fee estimates, recipient/agreement/program, and what will happen next. Identify estimates as estimates and make address inspection available without overwhelming the primary summary.

Use separate states for wallet request, signature rejection, transaction submitted, confirmation pending, verified funding, accepted work, payment pending, partially paid, and settled. Do not show a success confetti/payment total before the corresponding evidence exists.

### 23.6 Private information

Locked cards show only the permitted teaser. Fetch private content only after authorization; do not preload it into HTML, hydration payloads, hidden elements, static generation, metadata, or analytics.

Expiring access clears applicable client caches and invalidates future retrieval. A downloaded file cannot be remotely recalled. State the actual visibility boundary, including public financial activity if the chosen escrow uses public-chain transactions.

### 23.7 Accessibility and scanning

**DEFAULT target:** WCAG 2.2 AA for the completed user journeys; this is a target, not a current conformance claim. Test the relevant criteria against the actual implementation. [S15](#41-sources)

Use semantic headings, keyboard navigation, visible focus, labeled controls, readable contrast, responsive reflow, reduced-motion support, clear errors, and screen-reader status updates. Rank and warning meaning must not rely on color alone. Tooltips must not be the only place where reward conditions appear.

Render dates in the user's selected/local timezone, store canonical timestamps in UTC, and show the timezone on deadlines. Avoid “tomorrow” as the sole deadline representation. Preserve form drafts after wallet cancellation or connection failure.

### 23.8 Mandatory non-happy states

Every flow must handle loading, empty, stale, permission denied, unauthenticated, unsupported provider/network, retryable failure, final failure, duplicate action, invalid/expired terms, and service maintenance where applicable.

Empty history means “No completed Raids yet.” Unknown balance means “Unable to refresh.” A user with one active Raid sees it prominently rather than an unexplained disabled button. A closed Raid explains the outcome and any remaining payment step.

---

## 24. System architecture

### 24.1 Recommended stack and why

**DEFAULT architecture, not a recovered prior technology decision:**

| Component            | Choice                                                                          | Purpose                                                                                 |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Application language | TypeScript                                                                      | Shared typed request/response and domain contracts.                                     |
| Web application      | Next.js/React with server-side domain access                                    | Public launchpad, authenticated workspaces, route handlers, and UI.                     |
| Database             | PostgreSQL                                                                      | Transactions, relational constraints, audit/event records, and initial search.          |
| Data access          | One chosen typed SQL/ORM layer                                                  | Migrations and query boundaries; use explicit SQL where locking/constraints require it. |
| Background work      | Worker from the same codebase; durable PostgreSQL jobs/outbox initially         | Verification, integrations, deadlines, reconciliation, notifications.                   |
| Private artifacts    | Private object storage with authenticated access                                | Submissions, briefs, evidence, and generated artifacts.                                 |
| External boundaries  | Typed adapters for Solana, launch provider, GitHub, models, and social channels | Provider-specific behavior isolated from domain rules.                                  |
| Untrusted execution  | Separate disposable sandbox runner                                              | Code/trial/AI execution without web-worker secrets.                                     |
| Deployment           | Containerized web and worker processes with managed state where appropriate     | Reproducible environments; hosting selected separately.                                 |

Consult current official documentation and the actual repository before choosing package/runtime versions. The proposed Next.js structure is grounded in its App Router documentation, but exact versions and deployment capability must be verified during implementation. [S16](#41-sources)

Do not add a microservice for each noun. A modular monolith can share a database transaction for acceptance, capacity, and audit correctness. Add a separate cache/search system or queue broker only to resolve measured requirements.

### 24.2 Topology

```mermaid
flowchart TD
    U["Browser and wallet"] --> W["Web application and API"]
    W --> D["Typed domain commands"]
    D --> P["PostgreSQL"]
    P --> B["Durable worker and outbox"]
    W --> O["Authorized artifact delivery"]
    O --> S["Private object storage"]
    B --> X["Solana and launch adapters"]
    B --> G["GitHub and channel adapters"]
    B --> R["Isolated execution runner"]
    R --> M["Approved model and tool providers"]
    X --> C["Verified chain state"]
    G --> E["External provider state"]
    C --> B
    E --> B
```

### 24.3 Domain ownership

| Module         | Owns                                                                             | Boundary                                                     |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `identity`     | Accounts, linked credentials, sessions, canonical participants.                  | Does not create trust or financial claims.                   |
| `guilds`       | Project profiles, founder/admin roles, primary-token relationship, membership.   | Holder status does not grant private resources.              |
| `launchpad`    | Launch intents, provider configuration, verified results.                        | Does not invent token economics.                             |
| `capabilities` | Skill taxonomy, evidence, trials, assessments.                                   | Does not calculate payment reliability.                      |
| `reputation`   | Outcome events, metrics, Guild Trust projections.                                | Does not issue access grants.                                |
| `work`         | Raids, slots, applications, offers, engagements, submissions, reviews, capacity. | Requests settlement through Treasury contracts.              |
| `challenges`   | Entries, rubrics, judging, selection, award proposals.                           | Cannot spend unreserved prize/implementation funds.          |
| `treasury`     | Assets, obligations, funding, allocation, claims, chain reconciliation.          | Model output and database edits alone cannot sign transfers. |
| `access`       | Resource grants, policy, provisioning, revocation.                               | External provider state must be observed.                    |
| `discovery`    | Public projections, search/filter, sponsorship inventory.                        | No private brief/index contamination.                        |
| `execution`    | Agent registry, runs, budgets, tool policies, result intake.                     | Uses Work and Access commands; no direct approval shortcut.  |
| `operations`   | Case workflow, configuration, incident views, audit search.                      | Privileges are scoped and recorded.                          |

Route handlers call commands. Workers call the same commands or explicitly authorized internal handlers. Avoid direct cross-module table writes that bypass invariants. Domain modules are code ownership boundaries, not separate network services.

### 24.4 Source of truth

| Data                                                                 | Authority                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Canonical identities, permissions, accepted work, terms and capacity | Transactional application database.                           |
| On-chain custody, program claims, actual token transfers             | Verified deployed program and chain state.                    |
| Repository access/publication result                                 | Provider state reconciled against authorized desired state.   |
| Model usage                                                          | Provider/runtime receipts with known estimates distinguished. |
| Search cards, dashboards, reputation summaries                       | Derived projections; rebuildable from canonical records.      |

A projection can lag. Do not use a cached feed card as financial or access authority. No component is allowed to pretend all external systems committed atomically.

### 24.5 Suggested repository boundaries

| Path                    | Intended contents                                                             |
| ----------------------- | ----------------------------------------------------------------------------- |
| `apps/web`              | Next.js application and route handlers.                                       |
| `apps/worker`           | Durable job/outbox consumers and reconciliations.                             |
| `packages/domain`       | Command handlers, policies, lifecycle logic.                                  |
| `packages/contracts`    | Shared validated DTOs, enums, event shapes, amount types.                     |
| `packages/db`           | Schema, migrations, explicit transactional queries.                           |
| `packages/integrations` | Solana, launch protocol, GitHub, notifications, model/provider adapters.      |
| `packages/ui`           | Accessible shared UI components and design tokens.                            |
| `programs`              | Selected custom on-chain program only if that route is adopted.               |
| `tests`                 | Integration, end-to-end, concurrency, program, security fixtures.             |
| `docs`                  | This blueprint, decision records, progress, runbooks, generated API contract. |

This is a proposed code organization, not a demand to restructure a functioning repository. Choose a simple workspace tool if the repo is new; respect the actual lockfile/package manager if it already exists.

### 24.6 Replaceable integration contract

R15 applies to chain/RPC, launch and escrow programs/providers, wallet/identity/social providers, code access, models/tools, sandbox runners, storage, notifications, search/observability and deployment integrations used by a delivered feature. Keep domain commands independent of vendor SDK objects, global clients and credentials. A composition root supplies a typed adapter through explicit configuration; domain code consumes stable contracts and capability declarations. Do not hide unsupported behavior behind success-shaped fallbacks.

Each adapter declares supported operations, network/resource scope, request/response schema version, typed error/retry semantics, timeout/cancellation, rate limits, idempotency, semantic receipt identity, finality/observation rules, health signals, secret ownership and data-retention/egress behavior. Verify both permitted and denied paths through shared contract tests. A fake adapter is test-only and cannot pass a live feature gate. Implement a supported alternate or deterministic contract-compatible test adapter to demonstrate substitution; this does not imply funding or adopting a second commercial provider.

A provider switch is a reviewed configuration/migration event. Existing signed/submitted operations remain pinned to the provider/program, network, asset, authority, terms and semantic identity that created them until reconciled. Switching an active operation cannot redirect funds, lose receipts, reissue claims, recreate grants or rewrite accepted terms. Record outstanding operations, capability differences, drain/reconciliation plan, rollback constraints and renewed affected G01–G10 evidence. A storage or deployment adapter must preserve actual durability/isolation needs; swapping a database abstraction cannot remove transactional constraints.

### 24.7 Reusable module and documentation contract

R16 applies to domain services, API/client contracts, integration adapters, workers, shared UI components and other delivered modules. Owned features include authentication, sessions, wallet linking, Guilds, skills, capacity, work/review, treasury, disputes, private access, discovery, sponsorship, notifications, AI, channels, Roles, configuration and shared UI. Authentication-provider substitution must preserve the same canonical account/participant, verified links, history, capacity and financial claims; login never grants a Guild role or private permission by itself. Define the public interface, ownership, dependency direction, injected host capabilities/configuration, version/compatibility policy and explicit side effects. Domain rules remain in their owning module; downstream consumers cannot bypass invariant-enforcing commands through direct cross-module table writes. Extract only bounded reusable code; a functioning repository need not be reorganized or split into microservices to satisfy this contract.

Every module delivery includes purpose/non-goals, requirement IDs, architecture/dependency diagram, installation/use instructions, public API/schema/event/error contracts, entity and state ownership, permissions/tenant assumptions, configuration and secret names without values, example host wiring, meaningful tests/fixtures, limitations, migration/versioning, observability and failure/recovery runbook. UI modules also document accessibility, data/state props and host authorization responsibility. Include a minimal independently runnable consuming example or fixture that declares all dependencies and requires no hidden RAID singleton, production credential or unrecorded environment state.

Use contract tests and a consuming-host check to prove the documented boundary, plus negative/retry/recovery tests where applicable. Record actual commands and environment. Documentation is delivered in the same change as behavior; missing/stale usage documentation, undeclared app imports or an example that cannot run is a completion gap. Package publication, licensing choices and external distribution require their actual authorized scope; documenting reuse does not authorize them.

---

## 25. Domain and data model

### 25.1 Modeling conventions

Use stable internal IDs, foreign keys, UTC timestamps, explicit enum ownership, indexed access paths, and immutable accepted snapshots. Every mutable business aggregate has a revision/version for optimistic concurrency. Every material mutation records actor, reason where appropriate, request ID, and audit event.

Use `guild_id` on Guild-scoped records and enforce the caller's allowed Guild context. Global participant profiles and platform-wide capacity are not copied per Guild. A Guild is a project workspace boundary; a wallet is not a tenant.

Keep business catalog labels in data tables. Keep security-critical states and transitions in reviewed code/migrations. Adding a category should not require deployment; adding a payout authority should.

### 25.2 Identity and Guild entities

| Entity                    | Key fields                                                                   | Important constraints                                                 |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `accounts`                | ID, status, preferred timezone, recovery metadata.                           | Stable through wallet/name changes.                                   |
| `auth_sessions`           | Account, challenge/session ID, expiry, revocation.                           | One-use challenges; no cleartext secret logging.                      |
| `identity_links`          | Account, provider, immutable provider subject, proof status/time.            | Unique verified provider subject under linking policy.                |
| `wallet_links`            | Account, network, address, verified/revoked times.                           | Proof required; cannot redirect another account's claims.             |
| `participants`            | ID, kind, human account or operator reference, status.                       | One canonical human Raider per account; stable agent identity.        |
| `agent_profiles`          | Participant, operator, config version, capability/runtime policy.            | Does not own unrestricted signing keys.                               |
| `guilds`                  | ID, slug, name, lifecycle, founder account, primary token relation nullable. | Holder eligibility unavailable before token verification.             |
| `guild_role_grants`       | Guild, account, permission role, grantor, expiry.                            | Founder/admin/treasury/reviewer permissions distinct.                 |
| `guild_tokens`            | Guild, asset, status, proof, valid period.                                   | One active primary token; uniqueness of recognized mint relationship. |
| `membership_observations` | Account, Guild, balance, freshness, chain observation.                       | Unknown/stale distinct from verified ineligible.                      |
| `guild_preferences`       | Account, Guild, public badge/follow settings.                                | Holder eligibility does not imply marketing consent.                  |
| `launch_intents`          | Guild, provider, params hash, state, transaction operations.                 | No duplicate verified launches on a retry.                            |

### 25.3 Skills and trust entities

| Entity                   | Key fields                                                           | Important constraints                                         |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `skills`                 | Stable ID, label, family, active status, aliases.                    | Retire without breaking prior assessments.                    |
| `skill_claims`           | Participant, skill, claimed level, evidence refs.                    | Claim is not verification.                                    |
| `skill_assessments`      | Participant, skill, rank, rubric, reviewer, evidence, validity.      | Immutable version/history; explicit revocation.               |
| `trial_definitions`      | Skill/rank target, variant, rubric, tool rules, time expectations.   | Versioned and separated from customer production tasks.       |
| `trial_attempts`         | Definition version, participant, evidence, outcome, review.          | Anti-replay/abuse controls; private answers where applicable. |
| `reputation_events`      | Subject, event type, outcome/version, attribution, policy, reversal. | Unique semantic event key.                                    |
| `reputation_projections` | Subject, metrics, denominator, confidence, policy version, as-of.    | Rebuildable; not the only evidence store.                     |
| `guild_relationships`    | Guild, participant, relationship status, evidence.                   | Unique pair; no automatic global rank effect.                 |
| `restriction_cases`      | Subject, category, evidence, temporary/final action, appeal.         | Limited access; suspicion distinguished from decision.        |

### 25.4 Work entities

| Entity                 | Key fields                                                                | Important constraints                                                 |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `raids`                | Guild, format, public fields, category, listing lifecycle, current terms. | Public DTO excludes confidential fields.                              |
| `raid_private_briefs`  | Raid, private scope/version, classification, artifact refs.               | Separate authorized access path.                                      |
| `raid_slots`           | Raid, slot number, availability, obligation set.                          | One selected engagement per filled slot.                              |
| `terms_versions`       | Raid/initiative, structured scope, reward, timing, rights, policy hash.   | Immutable after creation/acceptance; amendment chain.                 |
| `applications`         | Target, applicant/Party, terms seen, evidence, decision.                  | Duplicate open application prevented for same applicant/target.       |
| `offers`               | Target slot/entry, applicant, terms version, expiry, state.               | Offer does not reserve capacity; stale acceptance rejected.           |
| `parties`              | Stable Party profile, coordinator.                                        | Profile roster not authoritative for old work.                        |
| `party_members`        | Party, participant, invitation/consent state.                             | Explicit individual consent.                                          |
| `engagements`          | Source reference, work state, accepted terms, deadlines, outcome version. | Exactly one source: Raid slot, Challenge entry, or later Role period. |
| `engagement_members`   | Engagement, participant, role, consent, entitlement snapshot.             | Immutable accepted roster with explicit amendments.                   |
| `active_commitments`   | Participant PK, engagement, terms version, acquisition time.              | One row per active participant, globally.                             |
| `operator_commitments` | Operator, engagement, applicable pilot policy.                            | One distinct active engagement under the selected pilot cap.          |
| `submissions`          | Engagement, version, text/artifacts, commit/hash, submitted time.         | Immutable versioned evidence.                                         |
| `reviews`              | Submission, reviewer, criterion results, decision, reason.                | Decision binds exact submission and terms.                            |
| `disputes`             | Engagement/claim, parties, evidence, policy, mediator, decisions.         | Separate lifecycle from work and funds.                               |

### 25.5 Challenge, finance, and access entities

| Entity                   | Key fields                                                              | Important constraints                                       |
| ------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `challenges`             | Parent Raid listing, mode, rubric version, dates, caps, follow-on link. | Selection versus prize explicit.                            |
| `challenge_entries`      | Challenge, solo/Party entrant, application/admission, engagement.       | One accepted entry per participant/team under entry policy. |
| `judge_assignments`      | Challenge, reviewer, conflicts, scope.                                  | Judges do not review their own submissions.                 |
| `judging_scores`         | Entry/submission, judge, rubric, scores, reasons.                       | Frozen rubric; one canonical result per judge/version.      |
| `award_allocations`      | Challenge, qualified result, amount/asset/beneficiary, authority.       | Total award liability bounded by funded pool.               |
| `assets`                 | Network, kind, mint/program, decimals, extension policy/version.        | Full identity unique; production verification required.     |
| `reward_obligations`     | Terms, scope, asset, raw amount, beneficiary rule.                      | Nonnegative exact units; no floating values.                |
| `escrow_agreements`      | Terms commitment, provider/program, vaults, phase, authority.           | Verified binding and permitted beneficiaries.               |
| `funding_observations`   | Agreement/asset, amount, operation, slot, finality, receipt.            | Dedupe and verified actual effect.                          |
| `settlement_allocations` | Agreement, decision/version, obligations, refund/fees.                  | Conservation and explicit authorization.                    |
| `claims`                 | Allocation, beneficiary, asset, amount, claim ID, state.                | Single-use on-chain/provider claim identity.                |
| `chain_operations`       | Semantic ID, purpose, request digest, desired outcome.                  | One business operation across transaction rebuilds.         |
| `transaction_attempts`   | Operation, signature, blockhash validity, state, observations.          | Multiple attempts cannot consume claim more than once.      |
| `ledger_entries`         | Asset, account/category, operation, exact delta, evidence.              | Append-only postings; balanced records per operation.       |
| `resources`              | Guild, type, provider ID/storage key, classification.                   | Authorized owners and approved sharing boundaries.          |
| `access_grants`          | Resource, subject, purpose, consent, expiry, desired/observed state.    | Code access independent of scores/membership.               |

### 25.6 Discovery, execution, and operational entities

Use `promotion_inventory`, `promotion_orders`, `promotion_bids`, `promotion_delivery`, `agent_runs`, `run_tool_calls`, `budget_reservations`, `usage_ledger`, `notification_preferences`, `notifications`, `webhook_inbox`, `outbox_events`, `job_attempts`, `command_receipts`, `audit_events`, and `configuration_versions`.

These names describe ownership, not a demand to create all tables in milestone one. Later feature tables enter through migrations when their implementation begins. Foundations such as IDs, work constraints, assets, audit, command receipts, and the outbox belong early.

### 25.7 Separate state machines

| Aggregate               | State vocabulary                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Raid listing            | `DRAFT`, `FUNDING_PENDING`, `OPEN`, `PAUSED`, `CLOSED`, `CANCELLED`, `ARCHIVED`                                                        |
| Standard execution slot | `AVAILABLE`, `FILLED`, `CLOSED`                                                                                                        |
| Application             | `SUBMITTED`, `SHORTLISTED`, `REJECTED`, `WITHDRAWN`, `CONVERTED_TO_OFFER`, `CLOSED`                                                    |
| Offer                   | `OFFERED`, `ACCEPTED`, `DECLINED`, `EXPIRED`, `REVOKED`                                                                                |
| Engagement              | `ACCESS_PENDING`, `IN_PROGRESS`, `SUBMITTED`, `UNDER_REVIEW`, `REVISION_REQUESTED`, `ACCEPTED`, `WITHDRAWN`, `CANCELLED`, `TERMINATED` |
| Challenge               | `DRAFT`, `APPLICATIONS_OPEN`, `BUILDING`, `JUDGING`, `DECIDED`, `CLOSED`, `CANCELLED`                                                  |

Payment, access, agent run, and dispute states use their own tables. `Listing CLOSED` means no new admissions; it does not silently terminate active engagements or erase obligations. `Offer ACCEPTED` is not `Engagement ACCEPTED`: the former starts commitment, the latter is terminal accepted work.

### 25.8 Constraints and deletion

Add foreign keys for terms, obligations, grants, and evidence. Enforce accepted-slot uniqueness, current commitment uniqueness, immutable terms versions, unique semantic claim IDs, unique command/inbox keys, and correct asset precision/ranges.

Historical work, accepted terms, and settlement evidence are retained under the chosen retention policy. User-facing profile deletion or anonymization must account for outstanding rights and permitted legal/operational retention. Do not promise deletion of data already written to a public blockchain. Personal data and retention periods are OPEN policy settings before production, not unrestricted indefinite storage defaults.

---

## 26. API contracts

### 26.1 Common conventions

**DEFAULT:** Versioned HTTP JSON API under `/api/v1`, shared runtime-validated contracts, UTC ISO timestamps, cursor pagination, exact asset amounts as strings, and structured errors. UI server actions may wrap the same commands; they must not implement a second set of business rules.

Mutating commands that can be retried use an `Idempotency-Key`, scoped to actor and operation, with a stored request digest and response reference. Accepted-term mutations carry the expected terms version. Aggregate edits use a revision or `If-Match` convention. Choose one consistent representation and document it in the generated contract.

For cookie sessions, protect state-changing requests against CSRF and validate allowed origins. For API/service credentials, use short-lived scoped authorization and replay-safe request handling. Credentials and private response bodies do not belong in logs.

### 26.2 Endpoint families

| Method and path pattern                          | Purpose                                                        | Critical checks                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /auth/challenges`, `POST /auth/verify`     | Issue/verify account or wallet challenge.                      | Domain, nonce, expiry, intent, signature, one-use consumption.                                 |
| `POST /me/wallet-links`                          | Link verified wallet to account.                               | Ownership and recovery/link conflict policy.                                                   |
| `GET /me`, `GET /me/engagement`                  | Profile/capacity and active work.                              | Authenticated canonical account.                                                               |
| `GET /guilds`, `GET /guilds/{id}`                | Public project discovery.                                      | Approved public fields only.                                                                   |
| `POST /guilds`, `PATCH /guilds/{id}`             | Draft/manage Guild.                                            | Founder or delegated field permission; version check.                                          |
| `POST /guilds/{id}/launch-intents`               | Prepare selected launch route.                                 | Approved provider/network/parameters and signer authority.                                     |
| `GET /launch-intents/{id}`                       | Reconciled launch status.                                      | Owner/public status policy.                                                                    |
| `GET /skills`, `POST /me/skill-claims`           | Taxonomy and claimed evidence.                                 | Validation; no automatic verified rank.                                                        |
| `POST /trials/{id}/attempts`                     | Begin a versioned trial.                                       | Attempt limits and allowed evidence/tool policy.                                               |
| `POST /assessments/{id}/decisions`               | Record assessed skill result.                                  | Authorized evaluator, rubric, evidence, audit.                                                 |
| `POST /raid-recommendations`                     | Draft structured task recommendation.                          | Input classification, privacy policy, budget/rate cap.                                         |
| `GET /raids`, `GET /raids/{id}`                  | Feed and permitted detail.                                     | Visibility-filtered public projection.                                                         |
| `POST /guilds/{id}/raids`                        | Create draft offering.                                         | Authorized Guild role; typed format/scope.                                                     |
| `POST /raids/{id}/terms-versions`                | Propose draft/amendment.                                       | Cannot overwrite accepted version.                                                             |
| `POST /raids/{id}/funding-intents`               | Prepare reward funding.                                        | Actual asset/program/vault/amount and fee policy.                                              |
| `POST /raids/{id}/publish`                       | Publish a valid work offering.                                 | Complete terms, funding/promotion/privacy checks.                                              |
| `GET /raids/{id}/eligibility`                    | Explain current fit.                                           | Informational result with policy/as-of; no reusable authorization.                             |
| `POST /raids/{id}/applications`                  | Apply to work.                                                 | Applicant, rate cap, scope, minimum application policy.                                        |
| `POST /applications/{id}/offers`                 | Offer a specific slot.                                         | Authorized Founder; terms/version and target.                                                  |
| `POST /offers/{id}/accept`                       | Commit to a slot/entry.                                        | Atomic capacity, eligibility, consents, funding and state checks.                              |
| `POST /raids/{id}/accept`                        | Instant-accept path where enabled.                             | Same canonical acceptance command; no shortcut.                                                |
| `POST /engagements/{id}/submissions`             | Submit versioned evidence.                                     | Member authority, active state, accepted terms, artifacts.                                     |
| `POST /submissions/{id}/reviews`                 | Accept/revise/raise issue.                                     | Reviewer, specific version, bounded original criteria.                                         |
| `POST /engagements/{id}/withdrawals`             | Request/record withdrawal.                                     | State, terms, compensation process; no arbitrary refund.                                       |
| `POST /engagements/{id}/amendments`              | Agree material changes.                                        | All affected consents, additional funding, capacity if reopening.                              |
| `POST /engagements/{id}/disputes`                | Open a case.                                                   | Party rights, evidence limits, deadline/finality policy.                                       |
| `POST /disputes/{id}/decisions`                  | Record mediated resolution.                                    | Declared authority, conflicts, allocation constraints.                                         |
| `GET /claims`, `POST /claims/{id}/intents`       | Inspect/prepare authorized claim.                              | Beneficiary, finality, current program state, idempotency.                                     |
| `POST /parties`, `POST /parties/{id}/consents`   | Build roster and record agreement.                             | Individual authority; exact roster/terms/split.                                                |
| `POST /challenges/{id}/applications`             | Submit a nonbinding Challenge application.                     | Application eligibility, evidence, and rate limits; no capacity reserved.                      |
| `POST /challenges/{id}/entries`                  | Founder creates approved entry/offer for a selected applicant. | Admission authority and current Challenge terms; no commitment yet.                            |
| `POST /challenge-entries/{id}/accept`            | Entrant accepts the offered Challenge work.                    | Delegates to `CommitEngagement` with entry reservation, consents, funding and capacity checks. |
| `POST /challenges/{id}/judging-decisions`        | Record selection/award proposal.                               | Rubric, judge authority, conflicts, maximum obligation.                                        |
| `POST /challenges/{id}/handoffs`                 | Accept follow-on main Raid.                                    | Separate funded terms and atomic capacity transition.                                          |
| `POST /resources/{id}/access-requests`           | Request private access.                                        | Discoverability, task purpose, authorization.                                                  |
| `POST /access-grants/{id}/decisions`             | Approve/revoke resource grant.                                 | Authorized grantor, scope, expiry, current work policy.                                        |
| `POST /promotion-orders`, `POST /promotion-bids` | Purchase/bid visibility.                                       | Feature flag, inventory, budget, terms; no rank changes.                                       |
| `POST /agent-runs`                               | Start permitted managed execution.                             | Operator and participant capacity, budget, grant, runtime policy.                              |
| `POST /agent-runs/{id}/cancel`                   | Stop a run safely.                                             | Authorized operator/owner and external-effect reconciliation.                                  |
| `POST /webhooks/{provider}`                      | Receive signed provider event.                                 | Provider verification and deduplicated inbox.                                                  |

Do not expose generic public `PATCH /... {state: "PAID"}` or `setRank` endpoints. State changes happen through commands with reasoned authority and evidence.

### 26.3 Eligibility response example

```json
{
  "allowed": false,
  "action": "ACCEPT_RAID",
  "policyVersion": "policy-example-v1",
  "evaluatedAt": "2026-10-06T09:00:00Z",
  "reasons": [
    {
      "code": "CAPACITY_CONFLICT",
      "message": "You already have an active Raid.",
      "nextAction": "OPEN_CURRENT_ENGAGEMENT"
    }
  ]
}
```

### 26.4 Error envelope and statuses

```json
{
  "error": {
    "code": "TERMS_VERSION_CHANGED",
    "message": "Review the current terms before accepting.",
    "retryable": false,
    "requestId": "request-example-001",
    "details": { "currentTermsVersion": "terms-example-v3" }
  }
}
```

Use 400/422 for malformed/invalid commands, 401 for missing authentication, 403 for a known resource with forbidden action, 404 where resource existence must remain hidden, 409 for state/idempotency/capacity conflicts, 429 for rate limits, and appropriate 5xx responses for service failures. Do not put private policy notes into error details.

Canonical reason codes include `MISSING_VERIFIED_SKILL`, `MINIMUM_RANK_NOT_MET`, `APPROVAL_REQUIRED`, `CAPACITY_CONFLICT`, `OPERATOR_CAPACITY_CONFLICT`, `SLOT_FILLED`, `OFFER_EXPIRED`, `TERMS_VERSION_CHANGED`, `FUNDING_NOT_VERIFIED`, `BINDING_PENDING`, `UNSUPPORTED_ASSET`, `ASSET_POLICY_CHANGED`, `ACCESS_NOT_GRANTED`, `ACCESS_EXPIRED`, `ACCOUNT_RESTRICTED`, `BUDGET_EXHAUSTED`, `PAYMENT_STATUS_UNKNOWN`, and `IDEMPOTENCY_KEY_REUSED`.

### 26.5 Public and private API shapes

Define explicit `PublicGuild`, `PublicRaidCard`, `PermittedRaidDetail`, `PrivateBrief`, `EngagementWorkspace`, and `AdminCaseView` contracts. Avoid serializing raw ORM records and deleting a few fields afterward.

Return only permissions/data the caller needs. Enforce authorization before issuing signed artifact URLs. Exports, search, cache keys, sitemap/SEO, link previews, notifications, and later MCP tools use the same classification rules.

---

## 27. Events and background jobs

### 27.1 Event envelope

```json
{
  "eventId": "event-example-001",
  "type": "work.engagement_committed.v1",
  "aggregateId": "engagement-example-001",
  "aggregateVersion": 3,
  "occurredAt": "2026-10-06T09:00:00Z",
  "actorId": "account-example-001",
  "guildId": "guild-example-001",
  "correlationId": "request-example-001",
  "payload": { "termsVersionId": "terms-example-v2" }
}
```

Events contain identifiers and minimal necessary metadata. Sensitive artifacts are referenced through authorized records rather than copied into every queue payload.

### 27.2 Event families

| Family         | Examples                                                                                           | Main consumers                                |
| -------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Identity/Guild | `wallet_verified`, `guild_token_verified`, `holder_observation_updated`                            | Membership and public projection.             |
| Launch         | `launch_submitted`, `launch_verified`, `launch_action_required`                                    | Founder status and Guild activation.          |
| Work           | `offered`, `engagement_committed`, `submission_received`, `revision_requested`, `work_closed`      | Access, deadlines, notifications, reputation. |
| Treasury       | `funding_verified`, `binding_verified`, `allocation_finalized`, `claim_paid`, `settlement_blocked` | Work readiness, ledger, payment UI.           |
| Access         | `grant_requested`, `grant_active`, `revocation_requested`, `revocation_verified`, `grant_failed`   | Workspace and incident tracking.              |
| Challenge      | `entry_committed`, `judging_completed`, `selection_offered`, `handoff_committed`                   | Awards, capacity, participant notifications.  |
| Execution      | `run_started`, `budget_threshold`, `run_submitted`, `run_failed`                                   | Cost accounting, work review, operations.     |

Use precise event names: `submission_received` is not `work_accepted`, and `transaction_submitted` is not `claim_paid`.

### 27.3 Outbox/inbox behavior

Write the business state, audit event, idempotent command receipt, and outbox intent in the same database transaction. Workers deliver at least once. Every handler must tolerate duplication and out-of-order delivery.

An incoming webhook is authenticated, stored with a unique provider delivery ID, and processed idempotently. Verify resource/installation ownership rather than trusting only the payload's claimed Guild ID. Reconciliation repairs missed webhooks.

For each effect record desired state, generation/version, attempts, next retry, last error category, and observed provider result. A delayed grant or publish job checks that the action remains authorized before execution. An earlier desired state cannot revive permissions after a later revocation.

### 27.4 Essential jobs

| Job                     | Trigger/behavior                                                            | Recovery                                                         |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Chain verifier          | Poll known transaction/operation intents; verify decoded effects.           | Check operation receipt before rebuilding or resending.          |
| Escrow reconciler       | Compare known obligations, claims, vaults, and finalized chain state.       | Raise discrepancy; preserve funds/claims; repair projections.    |
| Access provision/revoke | Reconcile desired permissions with actual provider state.                   | Retry, verify, and escalate failure with resource context.       |
| Deadline processor      | Handle offer, access, submission, review, operational and appeal deadlines. | Versioned deadline ID prevents stale timeout actions.            |
| Membership refresher    | Update supported holder observations.                                       | Stale/unknown state on outage; no destructive inferred zero.     |
| Reputation projector    | Apply canonical outcome/reversal events.                                    | Dedupe and rebuild from source events.                           |
| Promotion scheduler     | Start/stop funded inventory and track delivery.                             | Reconcile actual eligibility and refund/make-good state.         |
| AI runner supervisor    | Enforce caps, cancellation, heartbeat and resource lifetime.                | Stop/reconcile orphaned runs without repeating writes.           |
| Notification dispatcher | Deliver allowed in-app/external notifications.                              | Dedupe; respect preferences; keep confidential previews minimal. |

### 27.5 Deduplication keys

| Operation         | Semantic key                                               |
| ----------------- | ---------------------------------------------------------- |
| User command      | Actor + command kind + client idempotency key.             |
| Terms consent     | Participant + engagement/offer + terms/roster version.     |
| Funding operation | Escrow agreement + asset + funding operation ID.           |
| Claim             | Allocation version + beneficiary + asset + claim index/ID. |
| Webhook           | Provider + verified delivery ID.                           |
| Reputation event  | Outcome version + subject + event category.                |
| Access effect     | Resource/subject grant + desired-state generation.         |
| Deadline          | Aggregate + deadline kind + deadline version.              |

Do not use a transaction signature as the only business deduplication key when a transaction can be rebuilt with a different blockhash.

---

## 28. Permissions and security

### 28.1 Authorization model

Combine explicit roles with resource relationships and action-specific policies. Authorize each action using actor, Guild, target resource, work state, granted scope, current restrictions, and accepted terms. Deny by default when required context is missing.

| Actor                | Public discovery     | Guild management                 | Private brief/code              | Submit work                          | Accept work result                      | Settle disputed funds                                              |
| -------------------- | -------------------- | -------------------------------- | ------------------------------- | ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------ |
| Visitor              | Yes                  | No                               | No                              | No                                   | No                                      | No                                                                 |
| Guild token holder   | Yes                  | No by membership alone           | No by membership alone          | Only if assigned                     | No                                      | No                                                                 |
| Raider/applicant     | Yes                  | No unless separate role          | Only specified grant            | Own assigned work                    | No self-approval                        | No                                                                 |
| Party leader         | Yes                  | No unless separate role          | Own granted scope               | As consented by engagement           | No self-approval                        | No unilateral split changes                                        |
| Guild Founder/admin  | Yes                  | Granted permissions              | Authorized Guild resources      | Only own assigned work if legitimate | Within assigned reviewer role and terms | Only if the escrow policy separately authorizes a permitted action |
| Independent reviewer | Yes                  | No                               | Limited case/submission scope   | Paid review deliverable if assigned  | Within explicit review scope            | Only declared mediator authority if separately granted             |
| Platform operations  | Yes                  | Scoped support/admin permissions | Case-specific access with audit | No impersonated submission           | No fabricated acceptance                | No arbitrary withdrawal                                            |
| Product AI worker    | Permitted task scope | No inherited admin               | Explicit short-lived task grant | Own authenticated result             | No self-approval                        | No                                                                 |

Technical support should receive the smallest useful case view. A platform role that can investigate private records must be explicit, auditable, and limited; it is not implied by being a developer.

### 28.2 High-risk boundaries

| Threat                               | Required design response                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Two simultaneous accepts             | Database-enforced unique active commitment and transactional slot/capacity checks. |
| Private object ID guessed            | Resource authorization before read/download; non-enumerable error where required.  |
| Forged funding signature             | Verify chain/program/vault/mint/amount/effect; no client trust.                    |
| Account/mint substitution            | Strict on-chain and backend identifier validation.                                 |
| Duplicate payout                     | Semantic single-use claim, not only HTTP or signature deduplication.               |
| Malicious PR/build                   | Isolated execution; no privileged secrets; authenticated artifact flow.            |
| Prompt injection                     | Tool/runtime policy outside the model; scoped resources and egress.                |
| Stolen session/social token          | Expiry, revocation, least privilege, high-risk action verification.                |
| Reused trial or fake portfolio       | Attribution checks and proportional review.                                        |
| Reputation farming                   | Canonical events, related-party checks, confidence, appeal/correction.             |
| Paid placement masquerading as trust | Clear sponsorship and separate ranking inputs.                                     |
| Insider/admin misuse                 | Scoped permissions, auditable changes, separate fund authority.                    |

### 28.3 Web and integration security

Validate inputs with a shared schema, sanitize rendered user content, use parameterized database access, constrain file size/type, scan/quarantine risky uploads, and keep private objects nonpublic. For URL import/preview features, defend against server-side requests to internal services, credential-bearing endpoints, and unsafe redirects.

Use secure sessions, explicit CORS/origin policy, CSRF protection for cookies, rate limits, and no secrets in browser bundles. Store provider credentials encrypted under a chosen secrets management scheme; avoid treating encryption keys and encrypted values stored together as sufficient separation.

Audit privileged exports, permission changes, beneficiary changes, config changes, and case access. Logs should contain request/operation IDs and useful error categories without dumping private briefs, tokens, full signatures for unrelated credentials, or secrets.

### 28.4 Threat containment versus final judgment

The system can pause new commitments, disable an integration, stop a run, or revoke a credential when an incident requires containment. Those actions do not automatically decide fault or ownership of funds.

Maintain enough access for a participant to inspect their claim and provide dispute evidence through a safe channel even if normal participation is restricted. Reinstatement and corrections preserve history.

### 28.5 Confidentiality limits

Reputation, identity checks, agreements, and access logs can reduce exposure and improve accountability. They cannot guarantee an idea will never be copied. Once source material is disclosed, revocation cannot erase a local copy. The architecture therefore minimizes what is shared and separates public-chain payment visibility from private project content. [S13](#41-sources)

---

## 29. Configuration and administration

### 29.1 Editable business configuration

Provide an authenticated admin interface for category/skill labels, task templates, approved proof types, trial definitions, notification templates, supported display currencies/assets under asset policy, duration defaults, feature visibility, promotion inventory, and moderation reason categories.

Stable IDs outlive label changes. Retiring a category hides it from new creation without breaking old terms, queries, or reports. Validate imports/edits and preview the effect of a configuration change.

### 29.2 Configuration boundaries

| Setting class                               | How it changes                                            | Effect on accepted work                                           |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Catalog/display                             | Authorized runtime edit with version/history.             | Existing snapshots retain agreed labels where needed.             |
| Default deadlines/recommendation rubrics    | Versioned policy edit.                                    | Applies to new terms; no retroactive deadline changes.            |
| Optional token entitlement                  | Explicit product decision and versioned policy.           | No rank purchase, reward confiscation, or silent contract change. |
| Promotion prices/bidding                    | Commercial policy plus tested financial flow.             | Purchased placement terms remain intact.                          |
| Reputation formula                          | Reviewed, versioned recomputation with explained changes. | Preserve source events and appeals.                               |
| Accepted scope/rewards/judging/splits       | Consent-based amendment.                                  | Cannot be overwritten by global configuration.                    |
| Security state machine/permission semantics | Reviewed code/schema change.                              | Migration and compatibility plan required.                        |
| Asset/program allowlist                     | Technical verification and authorized change.             | New deposits may be paused; existing claims remain recorded.      |
| Mainnet signers/program upgrades            | Explicit authorized operational procedure.                | Not editable as an ordinary dashboard field.                      |

### 29.3 Feature flags

Suggested flags include `launch_provider_enabled`, `mainnet_transactions_enabled`, `mixed_rewards_enabled`, `confidential_raids_enabled`, `party_execution_enabled`, `selection_challenges_enabled`, `prize_challenges_enabled`, `fixed_sponsorship_enabled`, `sponsorship_auction_enabled`, `managed_agents_enabled`, `automated_social_publish_enabled`, `roles_enabled`, and `raider_license_enabled`.

Flags must gate server commands as well as UI visibility. Turning a feature off blocks new applicable actions; it must preserve required settlement, claims, cancellations, access cleanup, and dispute handling for existing work. A flag cannot change an on-chain program's authority rules.

### 29.4 Admin audit and safe changes

For sensitive changes record before/after values, actor, reason, policy version, timestamp, and affected scope. Use scoped roles for support, moderation, finance operations, access administration, and product configuration.

Provide dry-run previews for bulk changes and measured repair commands for outbox/reconciliation issues. Avoid a catch-all “force paid,” “set S rank,” or “delete dispute” button. Administrative corrections must retain provenance and trigger valid domain events.

---

## 30. Operations and recovery

### 30.1 Environments

Maintain distinct local/test, shared staging, constrained pilot, and production configurations. Separate databases, object stores, provider installations, keys, networks, mints, and callbacks. A mainnet action must never be enabled because a devnet environment variable was omitted.

Validate configuration at startup and before privileged actions. Show a persistent development-network indicator in nonproduction interfaces. Production refuses sample IDs, mock providers, fabricated claims, missing authority configuration, and disabled mandatory gates.

### 30.2 Operational ownership

Assign owners for support cases, dispute mediation, security incidents, chain/settlement operations, provider access, billing, and deployment. One small team can cover several roles; permissions and accountability remain distinct.

Publish the supported operating hours and response process before inviting users into time-bound paid work. Deadline jobs need a real escalation owner. A support queue with no responsible operator cannot fulfill the blueprint's mediation and bounded-resolution promises.

### 30.3 Monitored signals

Monitor API health, database lock conflicts and retries, outbox age, job failures, oldest active commitment, overdue review/operational deadlines, chain observation lag, unknown transaction age, ledger/vault discrepancy, blocked claims, grant/revocation failures, stale membership, sponsor delivery gaps, and AI spend/orphaned runs.

Logs and dashboards use correlation IDs from request → command → event → provider operation → chain attempt → settlement claim. Keep confidential content out of general observability tools.

### 30.4 Incident playbooks

| Incident                           | Immediate response                                                               | Recovery condition                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| RPC unavailable or inconsistent    | Mark observations stale; pause affected new commitments/transactions as needed.  | Reconciled authoritative state with lag inside the chosen target.      |
| Payment submission timed out       | Keep status unknown/pending; inspect existing operation and signature.           | Verified outcome or proven safe retry with the same semantic ID.       |
| Vault/accounting discrepancy       | Stop unsafe new allocations; preserve records and notify finance/security owner. | Explained reconciliation with auditable repair; no fabricated balance. |
| Contributor lacks required access  | Pause effective work start; notify Founder; start bounded setup incident.        | Correct access or operational closure with compensation path.          |
| Access removal fails               | Revoke task secrets, retry provider reconciliation, alert access owner.          | Actual effective access matches authorized desired state.              |
| Review abandoned                   | Send notice, escalate, apply finite operational deadline.                        | Review/consented extension or closed work with claims preserved.       |
| AI run loses heartbeat             | Stop further budget dispatch, inspect actual external effects.                   | Safe resume or terminal run/engagement handling.                       |
| Promotion not delivered            | Stop further erroneous charging; preserve paid reservation.                      | Delivered replacement or authorized refund under purchased terms.      |
| Account compromise                 | Revoke credentials, contain new actions, preserve claims/evidence.               | Account recovery and safe authorization restoration.                   |
| Program/provider security incident | Apply predesigned pause/containment controls and user status.                    | Reviewed recovery route; never assume code rollback undoes transfers.  |

### 30.5 Backups and restore

Back up the database, immutable terms, submissions/evidence, essential object metadata, and configuration/authority references under the selected retention policy. Keep secrets under an appropriate key backup/recovery process without printing them in runbooks.

Test restoring to an isolated environment. Reconciliation after restore must recognize external effects that happened after the backup, avoiding replayed payouts, duplicate posts, restored expired access, or reused claim IDs.

Distinguish rebuildable projections from authoritative records supporting acknowledged commitments/external effects. Accepted terms and consents, canonical engagement/capacity mappings, payment/access authorizations, semantic operation IDs, and referenced immutable artifacts need a recoverable durable copy outside the primary failure domain before the related commitment is acknowledged or effect dispatched.

Choose and test the durability mechanism against the deployment's declared failure model, such as appropriately replicated transactional logs plus durable immutable object storage. An outbox inside the same lost database is not itself disaster recovery. During restore, establish an authoritative recovery watermark and reconcile later external effects before enabling affected commands. If an agreement/authorization cannot be recovered, keep affected actions disabled and escalate; a transfer or grant is not proof of missing consent.

**DEFAULT planning targets:** recovery point within 15 minutes only for data whose loss/reconstruction is explicitly acceptable, and service recovery within four hours for the initial supported pilot. The 15-minute target does not permit losing acknowledged work, money, or access authorizations. Validate the infrastructure and failure model before promising targets; these are not current service commitments.

### 30.6 Deployment and rollback

Use versioned builds, reviewed migrations, staged rollout, health checks, and a clear rollback owner. Separate reversible UI/API rollback from database/data migration and on-chain program upgrade procedures.

Prefer additive schema changes with explicit backfills and verification. Never edit applied migrations to hide drift. Program upgrades, authority changes, and migrations of funds require their independently authorized procedures. No agent may represent a test deploy as a security audit.

---

## 31. Metrics

### 31.1 Product success

The useful loop is a legitimate project commissioning useful work that is completed and settled under clear terms. Measure that loop directly rather than treating raw wallet count or token trading volume as proof of work-market success.

| Metric                       | Definition/interpretation                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Guild activation             | Verified project/Guild reaches its first valid funded work offering.                         |
| Launch conversion            | Draft launch intents that reach verified required launch state.                              |
| First-Raid completion        | Newly activated Guild reaches an accepted commissioned outcome.                              |
| Settlement completion        | Due obligations finalized, by asset and time to settlement.                                  |
| Raider activation            | New participant accepts a suitable first engagement.                                         |
| Time to first useful outcome | Time from onboarding/creation to an accepted work result.                                    |
| Matching time                | Time from funded open slot to accepted, activated engagement.                                |
| Repeat Guilds/contributors   | Distinct entities returning for another valid engagement.                                    |
| Review delay                 | Time from submission to substantive decision, excluding documented pauses.                   |
| Dispute burden               | Open/resolved cases by category and attributable finding.                                    |
| Private-access reliability   | Grants/revocations reaching their intended verified state on time.                           |
| AI task economics            | Actual attributable execution cost, revenue, success, and rework by evaluated configuration. |
| Promotion delivery           | Purchased inventory actually delivered; separately measured clicks/outcomes.                 |

### 31.2 Reporting integrity

Distinguish drafted, funded, accepted, submitted, work-accepted, and paid volumes. Keep Challenge qualification/wins separate from commissioned completion. Exclude test fixtures, internal/self-dealing demonstrations, duplicates, and known abusive outcomes from public success claims under a documented policy.

Report token quantities by asset. Dollar-value reporting requires a source, valuation timestamp, methodology, and missing-price behavior. Do not silently value an illiquid project token at a founder-entered number and aggregate it as paid dollars.

### 31.3 Quality and fairness checks

Inspect whether newcomers can find appropriate work, whether experienced entrants can prove skills, whether a small number of Guilds dominates opportunities, whether review delays burden Raiders, and whether false-positive restrictions cluster around shared networks or new wallets.

Collect feedback at natural milestones. Survey answers are not forced positive ratings. Analytics events use pseudonymous IDs and the chosen consent/retention policy; no private code or full brief text is needed for conversion metrics.

---

## 32. Testing strategy

### 32.1 Test what can fail materially

Prioritize financial correctness, identity/permission boundaries, concurrency, external-effect recovery, and the end-to-end user journey. Avoid large suites that only repeat implementation details or count UI elements.

| Test level           | What it proves                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Domain/unit          | Amount parsing, policy predicates, valid/invalid transitions, per-asset allocation, deadline/version rules.    |
| Database integration | Uniqueness, locking, atomic Party/operator reservations, state/audit/outbox consistency.                       |
| Adapter contract     | Real provider request/response semantics using controlled fixtures and recorded schemas.                       |
| Program/integration  | Signer/account validation, funds conservation, commitment/refund race, replay, claimability, supported assets. |
| End-to-end           | User can launch/verify Guild, fund, match, work, review, claim, and inspect history.                           |
| Security/adversarial | Cross-Guild access, forged events, guessed IDs, malicious code, prompt injection, secret handling.             |
| Recovery             | Crash after external success, missing webhook, stale generation, restore/replay, provider outage.              |
| Accessibility        | Keyboard/focus, semantic forms, non-color cues, reflow, errors and status announcements.                       |

### 32.2 Real concurrency tests

Use a real transactional test database. Synchronize two or more accept requests so they compete at the constraint boundary. Assert one canonical success, no leftover partial Party/operator reservations, no double-filled slot, and exactly one audit/outbox business effect.

A mocked repository that always returns “not busy” does not test the one-active rule. An application mutex inside one process does not prove behavior across worker/web instances.

### 32.3 Financial property tests

Generate bounded combinations of exact amounts, splits, fees, deposits, accepted obligations, partial decisions, claims, and refunds. Check per-asset conservation, nonnegative allocations, protected reserves, no repeated consumption, and deterministic rounding.

Use adversarial mints/program IDs, decimals, account owners, already-claimed receipts, expired signatures, and token restrictions. Unknown transaction status must remain unknown until evidence resolves it.

### 32.4 Fixture design

Create synthetic identities and assets unmistakably labeled test-only:

- Beginner with orientation but no verified skill.
- Experienced developer with verified frontend skill and no Guild relationship.
- Trusted Guild contributor with one active engagement.
- High-balance low-skill account.
- Two Parties sharing one member.
- Two registered agents under one operator.
- New Guild with no history, reliable Guild, and Guild with an unresolved case.
- Two test assets sharing a symbol but using different mints.
- Multi-asset reward with one funded leg and one missing leg.
- Valid nonwinning Challenge entry.
- Existing independent repository access plus two overlapping task grants.
- Mock providers for late binding, failed revocation, duplicate callback, interrupted payout, and malicious instructions.

Fixtures must never be used as real public reputation, funded assets, genuine traffic, or completed customer work.

### 32.5 Release evidence

Every release cites the tests/scenarios executed, their environment, the actual result, and unresolved findings. A devnet success supports that tested path, not a blanket mainnet safety claim. Security review and relevant program assurance have their own owner and scope.

Once the agreed risks/gates are verified, stop optional testing and move toward delivery. Expand testing only for a concrete uncovered risk or required gate.

---

## 33. Agent work contracts

### 33.1 Shared operating agreement

These are roles for **development agents building RAID**. One agent may cover several roles, or multiple agents may share a role with explicit ownership. The names do not imply ten runtime services or ten paid product Raiders.

Each agent receives a bounded task with required reading, owned files/modules, dependent contracts, requirement IDs, acceptance scenarios, known OPEN decisions, and a completion report format. Before changing a shared schema, coordinate the contract with its owner. Work in isolated branches/worktrees where available; preserve concurrent user/agent edits and integrate deliberately.

Do not rewrite another agent's contract by silently changing an enum, amount shape, permission name, or state definition. Propose a versioned change and update consumers/tests together. Security and economic questions do not disappear because another agent is implementing a different layer.

### 33.2 Agent roster

| Agent                              | Owns                                                                               | Required reading                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| AG01 Product and orchestration     | Decisions, scope, task dependencies, integration.                                  | 00–05, 13, 34–40.                                              |
| AG02 Frontend and experience       | Navigation, screens, interactions, accessibility.                                  | 03–12, 15, 18, 23, 26, 35–36.                                  |
| AG03 Backend and domain            | Work/identity, Party/Challenge lifecycle and handoff, policies, APIs, persistence. | 06–17, 24–29, 35.                                              |
| AG04 Solana and treasury           | Launch adapter, funding, program/settlement, reconciliation.                       | 05, 13, 15–17, 22, 25–30, 35.                                  |
| AG05 Trust and private access      | Skill proof, reputation, Guild Trust, grants, abuse review.                        | 07–10, 13–17, 25, 28–29, 35.                                   |
| AG06 AI execution                  | Registered worker runtime, routing, budgets, tools.                                | 00, 07–08, 13–14, 19–20, 24–30, 35.                            |
| AG07 Discovery and distribution    | Feed, sponsorship, influencer/channel adapters.                                    | 18, 20, 22–29, 31, 35.                                         |
| AG08 QA and security               | Independent scenario evidence and adversarial review.                              | 02, 10, 12–17, 19, 25–28, 30, 32, 35.                          |
| AG09 Operations and release        | Environments, workers, recovery, observability, deployment.                        | 16–17, 24–30, 32, 34–35, 38–40.                                |
| AG10 Documentation and integration | Contract consistency, decision/progress records, agent onboarding.                 | Entire glossary/decision register; affected domains and 33–41. |

All agents additionally read 00–04 and the one-active rule in 13. Required-reading references do not authorize ignoring adjacent rules affected by a task.

### 33.3 AG01 — Product and orchestration

**Mission:** Preserve one coherent launchpad-to-work product while making implementation tasks concrete.

**Deliver:** Requirement traceability, milestone scope, dependency order, decision records, interface ownership, and integration review. Identify which numbers are examples and which policies are defaults. Keep the launch milestone visible even when a work pilot ships first.

**Coordinate:** Assign only independent tasks in parallel; serialize shared schema/contract changes and integration. Ask for missing business decisions only when they block a dependent action, after preparing options and independent work.

**Boundary:** Cannot choose mainnet economics, authorize funds, or remove the one-active rule for convenience.

**Done:** Every task has an owner, acceptance evidence, and a clear relationship to the current release. Material unresolved decisions are explicit.

### 33.4 AG02 — Frontend and experience

**Mission:** Make work discovery, commitment, progress, money, and permissions understandable.

**Deliver:** Accessible components; launch/Guild screens; feed; create-Raid wizard; onboarding/profile; applicant review; workspace; Party/Challenge screens; payment/dispute states; responsive layouts. Use the canonical terms and server-derived capabilities.

**Verify:** Full reward bundle shown, Sponsored labels preserved, busy state clear, stale funding honest, confidential payload absent, errors actionable, keyboard/mobile flows complete. Present transaction intent before opening a wallet.

**Boundary:** UI cannot create authoritative eligibility, finality, paid status, rank verification, or access by setting client state.

**Done:** The release's end-to-end journeys work against actual contracts, including loading, error, empty, rejected, expired, pending, and partially completed states.

### 33.5 AG03 — Backend and domain

**Mission:** Make rules hold under malicious clients, concurrent requests, retries, and external delays.

**Deliver:** Canonical identity links; scoped authorization; immutable terms; separate listing/offer/engagement states; Party and Challenge lifecycle, entry admission, judging orchestration, award proposals and main-Raid handoff; atomic participant/operator reservations; structured submissions/reviews; idempotent commands; audit/outbox/inbox; domain APIs. Treasury owns financial allocation, AG05 owns evaluation/access policy, and AG02 owns the screens.

**Verify:** Conflicting accepts and Party handoffs roll back cleanly; stale work cannot restart; duplicate events cannot produce new claims/reputation; private data has separate DTOs; financial state comes from Treasury evidence.

**Boundary:** Cannot declare funds available from a client signature or make an ORM edit equivalent to on-chain settlement.

**Done:** Database-backed acceptance/replay/access tests pass and all commands expose documented reason codes with their intended authority.

### 33.6 AG04 — Solana and treasury

**Mission:** Implement the selected launch and payment mechanism with exact accounting and explicit authority.

**Deliver:** Verified asset/provider registry; launch and escrow intents; signer/account checks; commitment, reserve, allocation, claim/refund behavior; semantic operation replay protection; transaction status verification; ledger reconciliation; program authority documentation.

**Verify:** Same-symbol mints cannot substitute, reward legs cannot share the same reserve, late binding is recoverable, commitment/refund and hold/claim races are safe, policy version does not split asset identity, and partial transfers remain visible.

**Boundary:** Does not choose token supply/fees/custody authority from examples. No user seeds in application code or agent context; no mainnet readiness claims from mocks.

**Done:** Adopted mechanics pass their adversarial tests in the selected environment, with all real-fund release gates and unresolved provider capabilities recorded.

### 33.7 AG05 — Trust and private access

**Mission:** Make capability, reliability, relationship, and permission useful without conflating them.

**Deliver:** Skill catalog and assessments; novice/experienced onboarding; trial rubrics; attributable reputation events; Guild reputation and relationships; appeals/restrictions; explicit resource grants; accurate effective-access reconciliation.

**Verify:** Token wealth and community task volume do not buy technical rank; valid nonwinning entries do not lower reliability; shared IP is not a fraud conviction; private access requires a real grant; revoked task access cannot erase a later or pre-existing entitlement.

**Boundary:** Cannot promise idea protection, infer identity from balances, or treat GitHub branch rules as read isolation.

**Done:** Eligibility explanations, evidence history, denial cases, corrections, and grant/revocation outcomes match the documented policies.

### 33.8 AG06 — AI execution

**Mission:** Run accountable AI workers within the agreed task, tool, data, and spend boundaries.

**Deliver:** Operator registry, evaluated configuration versions, routing proposals, task-scoped capability manifests, isolation, budget reservation/metering, cancellation/recovery, authenticated result intake, and traceable artifacts.

**Verify:** Budget cap survives retries/subcalls, cancellation does not hide an already-issued write, prompt injection cannot expand access, external callbacks cannot impersonate another worker, and model price/configuration does not automatically change rank.

**Boundary:** Cannot use the development assistant's credentials, approve its own reward, access a treasury key, or publish without the adopted action authorization.

**Done:** A bounded task runs, produces inspectable evidence, respects stop/permission limits, and enters ordinary review with costs and failures honestly recorded.

### 33.9 AG07 — Discovery and distribution

**Mission:** Help projects and work be discovered while keeping paid visibility and actual credibility distinct.

**Deliver:** Safe feed projection, filters/sorts, funded and eligible labels, fixed sponsorship, later bid reservation/award/delivery, and staged influencer evidence/publication adapters.

**Verify:** No private data in search, no fake traffic, no bid double charge, no paid rank changes, no repeat publication on retry, and closed work follows purchased placement terms.

**Boundary:** Cannot invent cross-asset prices, guaranteed reach, channel permissions, organic endorsement, or speculative token-value claims.

**Done:** Purchased inventory is reconcilable, organic results stay separate, and content/publication authority is clear.

### 33.10 AG08 — QA and security

**Mission:** Independently verify the critical outcomes and failure boundaries.

**Deliver:** Scenario matrix, reproducible fixtures, actual concurrency/program/recovery tests, confidentiality checks, accessibility evidence, and severity-ranked findings.

**Verify:** The complete release journey and the negative cases in section 35. Test legitimate users as well as malicious behavior; do not “fix” abuse by making all newcomer work impossible.

**Boundary:** Automated coverage is not an external audit. Do not manufacture passing output, test with unauthorized live funds, or approve an unresolved architecture by labeling it out of scope when it is required for that release.

**Done:** Required scenarios have actual results, failures have reproductions/owners, and the release decision is supported by the right evidence.

### 33.11 AG09 — Operations and release

**Mission:** Make the system supportable and recoverable after it leaves a developer's machine.

**Deliver:** Environment validation, scoped secrets, durable workers, monitoring, backup/restore verification, incident/mediation queues, deployment gates, migration plans, and runbooks.

**Verify:** Stale providers do not cause destructive inference; late jobs reconcile safely; rollback scope is honest; outage restores do not replay payments/posts or revive old grants; deadline handling has a responsible operator.

**Boundary:** A feature flag cannot undo a program instruction or grant arbitrary fund authority. Production deployment follows the user's/project's actual authorization, not this document alone.

**Done:** Operators can detect, investigate, contain, and resolve the defined incidents with an audit trail and truthful user status.

### 33.12 AG10 — Documentation and integration

**Mission:** Keep the blueprint, implementation, API schema, and agent handoffs consistent.

**Deliver:** Decision records, current implementation status, exact build/test instructions from the real repository, generated contract references, release notes, and a concise next-agent handoff.

**Verify:** No stale enum names, contradictory defaults, unmarked illustrative numbers, claimed unimplemented features, or missing dependent release gates. Check examples against canonical contracts.

**Boundary:** Cannot silently rewrite product requirements to match an incomplete implementation. Record a gap or propose a reviewed change.

**Done:** A fresh agent can identify what exists, what is next, how to verify it, and what must remain disabled.

---

## 34. Build sequence

### 34.1 Delivery principle

Build in dependency order, proving one usable vertical slice before adding complex automation. This is a proposed delivery sequence, not a claim that the user approved exact sprint durations or that every feature must launch on the same day.

| Milestone                     | Scope                                                                                                                                             | Depends on                                                          | Exit evidence                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| M0 — Contract and foundation  | Repository inspection, decision register, shared types, schema conventions, state ownership, test fixtures.                                       | This blueprint and actual repo facts.                               | Agents use one contract; OPEN production decisions have owners; no fake implementation status.                    |
| M1 — Identity and Guild       | Authentication, canonical Raider, wallet links, draft/verified Guild, roles, basic profiles and public discovery.                                 | M0.                                                                 | Wallet changes preserve identity; holder eligibility cannot grant admin access.                                   |
| M2 — Work lifecycle           | Draft/recommendation rubric, published safe cards, applications/offers, atomic capacity, terms, submission/review/deadlines with simulated funds. | M1.                                                                 | Complete synthetic work loop and real database race tests; simulation unmistakable.                               |
| M3 — Launch integration       | Selected protocol/provider adapter, review/sign flow, verification, Guild token linkage, recovery.                                                | Launch protocol decision; M1.                                       | Supported launch creates/verifies the intended artifact on the test network with accurate state.                  |
| M4 — Funding and settlement   | Chosen escrow, assets, reserves, binding, finality, claims/refunds, dispute authority, reconciliation.                                            | Authority/asset/finality decisions; M2.                             | Program/provider and backend agree across funding, replay, race, partial payout and timeout cases.                |
| M5 — Controlled first release | Public human Raids, manual relevant assessments/review, honest reputation metrics, launchpad flow, monitoring/support.                            | M1–M4 and relevant release gates.                                   | Real supported end-to-end operation under the approved operating model; no unsafe shortcuts.                      |
| M6 — Trust and team execution | Private briefs/code grants, Party consents/splits, paid selection Challenges, fixed sponsored placements.                                         | M5 plus access/judging/payment policies.                            | Scoped grants/revocation and Challenge handoffs pass; placement delivery/refunds reconcile.                       |
| M7 — Managed intelligence     | Evaluated AI workers, operator caps, isolated runtime, bounded spend, improved recommendations.                                                   | M5–M6 relevant contracts and runtime/provider decisions.            | One permitted task runs under limits and reaches ordinary verification; prompt-injection/cancellation tests pass. |
| M8 — Advanced Guild economy   | Prize competitions, bid placement, approved automated influencer channels, sophisticated scoring, ongoing Roles.                                  | Corresponding policy, financial, integration and operational gates. | Each feature's meaningful negative/recovery cases pass before enablement.                                         |

M3 and parts of M2/M4 can proceed in parallel once the shared identity/contract decisions are stable. M6 subfeatures can also be staged independently. Do not block reversible product/UI work on an unrelated tokenomics decision.

### 34.2 Version labels

Use `Prototype/Pilot` for M0–M4 until all relevant live dependencies exist. A proposed `V1` is M5, `V1.5` is M6, and `V2` combines selected M7–M8 capabilities. Version names are planning labels, not permission to claim incomplete launch or payment support.

### 34.3 First implementation assignment

The first coding agent should inspect the real repository and produce a short implementation inventory. If no repo exists, scaffold the chosen web/worker/contracts/database structure and implement the canonical participant, Guild, terms, engagement, and capacity slice with realistic synthetic fixtures.

The first risky behavior to prove is simultaneous acceptance under real database constraints. The first user flow to prove is a public Guild posting a clear task that a newcomer or assessed Raider can understand, commit to once, submit, and have reviewed. Money can be explicitly simulated only until the actual payment milestone is complete.

### 34.4 Required production gates

| Gate                         | Evidence needed                                                                                        | Affected features                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| G01 — Launch route           | Approved protocol, parameters, verified IDs, authority/fee behavior, recovery.                         | Real launches/trading.                                                                           |
| G02 — Custody and settlement | Defined authority, program/provider capability, reserves/claims/refunds, recovery, relevant assurance. | Real reward funding and payouts.                                                                 |
| G03 — Financial finality     | Notice, ordinary acceptance finality, objection/appeal, final decision, hold/claim race behavior.      | All live settlement claimability, including ordinary acceptance, disputes, and Challenge awards. |
| G04 — Supported assets       | Exact registry, decimals/program checks, extension policy, complete tested paths.                      | Each added payment asset.                                                                        |
| G05 — Operating terms        | Supported jurisdictions/users, rights, fees, dispute operator and service scope.                       | Public paid launch/work operations.                                                              |
| G06 — Private resources      | Real authorization, effective provider grants, isolation, revocation and incident handling.            | Confidential Raids and private trials.                                                           |
| G07 — Managed execution      | Operator identity, sandbox, tool authority, spend controls, provider data policy.                      | Managed AI workers.                                                                              |
| G08 — External publication   | Account control, current API capability, content approval, retry/takedown/metrics rules.               | Automated influencer posting.                                                                    |
| G09 — Promotions             | Funded inventory/bids, charge/delivery/refund reconciliation.                                          | Paid placements and auctions.                                                                    |
| G10 — Operations             | Monitoring, staffed case ownership, backups/restore, release/incident playbooks.                       | Any supported live release.                                                                      |

Gates apply to their dependent feature. An unresolved prize-auction policy does not prevent a public profile screen from being completed. An unresolved escrow authority does prevent presenting a prototype as safely holding live rewards.

---

## 35. Acceptance scenarios

### 35.1 Identity, skills, and trust

| ID   | Scenario                                                                         | Required result                                                                    |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| AC01 | User connects a second wallet while holding an active Raid.                      | Same canonical participant, same history and capacity.                             |
| AC02 | Reuse a wallet-login nonce or change its domain.                                 | Authentication fails; no duplicate session/link.                                   |
| AC03 | New user completes orientation with no verified skill.                           | Can find explicit starter tasks; no fabricated verified rank.                      |
| AC04 | E-ranked participant buys a large RAID balance.                                  | Skill rank and high-rank eligibility do not change.                                |
| AC05 | A-ranked frontend developer applies for B-ranked Solana work without that skill. | Required skill fails with an actionable explanation.                               |
| AC06 | Experienced newcomer passes a relevant advanced assessment.                      | Relevant skill can qualify quickly; Guild Trust/private access are still separate. |
| AC07 | Token holder attempts Guild administration or private download.                  | Denied unless separately granted.                                                  |
| AC08 | RPC outage prevents refreshing holder balance.                                   | Membership observation becomes stale/unknown; no destructive inference.            |
| AC09 | Related accounts farm reciprocal easy tasks.                                     | Suspect events flagged under review policy; no automatic high technical rank.      |
| AC10 | Dispute finding is reversed on appeal.                                           | Attributable reputation correction without erased evidence/history.                |

### 35.2 Capacity and work lifecycle

| ID   | Scenario                                                                         | Required result                                                                  |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| AC11 | Same Raider accepts two different Raids concurrently.                            | Exactly one commitment; other request conflicts.                                 |
| AC12 | Two applicants accept the same available slot.                                   | Exactly one selected engagement and one funded binding.                          |
| AC13 | A Party contains one busy member.                                                | Entire Party commitment rolls back; no orphan engagement or partial reservation. |
| AC14 | Normal acceptance races with Challenge acceptance.                               | One active engagement across both entry paths.                                   |
| AC15 | Two registered agents under one capacity-limited operator accept different work. | Operator transaction permits only one engagement.                                |
| AC16 | Human and AI members under one operator join the same allowed Party.             | Individual commitments coexist under one same-engagement operator reservation.   |
| AC17 | An offer was generated while available, but the Raider later became busy.        | Offer acceptance fails current capacity checks.                                  |
| AC18 | Public paid work has no private resources but binding is pending.                | Remains in setup; cannot start commissioned work.                                |
| AC19 | Worker submits and review/revision duty remains.                                 | Active slot stays held until bounded operational closure.                        |
| AC20 | Work is accepted but its payment is still pending.                               | Capacity is released; unpaid claim remains visible.                              |
| AC21 | Reviewer never responds, or worker never submits.                                | Deadline process reaches finite closure; money/fault is not decided by silence.  |
| AC22 | Terminal work is reopened while the Raider has new work.                         | No silent reactivation; new consent/capacity required.                           |
| AC23 | A delayed closure job arrives after the Raider starts another job.               | Cannot release the newer commitment.                                             |
| AC24 | Five application targets close or offers expire.                                 | Old applications no longer consume the cap; new applications possible.           |
| AC25 | A withdrawn worker is replaced.                                                  | New slot/terms/reservation; original history and protected claims remain intact. |

### 35.3 Money and chain

| ID   | Scenario                                                                      | Required result                                                       |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| AC26 | Client supplies unrelated successful transaction signature.                   | No funding credit without the correct program/vault/asset/effect.     |
| AC27 | RPC accepts a transaction but it never finalizes.                             | No verified-funded/paid label; status remains accurate.               |
| AC28 | Reward promises two assets; only one is deposited.                            | Full reward is not eligible for commitment.                           |
| AC29 | Two mints share a ticker, or same mint address is presented on wrong network. | Identity validation rejects substitution.                             |
| AC30 | Asset policy version changes for the same underlying asset.                   | Existing balance is not duplicated or split into spendable new funds. |
| AC31 | Founder refunds while work binding is racing.                                 | Program serializes outcomes; if refund wins, no work/access starts.   |
| AC32 | Funding/claim webhook is delivered repeatedly.                                | One ledger/business outcome.                                          |
| AC33 | Payout times out after success and is rebuilt with a new signature.           | Same semantic claim cannot pay again.                                 |
| AC34 | A shared pool funds several slots.                                            | Each reservation protected; no deposit promised twice.                |
| AC35 | Work is committed but not yet reviewed/allocated.                             | Founder cannot treat its reserve as refundable uncommitted cash.      |
| AC36 | Some Party/asset claims settle and another fails.                             | Correct partial status; only unpaid claims retried.                   |
| AC37 | Token transfer becomes frozen after funding.                                  | Obligation remains; blocked availability incident; no silent haircut. |
| AC38 | Appeal arrives at claimability boundary.                                      | Hold/finality/claim serialize under policy; no contradictory spend.   |
| AC39 | Operational work closes while a signed binding later finalizes.               | Late-binding recovery; no reopened work or automatic code grant.      |
| AC40 | Unauthorized actor changes payout address or settlement beneficiaries.        | Rejected; proof and permitted beneficiary process required.           |
| AC41 | Mainnet config contains test asset/program or mock provider.                  | Production action blocked at validation.                              |

### 35.4 Privacy and code

| ID   | Scenario                                                                     | Required result                                                                       |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| AC42 | Visitor inspects private-Raid HTML, API data, search, metadata or preview.   | Only approved teaser; no private bytes.                                               |
| AC43 | High-rank token holder requests a repo without approval.                     | No automatic grant.                                                                   |
| AC44 | Founder grants one repository expecting folder secrecy.                      | UI/config identifies actual scope; approved isolated resource required.               |
| AC45 | Source Challenge grant is revoked after main-Raid grant starts on same repo. | Effective reconciliation preserves the new valid access.                              |
| AC46 | Contributor had independent repository rights before the Raid.               | Removing RAID grant does not claim all access disappeared or delete unrelated rights. |
| AC47 | Provider revocation fails or old grant job arrives late.                     | Incident/retry; stale grant cannot revive undesired access.                           |
| AC48 | Submission includes a malicious build script, URL, or prompt instruction.    | Isolation/input policy prevents unauthorized data or tool access.                     |
| AC49 | Account is restricted with an unsettled claim.                               | Safe access to financial status and dispute evidence remains under policy.            |

### 35.5 Challenges, Parties, sponsorship, and AI

| ID   | Scenario                                                            | Required result                                                                   |
| ---- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AC50 | Party leader changes accepted split without other members.          | Amendment rejected until affected consents and valid funding.                     |
| AC51 | Valid Challenge entry does not win.                                 | Qualification/participation preserved; no automatic reliability failure.          |
| AC52 | Founder changes judging weights after commitments.                  | Rejected without accepted amendment.                                              |
| AC53 | Four guaranteed prototype payments plus a prize are promised.       | Maximum qualifying liability funded before commitments.                           |
| AC54 | Selected Challenge builder declines main Raid.                      | No main engagement, no penalty merely for declining, selection payment preserved. |
| AC55 | Selection-to-main handoff races with another offer or operator job. | One atomic capacity outcome; no double reservation.                               |
| AC56 | Main-Raid binding fails after handoff.                              | Target closes under recovery; source compensation/history remain intact.          |
| AC57 | Guild wants to use a nonwinner's private code.                      | Requires rights already granted or a separate authorized agreement.               |
| AC58 | Founder buys sponsored placement.                                   | Clear Sponsored label; no skill/reputation/judging boost.                         |
| AC59 | Bid loses or purchased placement cannot be delivered.               | Funds/reservations follow published release/refund/make-good rules.               |
| AC60 | Social publish request times out after provider success.            | Lookup/deduplication prevents duplicate publication.                              |
| AC61 | AI reaches total budget across retries/subagents.                   | Further spend blocked; no autonomous budget expansion.                            |
| AC62 | AI tries to approve its own output or withdraw reward.              | Permission denied; ordinary authorized review required.                           |
| AC63 | Agent changes model/version to evade failure history/capacity.      | Canonical identity/commitment retained; evaluation policy applies.                |
| AC64 | Failed/cancelled AI run leaves an active engagement.                | Bounded recovery or operational closure; no indefinite slot lock.                 |
| AC65 | Role title is used to hide an ongoing second job.                   | Active duty is modeled and rejected if it violates capacity.                      |

### 35.6 End-to-end and recovery

| ID   | Scenario                                                                                                                                                                | Required result                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC66 | Founder launches a new project through the selected route, verifies its resulting mint, activates the Guild, funds a public Raid, and a Raider completes and claims it. | Verified launch artifacts and Guild linkage, correct accepted contract and funded binding, work outcome, verified transfer and attributable reputation evidence.                                                          |
| AC67 | Process crashes after external success but before local receipt.                                                                                                        | Reconciliation records existing effect; no duplicate action.                                                                                                                                                              |
| AC68 | Restore after losing records newer than the last snapshot, including a new accepted engagement and completed external effect.                                           | Recover original terms, consents, semantic IDs and capacity from approved durability; reconcile before writes. If recovery fails, affected operations stay safely unavailable. No repeated effects or revived old grants. |
| AC69 | Same idempotency key is reused with a different payload.                                                                                                                | Explicit conflict; cannot overwrite original command result.                                                                                                                                                              |
| AC70 | Keyboard/mobile user completes the core flow with wallet rejection and retry.                                                                                           | Draft preserved, clear focus/error/status, no duplicate engagement or funding intent.                                                                                                                                     |
| AC71 | Authorized representative links an existing project/token and completes the supported funded-work flow.                                                                 | Project authority and canonical token verified; labeled existing-project onboarding and not counted as a new token launch.                                                                                                |
| AC72 | Founder/admin changes ordinary Raid reward, scope, deadline or global defaults after acceptance.                                                                        | Original accepted version stays effective. Material amendment needs affected consent, required additional funding and a new audited version; unilateral overwrite is rejected.                                            |
| AC73 | Replace a selected integration adapter with a contract-compatible alternate while work and external operations exist.                                                   | Same domain outcomes and typed errors; capability gaps fail closed; accepted asset/terms/authority and in-flight semantic operation/provider bindings remain intact; no duplicate effect.                                 |
| AC74 | Consume a delivered module in an independent minimal host using its published interface and documentation.                                                              | Example and contract tests run with explicit config/dependencies; no hidden RAID app state, global credentials or undeclared import; permissions, exact amounts, lifecycle and failure behavior remain enforced.          |
| AC75 | Submit implementation completion with missing failing-test-first, passing test, regression or independent criterion evidence.                                           | Completion validation rejects the packet; missing/unexecuted evidence is not a PASS, and self-approval cannot satisfy independent review.                                                                                 |

---

## 36. Worked examples

All amounts, identities, dates, and scores in this section are synthetic. They illustrate the contract; they do not set live pricing, tokenomics, or benchmark results.

### 36.1 Beginner completes a first public Raid

A new person creates an account, completes orientation, and has no verified development skill. A Guild posts an E-rank onboarding feedback Raid with no verified-skill prerequisite and a 10-unit supported stablecoin reward.

The reward is verified and reserved for its slot. The person reviews the acceptance checklist and accepts. The database reserves their one slot, then the selected escrow binding is verified. They test the public flow and submit reproducible evidence. The Founder accepts the result. Work closes, their slot becomes free, and the claim proceeds through the agreed settlement policy.

Their history now shows one accepted feedback task. They do not become a C-rank developer because they completed feedback work. No RAID purchase was required under the baseline license policy.

### 36.2 Experienced developer joins a confidential Guild task

A developer demonstrates A-level frontend capability through relevant reviewed evidence and a trial. They have little history with the new Guild. The Guild has a confidential frontend integration Raid.

The developer applies. The Founder approves a limited private scoping brief so they can understand the job before consenting. After exact terms and funding are verified, acceptance reserves capacity. Binding and resource readiness are checked, then the developer receives a sanitized frontend repository and temporary staging credentials.

The developer submits a PR and tests. Authorized review accepts the specified version. Work closes, claims settle, and access reconciliation removes task-derived permissions while preserving any separately valid rights. Their skill evidence, reliability event, and Guild relationship each update for their own reason.

### 36.3 Selection Challenge chooses a Party

A Guild needs a larger dashboard implementation. It invites three qualified Parties to a bounded paid prototype exercise, promising 150 stablecoin units to each qualifying submission. It separately plans a 2,000-unit main Raid.

The selection pool reserves up to 450 units. Each accepted Party consumes its members' slots. Judging uses a frozen rubric. Two Parties qualify, one is selected, and both qualifying Parties receive the promised selection obligation regardless of selection.

Before the winner accepts the main Raid, its 2,000-unit reward must be funded and its full implementation terms agreed. The handoff atomically transfers the applicable participant/operator commitments or acquires fresh capacity if the selection work already closed. The 450-unit selection budget is never relabeled as main-Raid funding.

### 36.4 Mixed reward with a blocked leg

A Raid promises 300 stablecoin units plus 1,000 project tokens. Both legs are funded. Work is accepted and each beneficiary/asset claim is recorded. The stablecoin leg settles; the relevant project-token account becomes frozen under an issuer freeze authority permitted by the asset's reviewed policy, blocking transfers. This is distinct from the rejected Token-2022 NonTransferable configuration.

The workspace shows the stablecoin as paid and the project-token claim as blocked. It does not show the whole reward paid, convert the token obligation into guessed dollars, erase the claim, or lock the completed Raider out of new work. Operations follows the documented asset incident and recovery process.

### 36.5 Managed AI task reaches its cap

A Founder buys a bounded research execution service with a defined source set, output format, permitted external reads, and a cost cap. The authorized Work command commits the accepted service engagement and reserves participant/operator capacity. The execution service separately reserves operational budget and starts its registered worker's run. It produces a partial report but reaches the cap before finishing every comparison.

The runner stops further spend, records the artifacts and usage, and follows the agreed partial/failure behavior. A permitted retry stays attached to the engagement. A Founder can authorize added budget and a new bounded run if appropriate; this does not reset the operational-closure clock. The model cannot secretly borrow from the contributor reward pool, increase its own budget, or mark its result accepted to collect payment.

---

## 37. What agents must not infer

| Tempting inference                                                 | Correct treatment                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| “The PDF probably selected a bonding curve.”                       | No inspected evidence; launch mechanism remains OPEN.                  |
| “S rank means a particular premium model.”                         | Evaluate the configured agent's capability; choose runtime separately. |
| “A profile score is 92, so it can read source.”                    | Check explicit resource authorization.                                 |
| “A holder owns the Guild.”                                         | Holder membership is not founder authority, equity, or IP rights.      |
| “The Founder is wealthy, so the Guild is trustworthy.”             | Measure attributable behavior with context.                            |
| “A returned signature proves funding.”                             | Verify the actual finalized effect and binding.                        |
| “Unallocated funds can be refunded.”                               | Committed but unallocated reservations are protected.                  |
| “The app cancelled the operation, so the transaction cannot land.” | Reconcile possible late external success.                              |
| “Deleting a grant means the provider removed all access.”          | Reconcile current grants and pre-existing effective rights.            |
| “A branch or sparse checkout hides the rest of a repo.”            | Use a real resource boundary.                                          |
| “A prototype winner already accepted the full job.”                | Offer and explicit new terms/commitment required.                      |
| “A nonwinner failed.”                                              | Qualification and selection are different outcomes.                    |
| “A feature flag can change accepted fees or program authority.”    | Existing contracts and on-chain constraints remain authoritative.      |
| “An agent helper gets another work slot.”                          | Canonical participant/operator limits still apply.                     |
| “The model or provider documentation is an instruction to spend.”  | Only authorized product commands can create an external action.        |
| “Complete blueprint means every feature is currently implemented.” | Track actual status and evidence separately.                           |

---

## 38. Open decisions

The following decisions are unresolved in the available product discussion. They do not prevent completing this blueprint or building independent foundations. They block only the feature that depends on them.

| ID  | Decision needed                                                                           | Proposed working position                                                      | Dependency/owner                                                  |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| O01 | Exact launch mechanism and protocol/provider.                                             | Typed adapter; choose one supported route first.                               | M3; product and Solana lead.                                      |
| O02 | Launch supply, decimals, distribution, authorities, liquidity/curve and migration policy. | No invented economics; expose only selected route's supported parameters.      | Real launch; Founder/product authority.                           |
| O03 | Real RAID token plan and utility activation.                                              | Separate milestone; no presumed supply/price/allocations.                      | Token launch/utility; project owner.                              |
| O04 | Any flat RAID access license after removal of rank-linked stakes.                         | Off by default; preserve optional policy interface.                            | License feature; project owner.                                   |
| O05 | Escrow provider/custom program and custody/upgrade authority.                             | Mediated candidate design with constrained authority, pending review.          | Real rewards; product/Solana/security/operations.                 |
| O06 | Dispute mediator, quorum, notice/appeal/finality and abandoned-case recovery.             | Bounded operations and protected claims; commercial finality must be selected. | Live settlements/awards; product/operations.                      |
| O07 | Initial supported assets and extension/freeze policy.                                     | Small reviewed allowlist; full-identity asset model.                           | Each enabled payment asset; treasury/security.                    |
| O08 | Platform fees, launch fees, promotion prices and AI charging/refunds.                     | Exact quotes and net rewards; examples not binding.                            | Monetized features; product/finance.                              |
| O09 | Numeric skill/score thresholds and calibration.                                           | Qualitative skill rubric, evidence metrics and confidence first.               | Automated scoring/promotion; trust lead.                          |
| O10 | Selection/prize rights, stipend rules, no-qualifier/tie and appeal policy.                | Paid bounded selection first; separate prize mode.                             | Challenge launch; product/legal-template owner.                   |
| O11 | Formal privacy, retention, account deletion and identity-attestation policy.              | Minimal necessary data; no automatic mandatory KYC assumption.                 | Public operations; product/security.                              |
| O12 | Supported jurisdictions/users and contract/service terms.                                 | Resolve for the actual launch/work/payment model.                              | Public paid operations; project owner with appropriate expertise. |
| O13 | GitHub organization/provider plans and supported grant mechanism.                         | Verify actual capability; scoped resource and effective-access reconciliation. | Confidential work; access/integration lead.                       |
| O14 | Model providers, data retention/training permissions, tool providers, price cards.        | Provider-agnostic policy; explicit per-task permission.                        | Managed AI; execution/product lead.                               |
| O15 | Organization AI-operator registration/concurrency policy.                                 | Individual-operator pilot cap as specified; no silent scale-up.                | Broader agent marketplace; product/trust.                         |
| O16 | Social channels and allowed APIs/automation/metrics.                                      | Manual evidence before approved automated publishing.                          | Influencer automation; integration/product.                       |
| O17 | Sponsored auction mechanism and reserve/charge/refund rules.                              | Fixed slots first; first-price candidate remains disabled.                     | Bidding; product/treasury.                                        |
| O18 | Hosting, selected package/runtime versions, provider SLOs and budgets.                    | Simple web/worker/PostgreSQL topology; verify against deployment environment.  | Production release; engineering/operations.                       |
| O19 | Ongoing Role contracts/cadence and operator support hours.                                | One active duty period; no concurrency loophole.                               | Roles and live service; product/operations.                       |

When resolving one item, create a decision record with exact chosen values, rationale, alternatives rejected, owner, date, affected requirements, migration effect, and tests. Update this table to point to that decision. Do not delete the fact that older examples differed.

---

## 39. Definition of done

### 39.1 A feature is complete when

1. It implements the intended user outcome and relevant requirement IDs.
2. Its records, states, transitions, authorization, and external authority are explicit.
3. Failure, retry, cancellation, timeout, and recovery behaviors work where material.
4. Private information stays inside its approved boundary.
5. Financial effects are exact, authorized, idempotent, and reconcilable.
6. Relevant concurrency and adversarial scenarios pass in a meaningful environment.
7. UI states match the actual domain/provider/chain facts.
8. Operational ownership, monitoring, and required gates exist for live use.
9. Documentation and the implementation status record match what actually exists.
10. Any remaining limitation is stated accurately and blocks only its dependent action.
11. Implementation has genuine test-driven RED/GREEN/REFACTOR evidence under I13; non-code acceptance is defined before execution.
12. Applicable integration substitution and independently usable module documentation/examples satisfy R15/R16 and AC73–AC74.

### 39.2 A task handoff is complete when

The next agent can identify the change, why it was needed, files/modules touched, actual verification, unresolved risks, state/schema migration impact, and the next bounded task. A statement such as “backend done” without these facts is not enough.

### 39.3 Whole-product implementation status

This document does not mark RAID implemented. The present deliverable is the specification. At implementation kickoff, initialize a status register by inspecting the actual repository. Use `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED_IN_TEST`, `PILOT_ENABLED`, and `PRODUCTION_ENABLED` with evidence and environment references.

Do not equate prototype screens, mock transactions, code compilation, local tests, deployed staging, or mainnet execution. They prove different things.

---

## 40. Handoff templates

### 40.1 Starter instruction for a new development agent

Copy this instruction into an agent task, alongside this Markdown file and the actual repository:

```text
You are implementing RAID. Read RAID_AGENT_BLUEPRINT.md first.

Required initial reading: sections 00–04 and 13, then the sections for
your assigned role in section 33 and the relevant acceptance scenarios.

Treat LOCKED requirements, DIRECTION, DEFAULT choices, OPEN decisions,
and EXAMPLE data distinctly. Never convert example prices, token thresholds,
model costs, or ranks into approved production policy.

Inspect the actual repository and its instructions before editing.
Use existing shared contracts and identify your bounded milestone.
Preserve one active engagement per canonical Raider, including Party and
Challenge members, and the applicable operator cap.

Keep skill, reputation, Guild Trust, membership, access, work state,
and settlement state separate. Use authorized domain commands and
transactional constraints. No model output can grant authority or pay itself.

Complete the assigned slice and its meaningful verification. Record actual
results, unresolved dependencies, and a concrete next-agent handoff.
Do not claim a feature, integration, audit, or deployment exists without evidence.
```

### 40.2 Bounded task packet

```text
Task ID:
Assigned role:
Milestone:
User outcome:
Requirement/invariant IDs:
Required blueprint sections:
Current repository facts:
Owned files/modules:
Shared contracts and owners:
Dependencies already satisfied:
Open decisions affecting this task:
Permitted implementation defaults:
Acceptance scenario IDs:
Verification environment:
Expected deliverables:
Out-of-scope adjacent work:
```

### 40.3 Completion report

```text
Task ID and status:
Outcome delivered:
Why the change was needed:
Requirement IDs satisfied:
Files/modules changed:
Schema/API/event changes:
Authority/privacy/financial effects:
Verification actually executed:
Observed results:
Known limitations and unresolved gates:
Migration/rollback notes:
Follow-up task and exact next step:
```

### 40.4 Decision record

```text
Decision ID:
Date and owner:
Related OPEN item:
Question:
Chosen policy/values:
Status: proposed | accepted | superseded
Reason and tradeoffs:
Alternatives considered:
Affected requirements/contracts:
Effect on existing accepted work:
Migration or rollout plan:
Required verification:
Supersedes / superseded by:
```

### 40.5 Change-management rule

When the project owner changes a requirement, update the decision register and affected contract/test references together. Preserve the previous version or a clear change record. For an accepted-work change, the application's contract-amendment rules still apply; editing this blueprint cannot retroactively change a contributor's agreed reward.

---

## 41. Sources

### 41.1 Product source

The product requirements come from the supplied conversation, mapped as C01–C12 in section 01. This file does not claim inspection of the earlier referenced PDF or unseen omitted messages. Engineering choices and worked examples are design recommendations, not externally reported facts.

### 41.2 Primary technical references

The following official references were inspected while preparing this blueprint on 6 October 2026. They support the narrow technical facts cited in the document. Recheck current documentation and exact installed/provider versions at implementation time; a documentation URL is not a pinned runtime dependency or a security audit.

| ID  | Primary source                                                                                                                                                                                                                            | Relevant fact or implementation reference                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| S01 | [Solana token, mint, and token-account concepts](https://solana.com/docs/tokens)                                                                                                                                                          | Mints identify tokens; decimals/authorities and ownership accounts matter; an owner can have multiple token accounts for a mint. |
| S02 | [Solana transactions](https://solana.com/docs/core/transactions)                                                                                                                                                                          | Instructions within one transaction succeed together or revert; separate systems/transactions need their own coordination.       |
| S03 | [Solana getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses)                                                                                                                                                      | Transaction status, error, and confirmation observation; historical lookup behavior.                                             |
| S04 | [GitHub repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)                                                | Repository-level permissions and role boundaries.                                                                                |
| S05 | [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)                                                                                            | Controls on branch/tag/push interactions; they are not a folder-confidentiality mechanism.                                       |
| S06 | [Sign In With Solana specification and reference integration](https://github.com/phantom/sign-in-with-solana)                                                                                                                             | Standard signed-message fields and server-side verification. Application replay/expiry policy remains RAID's responsibility.     |
| S07 | [GitHub Actions secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)                                                                                                                                   | Risks of privileged execution and untrusted PR code.                                                                             |
| S08 | [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)                                                                                                                                                | Unique constraints over a selected subset of rows as an alternative capacity enforcement pattern.                                |
| S09 | [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) and [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)                                                    | Transaction/locking semantics and whole-transaction retry requirements.                                                          |
| S10 | [Solana token extensions](https://solana.com/docs/tokens/extensions)                                                                                                                                                                      | Extension-specific behavior and compatibility must be considered.                                                                |
| S11 | [Solana sendTransaction](https://solana.com/docs/rpc/http/sendtransaction)                                                                                                                                                                | RPC submission success does not establish transaction processing/confirmation.                                                   |
| S12 | [Solana transaction confirmation and expiration](https://solana.com/developers/cookbook/transactions/confirmation)                                                                                                                        | Blockhash validity, lastValidBlockHeight, commitment and retry considerations.                                                   |
| S13 | [GitHub individual repository access management](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/managing-an-individuals-access-to-an-organization-repository) | Repository access management; removal does not recall already copied material.                                                   |
| S14 | [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)                                                   | Integration-token scope/lifetime is separate from human collaborator grants.                                                     |
| S15 | [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)                                                                                                                                                                                             | Accessibility criteria used as a proposed implementation target.                                                                 |
| S16 | [Next.js App Router documentation](https://nextjs.org/docs/app)                                                                                                                                                                           | Official reference for the proposed web framework; exact version/hosting is not predetermined.                                   |

### 41.3 Final implementation reminder

RAID's identity is the combination of project launch, useful funded work, demonstrated capability, earned reliability, and explicit trust. Keep those relationships visible in the product and enforce their boundaries in the implementation. Every agent should be able to explain both the happy path and what happens when a person, provider, model, or transaction fails.

**End of blueprint.**
