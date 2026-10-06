# Complete RAID blueprint map

Canonical source: [RAID_AGENT_BLUEPRINT.md](RAID_AGENT_BLUEPRINT.md). This index routes every blueprint domain; it is not a second specification or an implementation-status claim.

Start with sections 00–04 and 13. Then read all sections affected by the task, including related invariants and acceptance scenarios. Map each task to exact requirement/invariant IDs and inspected repository files before implementation.

| Section | Domain | Canonical specification |
|---|---|---|
| 00 | Agent entry point | [Read section 00](RAID_AGENT_BLUEPRINT.md#00-agent-entry-point) |
| 01 | Evidence and authority | [Read section 01](RAID_AGENT_BLUEPRINT.md#01-evidence-and-authority) |
| 02 | Decision register | [Read section 02](RAID_AGENT_BLUEPRINT.md#02-decision-register) |
| 03 | Vocabulary | [Read section 03](RAID_AGENT_BLUEPRINT.md#03-vocabulary) |
| 04 | Product map | [Read section 04](RAID_AGENT_BLUEPRINT.md#04-product-map) |
| 05 | Launchpad | [Read section 05](RAID_AGENT_BLUEPRINT.md#05-launchpad) |
| 06 | Guilds and membership | [Read section 06](RAID_AGENT_BLUEPRINT.md#06-guilds-and-membership) |
| 07 | Identity and onboarding | [Read section 07](RAID_AGENT_BLUEPRINT.md#07-identity-and-onboarding) |
| 08 | Skills and ranks | [Read section 08](RAID_AGENT_BLUEPRINT.md#08-skills-and-ranks) |
| 09 | Reputation and Guild Trust | [Read section 09](RAID_AGENT_BLUEPRINT.md#09-reputation-and-guild-trust) |
| 10 | Visibility and code access | [Read section 10](RAID_AGENT_BLUEPRINT.md#10-visibility-and-code-access) |
| 11 | Creating and recommending a Raid | [Read section 11](RAID_AGENT_BLUEPRINT.md#11-creating-and-recommending-a-raid) |
| 12 | Normal Raid lifecycle | [Read section 12](RAID_AGENT_BLUEPRINT.md#12-normal-raid-lifecycle) |
| 13 | One active Raid | [Read section 13](RAID_AGENT_BLUEPRINT.md#13-one-active-raid) |
| 14 | Parties | [Read section 14](RAID_AGENT_BLUEPRINT.md#14-parties) |
| 15 | Guild Challenges | [Read section 15](RAID_AGENT_BLUEPRINT.md#15-guild-challenges) |
| 16 | Rewards and escrow | [Read section 16](RAID_AGENT_BLUEPRINT.md#16-rewards-and-escrow) |
| 17 | Reviews and disputes | [Read section 17](RAID_AGENT_BLUEPRINT.md#17-reviews-and-disputes) |
| 18 | Feed and sponsored placement | [Read section 18](RAID_AGENT_BLUEPRINT.md#18-feed-and-sponsored-placement) |
| 19 | AI agents | [Read section 19](RAID_AGENT_BLUEPRINT.md#19-ai-agents) |
| 20 | AI influencers | [Read section 20](RAID_AGENT_BLUEPRINT.md#20-ai-influencers) |
| 21 | Ongoing Roles | [Read section 21](RAID_AGENT_BLUEPRINT.md#21-ongoing-roles) |
| 22 | Token economy | [Read section 22](RAID_AGENT_BLUEPRINT.md#22-token-economy) |
| 23 | Screens and user experience | [Read section 23](RAID_AGENT_BLUEPRINT.md#23-screens-and-user-experience) |
| 24 | System architecture | [Read section 24](RAID_AGENT_BLUEPRINT.md#24-system-architecture) |
| 25 | Domain and data model | [Read section 25](RAID_AGENT_BLUEPRINT.md#25-domain-and-data-model) |
| 26 | API contracts | [Read section 26](RAID_AGENT_BLUEPRINT.md#26-api-contracts) |
| 27 | Events and background jobs | [Read section 27](RAID_AGENT_BLUEPRINT.md#27-events-and-background-jobs) |
| 28 | Permissions and security | [Read section 28](RAID_AGENT_BLUEPRINT.md#28-permissions-and-security) |
| 29 | Configuration and administration | [Read section 29](RAID_AGENT_BLUEPRINT.md#29-configuration-and-administration) |
| 30 | Operations and recovery | [Read section 30](RAID_AGENT_BLUEPRINT.md#30-operations-and-recovery) |
| 31 | Metrics | [Read section 31](RAID_AGENT_BLUEPRINT.md#31-metrics) |
| 32 | Testing strategy | [Read section 32](RAID_AGENT_BLUEPRINT.md#32-testing-strategy) |
| 33 | Agent work contracts | [Read section 33](RAID_AGENT_BLUEPRINT.md#33-agent-work-contracts) |
| 34 | Build sequence | [Read section 34](RAID_AGENT_BLUEPRINT.md#34-build-sequence) |
| 35 | Acceptance scenarios | [Read section 35](RAID_AGENT_BLUEPRINT.md#35-acceptance-scenarios) |
| 36 | Worked examples | [Read section 36](RAID_AGENT_BLUEPRINT.md#36-worked-examples) |
| 37 | What agents must not infer | [Read section 37](RAID_AGENT_BLUEPRINT.md#37-what-agents-must-not-infer) |
| 38 | Open decisions | [Read section 38](RAID_AGENT_BLUEPRINT.md#38-open-decisions) |
| 39 | Definition of done | [Read section 39](RAID_AGENT_BLUEPRINT.md#39-definition-of-done) |
| 40 | Handoff templates | [Read section 40](RAID_AGENT_BLUEPRINT.md#40-handoff-templates) |
| 41 | Sources | [Read section 41](RAID_AGENT_BLUEPRINT.md#41-sources) |

For repository mapping, inspect `src/app/` and `src/components/` for user flows; `src/app/api/` and `src/lib/` for commands and services; `prisma/schema.prisma` and `prisma/migrations/` for persisted contracts; `tests/` for behavior evidence; and `docs/` for existing operational and feature documentation. Map actual files to the task rather than assuming the blueprint’s proposed structure already exists.

A completion handoff must identify the outcome, blueprint IDs/sections, files changed, authority/privacy/financial effects, executed verification, unresolved OPEN dependencies, and the next bounded task. Use the status vocabulary in section 39.3 only with supporting evidence.
