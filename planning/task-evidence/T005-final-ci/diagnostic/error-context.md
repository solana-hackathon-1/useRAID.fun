# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: studio.spec.ts >> launch, target attribution, completion, reviewed allocation and manual test payment
- Location: tests/browser-studio/studio.spec.ts:12:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('#usdc-payments').getByText('REWARD · @test_raider · 0.625 USDC', { exact: true })
Expected: visible
Error: strict mode violation: locator('#usdc-payments').getByText('REWARD · @test_raider · 0.625 USDC', { exact: true }) resolved to 3 elements:
    1) <strong>…</strong> aka getByText('REWARD · @test_raider · 0.625').first()
    2) <strong>…</strong> aka getByText('REWARD · @test_raider · 0.625').nth(1)
    3) <strong>…</strong> aka getByText('REWARD · @test_raider · 0.625').nth(2)

Call log:
  - Expect "toBeVisible" locator('#usdc-payments').getByText('REWARD · @test_raider · 0.625 USDC', { exact: true }) with timeout 5000ms
  - waiting for locator('#usdc-payments').getByText('REWARD · @test_raider · 0.625 USDC', { exact: true })

```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
    - link "Skip to content" [ref=f1e2] [cursor=pointer]:
        - /url: '#main'
    - banner [ref=f1e3]:
        - generic [ref=f1e4]:
            - link "useRAID.fun home" [ref=f1e5] [cursor=pointer]:
                - /url: /
                - generic [ref=f1e10]: useRAID.fun
            - link "Create a raid" [ref=f1e11] [cursor=pointer]:
                - /url: /creator/new
            - button "@test_creator X connected" [ref=f1e13] [cursor=pointer]:
                - generic [ref=f1e14]: '@test_creator'
                - generic [ref=f1e17]: X connected
            - button "Open menu" [ref=f1e20] [cursor=pointer]
    - generic [ref=f1e22]:
        - text: Local test Studio · Fixture X posts and test USDC · No real funds
        - link "Creator Studio" [ref=f1e23] [cursor=pointer]:
            - /url: /creator
    - main [ref=f1e24]:
        - generic [ref=f1e25]:
            - heading "Operations" [level=1] [ref=f1e26]
            - paragraph [ref=f1e27]: Keep the pilot useful, attributable, and within budget.
        - region "OAuth diagnostics" [ref=f1e28]:
            - heading "OAuth diagnostics" [level=2] [ref=f1e29]
            - paragraph [ref=f1e30]: 'OAuth configuration: Unavailable'
            - paragraph [ref=f1e31]: 'X authorization: OK (last successful connection)'
            - paragraph [ref=f1e32]: 'X user lookup: OK (last successful connection)'
            - paragraph [ref=f1e33]: 'X user ID: detected (studio-test-b4d8e829-7a19-407d-b882-bc552bf22e47)'
            - paragraph [ref=f1e34]: 'Database connection: OK'
            - paragraph [ref=f1e35]: 'Last verified: 2026-10-10T15:04:17.797Z'
        - generic [ref=f1e36]:
            - heading "X tracking operations" [level=2] [ref=f1e37]
            - paragraph [ref=f1e38]: 'New tracking: enabled · Reviewed payouts: paused · 0 pending jobs · 0 stale active posts'
            - heading "Finalization and held funds (4)" [level=3] [ref=f1e39]
            - generic [ref=f1e40]:
                - link "Blocked storage 1791644187277" [ref=f1e41] [cursor=pointer]:
                    - /url: /raids/cmv2iouxx004antlq9dyppssz
                - paragraph [ref=f1e42]: FINALIZING · unavailable · No provider error · review not started
            - generic [ref=f1e43]:
                - link "Manage links 1791644191007" [ref=f1e44] [cursor=pointer]:
                    - /url: /raids/cmv2ioxi3004kntlqpuvkee6n
                - paragraph [ref=f1e45]: FINALIZING · unavailable · No provider error · review not started
            - generic [ref=f1e46]:
                - link "Blocked storage 1791644313160" [ref=f1e47] [cursor=pointer]:
                    - /url: /raids/cmv2iro26009sntlqbjqdavix
                - paragraph [ref=f1e48]: FINALIZING · unavailable · No provider error · review not started
            - generic [ref=f1e49]:
                - link "Manage links 1791644321176" [ref=f1e50] [cursor=pointer]:
                    - /url: /raids/cmv2irpy900a2ntlqt434k7q1
                - paragraph [ref=f1e51]: FINALIZING · unavailable · No provider error · review not started
            - heading "Needs review (0)" [level=3] [ref=f1e52]
            - paragraph [ref=f1e53]: No contributions need a decision.
            - group [ref=f1e54]:
                - generic "Excluded / unavailable (0)" [ref=f1e55]
            - heading "Open disputes (0)" [level=3] [ref=f1e56]
        - generic [ref=f1e57]: Deployment feasibility gate is closed. Live X collection stays disabled regardless of the switch below.
        - generic [ref=f1e58]:
            - generic [ref=f1e59]:
                - generic [ref=f1e60]: Recorded X usage ceiling
                - strong [ref=f1e61]: $0.00
            - generic [ref=f1e62]:
                - generic [ref=f1e63]: Sign-in spend this month
                - strong [ref=f1e64]: $0.00
            - generic [ref=f1e65]:
                - generic [ref=f1e66]: Monthly budget
                - strong [ref=f1e67]: $200
            - generic [ref=f1e68]:
                - generic [ref=f1e69]: Collection state
                - strong [ref=f1e70]: Paused
            - generic [ref=f1e71]:
                - generic [ref=f1e72]: Failed jobs shown
                - strong [ref=f1e73]: '0'
        - search [ref=f1e74]:
            - searchbox "Search operations" [ref=f1e75]
            - button "Search" [ref=f1e76] [cursor=pointer]
        - navigation "Operations sections" [ref=f1e77]:
            - link "Operating limits" [ref=f1e78] [cursor=pointer]:
                - /url: '#limits'
            - link "USDC reconciliation" [ref=f1e79] [cursor=pointer]:
                - /url: '#usdc-reconciliation'
            - link "Raid funding" [ref=f1e80] [cursor=pointer]:
                - /url: '#standalone-funding'
            - link "Launchpads" [ref=f1e81] [cursor=pointer]:
                - /url: '#finance'
            - link "Creators" [ref=f1e82] [cursor=pointer]:
                - /url: '#creators'
            - link "Campaigns" [ref=f1e83] [cursor=pointer]:
                - /url: '#campaigns'
            - link "Posts" [ref=f1e84] [cursor=pointer]:
                - /url: '#posts'
            - link "Failures" [ref=f1e85] [cursor=pointer]:
                - /url: '#failures'
            - link "Activity & audit" [ref=f1e86] [cursor=pointer]:
                - /url: '#activity'
        - generic [ref=f1e87]:
            - generic [ref=f1e88]:
                - heading "USDC withdrawals & rewards" [level=2] [ref=f1e89]
                - paragraph [ref=f1e90]: 'Rate: 1.00 USDC / 1,000 impressions. Operator sends transfers manually; platform pays outbound network fees. No transfer is sent by this page.'
                - generic [ref=f1e91]:
                    - strong [ref=f1e92]: REWARD · @test_raider · 0.625 USDC
                    - paragraph [ref=f1e93]: 'sandbox · Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
                    - paragraph [ref=f1e94]:
                        - text: 'From platform: 11111111111111111111111111111111To verified wallet: 4MfyR4G3NWfVRDWo6iNAHDBZqWMgwZX6FNtMqEW3a9JTRaw units (6 decimals): 625000Required memo:'
                        - code [ref=f1e95]: useRAID:usdc:cmv2iq6oe007sntlq0nuk0tdq
                    - generic [ref=f1e96]:
                        - generic [ref=f1e97]:
                            - generic [ref=f1e98]:
                                - text: Finalized USDC transfer signature
                                - textbox "Finalized USDC transfer signature" [ref=f1e99]: sandbox:cmv2iq6oe007sntlq0nuk0tdq
                            - button "Confirm test payment" [ref=f1e100] [cursor=pointer]
                        - status
                - generic [ref=f1e101]:
                    - strong [ref=f1e102]: REWARD · @test_raider · 0.625 USDC
                    - paragraph [ref=f1e103]: 'sandbox · Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
                    - paragraph [ref=f1e104]:
                        - text: 'From platform: 11111111111111111111111111111111To verified wallet: 4MfyR4G3NWfVRDWo6iNAHDBZqWMgwZX6FNtMqEW3a9JTRaw units (6 decimals): 625000Required memo:'
                        - code [ref=f1e105]: useRAID:usdc:cmv2ir4n6008intlq1u0gnuf3
                    - generic [ref=f1e106]:
                        - generic [ref=f1e107]:
                            - generic [ref=f1e108]:
                                - text: Finalized USDC transfer signature
                                - textbox "Finalized USDC transfer signature" [ref=f1e109]: sandbox:cmv2ir4n6008intlq1u0gnuf3
                            - button "Confirm test payment" [ref=f1e110] [cursor=pointer]
                        - status
                - generic [ref=f1e111]:
                    - strong [ref=f1e112]: REWARD · @test_raider · 0.625 USDC
                    - paragraph [ref=f1e113]: 'sandbox · Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
                    - paragraph [ref=f1e114]:
                        - text: 'From platform: 11111111111111111111111111111111To verified wallet: 4MfyR4G3NWfVRDWo6iNAHDBZqWMgwZX6FNtMqEW3a9JTRaw units (6 decimals): 625000Required memo:'
                        - code [ref=f1e115]: useRAID:usdc:cmv2iz7wv000nnt4jawhflnzb
                    - generic [ref=f1e116]:
                        - generic [ref=f1e117]:
                            - generic [ref=f1e118]:
                                - text: Finalized USDC transfer signature
                                - textbox "Finalized USDC transfer signature" [ref=f1e119]: sandbox:cmv2iz7wv000nnt4jawhflnzb
                            - button "Confirm test payment" [ref=f1e120] [cursor=pointer]
                        - status
            - generic [ref=f1e121]:
                - heading "USDC reconciliation" [level=2] [ref=f1e122]
                - paragraph [ref=f1e123]: 'Network: sandboxLedger liabilities (available + reserved, credits included): 46,021.50 USDCReward transfers awaiting payment: 1.875 USDCCustody wallet balance: Not applicableSurplus: Not applicableUnconfirmed deposit intents: 0'
                - heading "Expired deposit intents" [level=3] [ref=f1e124]
                - paragraph [ref=f1e125]: No expired deposit intents.
            - generic [ref=f1e126]:
                - heading "Non-token Raid funding" [level=2] [ref=f1e127]
                - paragraph [ref=f1e128]: 'Rate: Not configured · Funding wallet: Not configured'
                - paragraph [ref=f1e129]: Creator deposits remain platform held until final review. Send each verified allocation from funding wallet with exact memo shown below. Record finalized signature after transfer.
                - heading "Payments due" [level=3] [ref=f1e130]
                - paragraph [ref=f1e131]: No reviewed allocations awaiting payment.
            - generic [ref=f1e132]:
                - heading "Operating limits" [level=2] [ref=f1e133]
                - generic [ref=f1e135]:
                    - generic [ref=f1e136]:
                        - checkbox "Enable X collection (kill switch)" [checked] [ref=f1e137]
                        - text: Enable X collection (kill switch)
                    - generic [ref=f1e138]:
                        - generic [ref=f1e139]:
                            - text: Campaign slots
                            - spinbutton "Campaign slots" [ref=f1e140]: '10'
                        - generic [ref=f1e141]:
                            - text: Approved creators
                            - spinbutton "Approved creators" [ref=f1e142]: '5'
                        - generic [ref=f1e143]:
                            - text: X budget (cents)
                            - spinbutton "X budget (cents)" [ref=f1e144]: '20000'
                        - generic [ref=f1e145]:
                            - text: Collection cutoff (cents)
                            - spinbutton "Collection cutoff (cents)" [ref=f1e146]: '18000'
                        - generic [ref=f1e147]:
                            - text: Daily request limit
                            - spinbutton "Daily request limit" [ref=f1e148]: '5000'
                        - generic [ref=f1e149]:
                            - text: Daily sign-in limit
                            - spinbutton "Daily sign-in limit" [ref=f1e150]: '1000'
                    - generic [ref=f1e151]:
                        - text: Change reason
                        - textbox "Change reason" [ref=f1e152]
                    - button "Save operating limits" [ref=f1e153] [cursor=pointer]
                    - status
            - heading "Launchpads · Coming soon" [level=2] [ref=f1e155]
            - generic [ref=f1e156]:
                - heading "Creator approvals" [level=2] [ref=f1e157]
                - paragraph [ref=f1e158]:
                    - link "Show only pending requests" [ref=f1e159] [cursor=pointer]:
                        - /url: /admin?creators=pending#creators
                - generic [ref=f1e160]:
                    - strong [ref=f1e161]: '@test_raider · Pending'
                    - paragraph [ref=f1e162]: No affiliation submitted.
                    - generic [ref=f1e163]:
                        - 'textbox "Reason: Approve creator" [ref=f1e165]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e166] [cursor=pointer]
                    - generic [ref=f1e167]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e169]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e170] [cursor=pointer]
                - generic [ref=f1e171]:
                    - strong [ref=f1e172]: '@test_creator · Pending'
                    - paragraph [ref=f1e173]: Founder of the Example project, official site example.com
                    - generic [ref=f1e174]:
                        - 'textbox "Reason: Approve creator" [ref=f1e176]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e177] [cursor=pointer]
                    - generic [ref=f1e178]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e180]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e181] [cursor=pointer]
                - generic [ref=f1e182]:
                    - strong [ref=f1e183]: '@test_raider · Pending'
                    - paragraph [ref=f1e184]: No affiliation submitted.
                    - generic [ref=f1e185]:
                        - 'textbox "Reason: Approve creator" [ref=f1e187]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e188] [cursor=pointer]
                    - generic [ref=f1e189]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e191]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e192] [cursor=pointer]
                - generic [ref=f1e193]:
                    - strong [ref=f1e194]: '@test_raider · Pending'
                    - paragraph [ref=f1e195]: No affiliation submitted.
                    - generic [ref=f1e196]:
                        - 'textbox "Reason: Approve creator" [ref=f1e198]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e199] [cursor=pointer]
                    - generic [ref=f1e200]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e202]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e203] [cursor=pointer]
                - generic [ref=f1e204]:
                    - strong [ref=f1e205]: '@test_creator · Pending'
                    - paragraph [ref=f1e206]: No affiliation submitted.
                    - generic [ref=f1e207]:
                        - 'textbox "Reason: Approve creator" [ref=f1e209]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e210] [cursor=pointer]
                    - generic [ref=f1e211]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e213]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e214] [cursor=pointer]
                - generic [ref=f1e215]:
                    - strong [ref=f1e216]: '@test_creator · Pending'
                    - paragraph [ref=f1e217]: No affiliation submitted.
                    - generic [ref=f1e218]:
                        - 'textbox "Reason: Approve creator" [ref=f1e220]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e221] [cursor=pointer]
                    - generic [ref=f1e222]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e224]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e225] [cursor=pointer]
                - generic [ref=f1e226]:
                    - strong [ref=f1e227]: '@test_creator · Pending'
                    - paragraph [ref=f1e228]: No affiliation submitted.
                    - generic [ref=f1e229]:
                        - 'textbox "Reason: Approve creator" [ref=f1e231]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e232] [cursor=pointer]
                    - generic [ref=f1e233]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e235]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e236] [cursor=pointer]
                - generic [ref=f1e237]:
                    - strong [ref=f1e238]: '@test_creator · Pending'
                    - paragraph [ref=f1e239]: No affiliation submitted.
                    - generic [ref=f1e240]:
                        - 'textbox "Reason: Approve creator" [ref=f1e242]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e243] [cursor=pointer]
                    - generic [ref=f1e244]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e246]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e247] [cursor=pointer]
                - generic [ref=f1e248]:
                    - strong [ref=f1e249]: '@test_creator · Pending'
                    - paragraph [ref=f1e250]: Founder of the Example project, official site example.com
                    - generic [ref=f1e251]:
                        - 'textbox "Reason: Approve creator" [ref=f1e253]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e254] [cursor=pointer]
                    - generic [ref=f1e255]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e257]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e258] [cursor=pointer]
                - generic [ref=f1e259]:
                    - strong [ref=f1e260]: '@test_raider · Pending'
                    - paragraph [ref=f1e261]: No affiliation submitted.
                    - generic [ref=f1e262]:
                        - 'textbox "Reason: Approve creator" [ref=f1e264]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e265] [cursor=pointer]
                    - generic [ref=f1e266]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e268]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e269] [cursor=pointer]
                - generic [ref=f1e270]:
                    - strong [ref=f1e271]: '@test_creator · Pending'
                    - paragraph [ref=f1e272]: No affiliation submitted.
                    - generic [ref=f1e273]:
                        - 'textbox "Reason: Approve creator" [ref=f1e275]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e276] [cursor=pointer]
                    - generic [ref=f1e277]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e279]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e280] [cursor=pointer]
                - generic [ref=f1e281]:
                    - strong [ref=f1e282]: '@test_creator · Pending'
                    - paragraph [ref=f1e283]: No affiliation submitted.
                    - generic [ref=f1e284]:
                        - 'textbox "Reason: Approve creator" [ref=f1e286]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e287] [cursor=pointer]
                    - generic [ref=f1e288]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e290]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e291] [cursor=pointer]
                - generic [ref=f1e292]:
                    - strong [ref=f1e293]: '@test_creator · Pending'
                    - paragraph [ref=f1e294]: No affiliation submitted.
                    - generic [ref=f1e295]:
                        - 'textbox "Reason: Approve creator" [ref=f1e297]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e298] [cursor=pointer]
                    - generic [ref=f1e299]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e301]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e302] [cursor=pointer]
                - generic [ref=f1e303]:
                    - strong [ref=f1e304]: '@test_creator · Pending'
                    - paragraph [ref=f1e305]: No affiliation submitted.
                    - generic [ref=f1e306]:
                        - 'textbox "Reason: Approve creator" [ref=f1e308]':
                            - /placeholder: Reason for audit log
                        - button "Approve creator" [ref=f1e309] [cursor=pointer]
                    - generic [ref=f1e310]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e312]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e313] [cursor=pointer]
                - generic [ref=f1e314]:
                    - strong [ref=f1e315]: '@test_creator · Approved'
                    - paragraph [ref=f1e316]: No affiliation submitted.
                    - generic [ref=f1e317]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e319]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e320] [cursor=pointer]
                    - generic [ref=f1e321]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e323]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e324] [cursor=pointer]
                - generic [ref=f1e325]:
                    - strong [ref=f1e326]: '@test_creator · Approved'
                    - paragraph [ref=f1e327]: No affiliation submitted.
                    - generic [ref=f1e328]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e330]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e331] [cursor=pointer]
                    - generic [ref=f1e332]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e334]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e335] [cursor=pointer]
                - generic [ref=f1e336]:
                    - strong [ref=f1e337]: '@test_creator · Approved'
                    - paragraph [ref=f1e338]: No affiliation submitted.
                    - generic [ref=f1e339]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e341]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e342] [cursor=pointer]
                    - generic [ref=f1e343]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e345]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e346] [cursor=pointer]
                - generic [ref=f1e347]:
                    - strong [ref=f1e348]: '@test_creator · Approved'
                    - paragraph [ref=f1e349]: No affiliation submitted.
                    - generic [ref=f1e350]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e352]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e353] [cursor=pointer]
                    - generic [ref=f1e354]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e356]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e357] [cursor=pointer]
                - generic [ref=f1e358]:
                    - strong [ref=f1e359]: '@test_creator · Approved'
                    - paragraph [ref=f1e360]: No affiliation submitted.
                    - generic [ref=f1e361]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e363]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e364] [cursor=pointer]
                    - generic [ref=f1e365]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e367]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e368] [cursor=pointer]
                - generic [ref=f1e369]:
                    - strong [ref=f1e370]: '@test_creator · Approved'
                    - paragraph [ref=f1e371]: No affiliation submitted.
                    - generic [ref=f1e372]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e374]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e375] [cursor=pointer]
                    - generic [ref=f1e376]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e378]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e379] [cursor=pointer]
                - generic [ref=f1e380]:
                    - strong [ref=f1e381]: '@test_creator · Approved'
                    - paragraph [ref=f1e382]: No affiliation submitted.
                    - generic [ref=f1e383]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e385]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e386] [cursor=pointer]
                    - generic [ref=f1e387]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e389]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e390] [cursor=pointer]
                - generic [ref=f1e391]:
                    - strong [ref=f1e392]: '@test_creator · Approved'
                    - paragraph [ref=f1e393]: No affiliation submitted.
                    - generic [ref=f1e394]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e396]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e397] [cursor=pointer]
                    - generic [ref=f1e398]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e400]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e401] [cursor=pointer]
                - generic [ref=f1e402]:
                    - strong [ref=f1e403]: '@test_creator · Approved'
                    - paragraph [ref=f1e404]: No affiliation submitted.
                    - generic [ref=f1e405]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e407]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e408] [cursor=pointer]
                    - generic [ref=f1e409]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e411]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e412] [cursor=pointer]
                - generic [ref=f1e413]:
                    - strong [ref=f1e414]: '@test_creator · Approved'
                    - paragraph [ref=f1e415]: No affiliation submitted.
                    - generic [ref=f1e416]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e418]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e419] [cursor=pointer]
                    - generic [ref=f1e420]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e422]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e423] [cursor=pointer]
                - generic [ref=f1e424]:
                    - strong [ref=f1e425]: '@test_creator · Approved'
                    - paragraph [ref=f1e426]: No affiliation submitted.
                    - generic [ref=f1e427]:
                        - 'textbox "Reason: Revoke approval" [ref=f1e429]':
                            - /placeholder: Reason for audit log
                        - button "Revoke approval" [ref=f1e430] [cursor=pointer]
                    - generic [ref=f1e431]:
                        - 'textbox "Reason: Suspend creator" [ref=f1e433]':
                            - /placeholder: Reason for audit log
                        - button "Suspend creator" [ref=f1e434] [cursor=pointer]
                - navigation "creators pages" [ref=f1e435]:
                    - generic [ref=f1e436]: Page 1
                    - link "Next" [ref=f1e437] [cursor=pointer]:
                        - /url: /admin?creatorPage=2#creators
            - generic [ref=f1e438]:
                - heading "Campaign moderation" [level=2] [ref=f1e439]
                - generic [ref=f1e440]:
                    - strong [ref=f1e441]: Browser Studio 1791644659123
                    - paragraph [ref=f1e442]: '@test_creator · ENDED · complete'
                    - generic [ref=f1e443]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e445]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e446] [cursor=pointer]
                - generic [ref=f1e447]:
                    - strong [ref=f1e448]: Manage links 1791644321176
                    - paragraph [ref=f1e449]: '@test_creator · ENDED · unavailable'
                    - generic [ref=f1e450]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e452]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e453] [cursor=pointer]
                - generic [ref=f1e454]:
                    - strong [ref=f1e455]: Blocked storage 1791644313160
                    - paragraph [ref=f1e456]: '@test_creator · ENDED · unavailable'
                    - generic [ref=f1e457]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e459]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e460] [cursor=pointer]
                - generic [ref=f1e461]:
                    - strong [ref=f1e462]: Large draft 1791644300973
                    - paragraph [ref=f1e463]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e464]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e466]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e467] [cursor=pointer]
                - generic [ref=f1e468]:
                    - strong [ref=f1e469]: Browser Studio 1791644285913
                    - paragraph [ref=f1e470]: '@test_creator · ENDED · complete'
                    - generic [ref=f1e471]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e473]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e474] [cursor=pointer]
                - generic [ref=f1e475]:
                    - strong [ref=f1e476]: Browser Studio 1791644223982
                    - paragraph [ref=f1e477]: '@test_creator · ENDED · complete'
                    - generic [ref=f1e478]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e480]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e481] [cursor=pointer]
                - generic [ref=f1e482]:
                    - strong [ref=f1e483]: Page check 1791644215193
                    - paragraph [ref=f1e484]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e485]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e487]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e488] [cursor=pointer]
                - generic [ref=f1e489]:
                    - strong [ref=f1e490]: Page check 1791644212860
                    - paragraph [ref=f1e491]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e492]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e494]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e495] [cursor=pointer]
                - generic [ref=f1e496]:
                    - strong [ref=f1e497]: Page check 1791644210365
                    - paragraph [ref=f1e498]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e499]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e501]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e502] [cursor=pointer]
                - generic [ref=f1e503]:
                    - strong [ref=f1e504]: Page check 1791644208202
                    - paragraph [ref=f1e505]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e506]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e508]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e509] [cursor=pointer]
                - generic [ref=f1e510]:
                    - strong [ref=f1e511]: Page check 1791644205991
                    - paragraph [ref=f1e512]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e513]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e515]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e516] [cursor=pointer]
                - generic [ref=f1e517]:
                    - strong [ref=f1e518]: Page check 1791644203834
                    - paragraph [ref=f1e519]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e520]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e522]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e523] [cursor=pointer]
                - generic [ref=f1e524]:
                    - strong [ref=f1e525]: Page check 1791644201541
                    - paragraph [ref=f1e526]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e527]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e529]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e530] [cursor=pointer]
                - generic [ref=f1e531]:
                    - strong [ref=f1e532]: Page check 1791644198787
                    - paragraph [ref=f1e533]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e534]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e536]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e537] [cursor=pointer]
                - generic [ref=f1e538]:
                    - strong [ref=f1e539]: Manage links 1791644191007
                    - paragraph [ref=f1e540]: '@test_creator · ENDED · unavailable'
                    - generic [ref=f1e541]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e543]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e544] [cursor=pointer]
                - generic [ref=f1e545]:
                    - strong [ref=f1e546]: Blocked storage 1791644187277
                    - paragraph [ref=f1e547]: '@test_creator · ENDED · unavailable'
                    - generic [ref=f1e548]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e550]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e551] [cursor=pointer]
                - generic [ref=f1e552]:
                    - strong [ref=f1e553]: Large draft 1791644173790
                    - paragraph [ref=f1e554]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e555]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e557]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e558] [cursor=pointer]
                - generic [ref=f1e559]:
                    - strong [ref=f1e560]: Browser Studio 1791644158836
                    - paragraph [ref=f1e561]: '@test_creator · ENDED · complete'
                    - generic [ref=f1e562]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e564]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e565] [cursor=pointer]
                - generic [ref=f1e566]:
                    - strong [ref=f1e567]: Page check 1791644150369
                    - paragraph [ref=f1e568]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e569]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e571]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e572] [cursor=pointer]
                - generic [ref=f1e573]:
                    - strong [ref=f1e574]: Page check 1791644146823
                    - paragraph [ref=f1e575]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e576]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e578]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e579] [cursor=pointer]
                - generic [ref=f1e580]:
                    - strong [ref=f1e581]: Page check 1791644144559
                    - paragraph [ref=f1e582]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e583]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e585]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e586] [cursor=pointer]
                - generic [ref=f1e587]:
                    - strong [ref=f1e588]: Page check 1791644142420
                    - paragraph [ref=f1e589]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e590]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e592]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e593] [cursor=pointer]
                - generic [ref=f1e594]:
                    - strong [ref=f1e595]: Page check 1791644139499
                    - paragraph [ref=f1e596]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e597]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e599]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e600] [cursor=pointer]
                - generic [ref=f1e601]:
                    - strong [ref=f1e602]: Page check 1791644136977
                    - paragraph [ref=f1e603]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e604]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e606]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e607] [cursor=pointer]
                - generic [ref=f1e608]:
                    - strong [ref=f1e609]: Page check 1791644134823
                    - paragraph [ref=f1e610]: '@test_creator · DRAFT · unavailable'
                    - generic [ref=f1e611]:
                        - 'textbox "Reason: Hide campaign" [ref=f1e613]':
                            - /placeholder: Reason for audit log
                        - button "Hide campaign" [ref=f1e614] [cursor=pointer]
                - navigation "campaigns pages" [ref=f1e615]:
                    - generic [ref=f1e616]: Page 1
                    - link "Next" [ref=f1e617] [cursor=pointer]:
                        - /url: /admin?campaignPage=2#campaigns
            - generic [ref=f1e618]:
                - heading "Post moderation" [level=2] [ref=f1e619]
                - generic [ref=f1e620]:
                    - paragraph [ref=f1e621]: Local test contribution 1791644670970 @useRAID
                    - paragraph [ref=f1e622]: 'X ID: 179164467097000001'
                    - generic [ref=f1e623]:
                        - 'textbox "Reason: Hide post" [ref=f1e625]':
                            - /placeholder: Reason for audit log
                        - button "Hide post" [ref=f1e626] [cursor=pointer]
                - generic [ref=f1e627]:
                    - paragraph [ref=f1e628]: Local test contribution 1791644293253 @useRAID
                    - paragraph [ref=f1e629]: 'X ID: 179164429325300001'
                    - generic [ref=f1e630]:
                        - 'textbox "Reason: Hide post" [ref=f1e632]':
                            - /placeholder: Reason for audit log
                        - button "Hide post" [ref=f1e633] [cursor=pointer]
                - generic [ref=f1e634]:
                    - paragraph [ref=f1e635]: Local test contribution 1791644249425 @useRAID
                    - paragraph [ref=f1e636]: 'X ID: 179164424942500001'
                    - generic [ref=f1e637]:
                        - 'textbox "Reason: Hide post" [ref=f1e639]':
                            - /placeholder: Reason for audit log
                        - button "Hide post" [ref=f1e640] [cursor=pointer]
                - generic [ref=f1e641]:
                    - paragraph [ref=f1e642]: Local test contribution 1791644166113 @useRAID
                    - paragraph [ref=f1e643]: 'X ID: 179164416611300001'
                    - generic [ref=f1e644]:
                        - 'textbox "Reason: Hide post" [ref=f1e646]':
                            - /placeholder: Reason for audit log
                        - button "Hide post" [ref=f1e647] [cursor=pointer]
            - generic [ref=f1e648]:
                - heading "Collection failures" [level=2] [ref=f1e649]
                - paragraph [ref=f1e650]: No failed jobs.
            - generic [ref=f1e651]:
                - heading "Pilot activity this month" [level=2] [ref=f1e652]
                - generic [ref=f1e653]:
                    - paragraph [ref=f1e654]: 'Completed campaigns (all time): 8'
                    - paragraph [ref=f1e655]: 'Creators with a second campaign (all time): 0'
                    - paragraph [ref=f1e656]: 'Returning discovery visitors (seen on 2+ days): 0'
                - heading "Usage by campaign" [level=2] [ref=f1e657]
                - heading "Recent audit events" [level=2] [ref=f1e658]
                - generic [ref=f1e659]:
                    - strong [ref=f1e660]: usdc-payment · Oct 10, 2026, 2:56 PM UTC
                    - paragraph [ref=f1e661]: Finalized payment sandbox:cmv2ioee1002zntlq28rbz8wr
    - contentinfo [ref=f1e662]:
        - generic [ref=f1e663]:
            - link "useRAID.fun" [ref=f1e664] [cursor=pointer]:
                - /url: /
            - generic [ref=f1e668]: Community attention, in context.
        - generic [ref=f1e669]:
            - link "Methodology" [ref=f1e670] [cursor=pointer]:
                - /url: /methodology
            - link "Privacy" [ref=f1e671] [cursor=pointer]:
                - /url: /privacy
            - link "Admin" [ref=f1e672] [cursor=pointer]:
                - /url: /admin
    - alert [ref=f1e675]
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | import { watchConsole } from '../helpers/browser-console';
  3   | test.beforeEach(async ({ page }) => {
  4   |   const login = await page.request.post('/api/studio/sandbox', {
  5   |     headers: { origin: 'http://localhost:3007' },
  6   |     data: { action: 'login', fixtureId: crypto.randomUUID() },
  7   |   });
  8   |   expect(login.ok()).toBe(true);
  9   |   await page.goto('/creator');
  10  |   await expect(page.getByRole('heading', { name: 'Creator Studio', exact: true })).toBeVisible();
  11  | });
  12  | test('launch, target attribution, completion, reviewed allocation and manual test payment', async ({
  13  |   page,
  14  | }, testInfo) => {
  15  |   await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  16  |   await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  17  |   const title = `Browser Studio ${Date.now()}`;
  18  |   await page.getByLabel('Campaign name', { exact: true }).fill(title);
  19  |   await page
  20  |     .getByLabel('X post 1', { exact: true })
  21  |     .fill('https://x.com/project/status/123456789123456789');
  22  |   await page.getByRole('button', { name: 'Preview', exact: true }).click();
  23  |   await expect(page.getByText('Public post found', { exact: true })).toBeVisible();
  24  |   await page.getByLabel('Reward budget (USDC)').fill('2.5');
  25  |   await page.getByLabel('Reward budget (USDC)').press('Tab');
  26  |   await expect(page.getByLabel('Impression target')).toHaveValue('2500');
  27  |   await page.screenshot({
  28  |     path: `test-results/studio-editor-${testInfo.project.name}.png`,
  29  |     fullPage: true,
  30  |   });
  31  |   await page.getByRole('checkbox').check();
  32  |   await page.getByRole('button', { name: 'Fund & Launch Raid', exact: true }).click();
  33  |   await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  34  |   await expect(page.getByText('2.50 USDC reward pool', { exact: true })).toBeVisible();
  35  |   const manageUrl = page.url(),
  36  |     id = new URL(manageUrl).pathname.split('/').at(-1)!;
  37  |   await page
  38  |     .getByLabel('Add a campaign post')
  39  |     .fill('https://x.com/project/status/123456789123456790');
  40  |   await page.getByRole('button', { name: 'Add post', exact: true }).click();
  41  |   await expect(page.getByText('Campaign post added.', { exact: true })).toBeVisible();
  42  |   await page
  43  |     .getByRole('button', { name: 'Reach target & finish test review', exact: true })
  44  |     .click();
  45  |   await expect(page.getByText('ALLOCATED', { exact: false })).toBeVisible();
  46  |   await expect(page.getByText(/0.625 USDC estimated/)).toBeVisible();
  47  |   const report = await page.request.get(`/api/raids/${id}/report`);
  48  |   expect(report.ok()).toBe(true);
  49  |   expect(await report.text()).toContain('reviewed USDC');
  50  |   await page.getByRole('link', { name: 'View public Raid', exact: true }).click();
  51  |   await expect(page.getByRole('heading', { name: 'Raid these posts' })).toBeVisible();
  52  |   await page.goto('/admin');
  53  |   const queue = page.locator('#usdc-payments');
  54  |   await expect(
  55  |     queue.getByText('REWARD · @test_raider · 0.625 USDC', { exact: true }),
> 56  |   ).toBeVisible();
      |     ^ Error: expect(locator).toBeVisible() failed
  57  |   const payment = queue
  58  |     .locator('.admin-row')
  59  |     .filter({ hasText: 'REWARD · @test_raider · 0.625 USDC' })
  60  |     .last();
  61  |   const memo = (await payment.locator('code').textContent())!;
  62  |   await payment.getByRole('button', { name: 'Confirm test payment' }).click();
  63  |   await expect(queue.locator('.admin-row').filter({ hasText: memo })).toHaveCount(0);
  64  |   await page.goto('/creator');
  65  |   const card = page.locator('.studio-raid-row').filter({ hasText: title });
  66  |   await expect(card.getByText(/Paid/)).toBeVisible();
  67  |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
  68  |     true,
  69  |   );
  70  | });
  71  | test('deposit preserves saved draft; wallet and X diagnostics stay out of Studio', async ({
  72  |   page,
  73  | }) => {
  74  |   await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  75  |   await page.getByRole('button', { name: /X Campaign No token needed/ }).click();
  76  |   await page.getByLabel('Campaign name', { exact: true }).fill(`Large draft ${Date.now()}`);
  77  |   await page
  78  |     .getByLabel('X post 1', { exact: true })
  79  |     .fill('https://x.com/project/status/123456789123456788');
  80  |   await page.getByLabel('Impression target').fill('1000000');
  81  |   await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  82  |   await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  83  |   await page.waitForURL(/\/creator\/new\?draft=/);
  84  |   const draftUrl = page.url();
  85  |   await page.goto(
  86  |     `/creator/balance?returnTo=${encodeURIComponent(new URL(draftUrl).pathname + new URL(draftUrl).search)}`,
  87  |   );
  88  |   await page.getByLabel('Amount (USDC)').fill('12');
  89  |   await page.getByRole('button', { name: 'Add test USDC' }).click();
  90  |   await expect(
  91  |     page.getByText('Deposit confirmed. USDC is available.', { exact: true }),
  92  |   ).toBeVisible();
  93  |   await page.getByRole('link', { name: 'Return to draft', exact: true }).click();
  94  |   await expect(page.getByLabel('Impression target')).toHaveValue('1000000');
  95  |   await expect(page.getByLabel('X post 1', { exact: true })).toHaveValue(
  96  |     'https://x.com/i/web/status/123456789123456788',
  97  |   );
  98  |   await expect(page.getByText('OAuth diagnostics', { exact: false })).toHaveCount(0);
  99  | });
  100 | test('existing token uses same editor; Launch Token stays Coming soon', async ({ page }) => {
  101 |   await page.getByRole('link', { name: 'Create Raid', exact: true }).first().click();
  102 |   await expect(page.getByText('Coming soon', { exact: true })).toBeVisible();
  103 |   await page.getByRole('button', { name: /Existing Token Identify your token/ }).click();
  104 |   await page
  105 |     .getByLabel('Solana contract address')
  106 |     .fill('So11111111111111111111111111111111111111112');
  107 |   await expect(page.getByText('Token found', { exact: true })).toBeVisible();
  108 |   await expect(page.getByLabel('Campaign name', { exact: true })).not.toHaveValue('');
  109 |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
  110 |     true,
  111 |   );
  112 | });
  113 | test('unapproved creators request approval before they can create a Raid', async ({ page }) => {
  114 |   const login = await page.request.post('/api/studio/sandbox', {
  115 |     headers: { origin: 'http://localhost:3007' },
  116 |     data: { action: 'login', fixtureId: `unapproved-${crypto.randomUUID()}` },
  117 |   });
  118 |   expect(login.ok()).toBe(true);
  119 |   await page.goto('/creator');
  120 |   await expect(page.getByRole('heading', { name: 'Creator approval required' })).toBeVisible();
  121 |   await page
  122 |     .getByLabel('Project affiliation')
  123 |     .fill('Founder of the Example project, official site example.com');
  124 |   await page.getByRole('button', { name: 'Request creator approval' }).click();
  125 |   await expect(page.getByText('Request submitted for administrator review.')).toBeVisible();
  126 |   await page.goto('/creator/new');
  127 |   await expect(page.getByRole('heading', { name: 'Creator approval required' })).toBeVisible();
  128 |   await expect(page.getByLabel('Campaign name', { exact: true })).toHaveCount(0);
  129 |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
  130 |     true,
  131 |   );
  132 | });
  133 | test('shows the sign-in result to a signed-in creator and loads under the CSP', async ({
  134 |   page,
  135 | }) => {
  136 |   const problems = watchConsole(page);
  137 |   await page.goto('/creator/account?auth=identity');
  138 |   await expect(page.getByText(/already tied to another account with activity/)).toBeVisible();
  139 |   await page.goto('/creator?auth=connected');
  140 |   await expect(page.getByText('X account connected.')).toBeVisible();
  141 |   await page.goto('/creator/new');
  142 |   await page.waitForLoadState('networkidle');
  143 |   expect(problems).toEqual([]);
  144 | });
  145 | // Studio keeps a pilot-wide cap on live Raids, so tests that launch one end it again.
  146 | async function endRaid(page: Page, id: string) {
  147 |   const response = await page.request.patch(`/api/raids/${id}`, {
  148 |     headers: { origin: 'http://localhost:3007' },
  149 |     data: { action: 'end' },
  150 |   });
  151 |   expect(response.ok()).toBe(true);
  152 | }
  153 | test('a rejected wallet connection can be retried with the same wallet', async ({ page }) => {
  154 |   await page.addInitScript(() => {
  155 |     let attempts = 0;
  156 |     const wallet = {
```
