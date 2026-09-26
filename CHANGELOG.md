# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
After v0.1.0, version bumps are driven automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/).

## [0.12.61](https://github.com/trail-openers/pi-rukas/compare/v0.12.60...v0.12.61) (2026-09-26)


### Features

* **review:** build the lens roster from skill frontmatter ([#885](https://github.com/trail-openers/pi-rukas/issues/885)) ([ddd5c33](https://github.com/trail-openers/pi-rukas/commit/ddd5c33c8bfb4d8c0d169087e84dc3f350494c9c))


### Bug Fixes

* **review:** name the kill cause when a lens is blocked ([#880](https://github.com/trail-openers/pi-rukas/issues/880)) ([a816202](https://github.com/trail-openers/pi-rukas/commit/a816202c87a637cfb391ece04fcbb4b7cce83bd3))
* **review:** stat each lens skill before spawning and honour Skill Load Status ([#882](https://github.com/trail-openers/pi-rukas/issues/882)) ([0cd684e](https://github.com/trail-openers/pi-rukas/commit/0cd684e32705c1eb2f2d4978231660c184d64889))
* **work:** make the slow-run steer say continue, not stop ([#890](https://github.com/trail-openers/pi-rukas/issues/890)) ([5204279](https://github.com/trail-openers/pi-rukas/commit/5204279ac90d0e3dec8adddc237962346cd6fffd))
* **work:** one slow-run notice per level, not per dimension ([#887](https://github.com/trail-openers/pi-rukas/issues/887)) ([5ffce0b](https://github.com/trail-openers/pi-rukas/commit/5ffce0bc80c534154383863e1c7f1c6684e320c5))
* **work:** pin the commit-pr fallback to its own worktree and lock the consolidated verify ([#889](https://github.com/trail-openers/pi-rukas/issues/889)) ([dcf712d](https://github.com/trail-openers/pi-rukas/commit/dcf712d528914ea3cb17b2653456697f6af0001d))

## [0.12.60](https://github.com/trail-openers/pi-rukas/compare/v0.12.59...v0.12.60) (2026-09-25)


### Features

* **deck:** live view of a running subagent's activity ([#876](https://github.com/trail-openers/pi-rukas/issues/876)) ([12b2133](https://github.com/trail-openers/pi-rukas/commit/12b21330c6a34fa851dc867d84261a8861dde19a))
* **deck:** navigate running subagents with the arrow keys from an empty editor ([#864](https://github.com/trail-openers/pi-rukas/issues/864)) ([4071b3a](https://github.com/trail-openers/pi-rukas/commit/4071b3ab333c4920971285e320b2d42b9504a04d))
* **research:** fall back to the wigolo CLI when parallel-cli fails ([#866](https://github.com/trail-openers/pi-rukas/issues/866)) ([2ee9662](https://github.com/trail-openers/pi-rukas/commit/2ee966280b488a0b6a6c599ed763a034e474a219))
* **work:** notify the PM and steer slow subagents instead of killing them ([#879](https://github.com/trail-openers/pi-rukas/issues/879)) ([23bfd5c](https://github.com/trail-openers/pi-rukas/commit/23bfd5c39b73256505cfe5812bd48120b2bf429a))


### Bug Fixes

* **work:** stop the consolidation gate parking over-declared paths ([#877](https://github.com/trail-openers/pi-rukas/issues/877)) ([234b35f](https://github.com/trail-openers/pi-rukas/commit/234b35f3c1608f1e6220613fb29906afbb46f9b0))

## [0.12.59](https://github.com/trail-openers/pi-rukas/compare/v0.12.58...v0.12.59) (2026-09-24)


### Bug Fixes

* **agents-md:** render a faithful dry-run diff and print the exit code ([#847](https://github.com/trail-openers/pi-rukas/issues/847)) ([7e28196](https://github.com/trail-openers/pi-rukas/commit/7e28196060e088dc24dcdd03811ce20fb00181f2))
* **deck:** disambiguate rows whose job keys share a prefix ([#845](https://github.com/trail-openers/pi-rukas/issues/845)) ([58e3761](https://github.com/trail-openers/pi-rukas/commit/58e376136f08138972135c6cf72217bf13c78297))
* **test:** scope the Pi version census to files git tracks ([#843](https://github.com/trail-openers/pi-rukas/issues/843)) ([80a2a80](https://github.com/trail-openers/pi-rukas/commit/80a2a8085384775f333a884b896716cc204dfee9))
* **work:** attribute fence violations and block sibling annexation ([cd6cb5f](https://github.com/trail-openers/pi-rukas/commit/cd6cb5f2bbcefe5da67b267d50cd5041f27bc873))
* **work:** base restarted cycles on fresh origin main ([#863](https://github.com/trail-openers/pi-rukas/issues/863)) ([05b8f31](https://github.com/trail-openers/pi-rukas/commit/05b8f315b0fe79104b4db85174e3e02c34988b31))
* **work:** detect success-keyed repetition loops and kill them ([57cb3b4](https://github.com/trail-openers/pi-rukas/commit/57cb3b469d58c0af59e4524051c1e15455b45c0e))
* **work:** Epic [#833](https://github.com/trail-openers/pi-rukas/issues/833) sub-issue 2 (G2), filed as its… ([#852](https://github.com/trail-openers/pi-rukas/issues/852)) ([a590a5b](https://github.com/trail-openers/pi-rukas/commit/a590a5bf72e21a37ea1db34bed7ea57ac4dabee8)), closes [#837](https://github.com/trail-openers/pi-rukas/issues/837)
* **work:** gate the consolidated-verify flake retry on a shared assertion ([8016fb0](https://github.com/trail-openers/pi-rukas/commit/8016fb0fff6a8f2fc71d530bb3f93fe5e812531b))
* **work:** parse a nested ### Spec and carry no-signal park evidence ([#850](https://github.com/trail-openers/pi-rukas/issues/850)) ([7b37154](https://github.com/trail-openers/pi-rukas/commit/7b3715423924776a5cc714e1423e9ac7be286afa))
* **work:** persist consolidated-verify output and classify on both streams ([#853](https://github.com/trail-openers/pi-rukas/issues/853)) ([eebc2a7](https://github.com/trail-openers/pi-rukas/commit/eebc2a7fbfd96f5ff75a9256689ae9388161daf9))
* **work:** render the fence-flipped workstream verdicts in the handoff ([#862](https://github.com/trail-openers/pi-rukas/issues/862)) ([ba090e1](https://github.com/trail-openers/pi-rukas/commit/ba090e1191609b7f25e253580d1eb7bbdaaebcad))

## [0.12.58](https://github.com/trail-openers/pi-rukas/compare/v0.12.57...v0.12.58) (2026-09-23)


### Features

* **work:** classify deliverables that legitimately produce no diff ([92ed17b](https://github.com/trail-openers/pi-rukas/commit/92ed17b9a8cbf34ef219e9c38a25f7b9e1fb821d))
* **work:** single bounded flake retry across all verify seams ([#782](https://github.com/trail-openers/pi-rukas/issues/782)) ([#796](https://github.com/trail-openers/pi-rukas/issues/796)) ([be997e4](https://github.com/trail-openers/pi-rukas/commit/be997e4f6b292dc9ac01b72c13303f99b36d8f29))


### Bug Fixes

* **deck:** batch members render once — Text projection is headers only ([#761](https://github.com/trail-openers/pi-rukas/issues/761)) ([#762](https://github.com/trail-openers/pi-rukas/issues/762)) ([bf59199](https://github.com/trail-openers/pi-rukas/commit/bf59199351d44c03fd79264a7b774045a19d40a7))
* **handoff:** label the issue as well as the PR, and record the target ([#802](https://github.com/trail-openers/pi-rukas/issues/802)) ([2157642](https://github.com/trail-openers/pi-rukas/commit/2157642c537c2cab53baa48972c4b7a126f8e837))
* **handoff:** verify the label by reading it back, not by asserting it ([#793](https://github.com/trail-openers/pi-rukas/issues/793)) ([3614be5](https://github.com/trail-openers/pi-rukas/commit/3614be596a58ea78cc4f489be72d9b24e4ff1f03))
* **provision:** verify hook and symlink outcomes on the filesystem ([#805](https://github.com/trail-openers/pi-rukas/issues/805)) ([1320f86](https://github.com/trail-openers/pi-rukas/commit/1320f86c187797b45d13ee3d765a5b21f091cc40))
* **verify:** run every test and report all failures instead of exiting at the first ([#804](https://github.com/trail-openers/pi-rukas/issues/804)) ([76e1e75](https://github.com/trail-openers/pi-rukas/commit/76e1e75658381d4af65329c49336889f97c18aae))
* **work:** bound the plan dispatch with its own timeout ([7eca58b](https://github.com/trail-openers/pi-rukas/commit/7eca58b2d0fdea78a8889929aee8e48d566d3572))
* **work:** classify consolidated-tree verify failures (consolidation-created / per-workstream / needs-human) — [#777](https://github.com/trail-openers/pi-rukas/issues/777) ([#781](https://github.com/trail-openers/pi-rukas/issues/781)) ([2b2bcc3](https://github.com/trail-openers/pi-rukas/commit/2b2bcc3d37a0968a56a128962812d10841f5d1fb))
* **work:** committed-work-aware lens-fix detection ([#749](https://github.com/trail-openers/pi-rukas/issues/749)) ([#764](https://github.com/trail-openers/pi-rukas/issues/764)) ([96c26f6](https://github.com/trail-openers/pi-rukas/commit/96c26f6d0c7e2c49577d893f1b9c488ab2c1e4e1))
* **work:** complete lens-fix integration (untracked debris, PR-create ref, conflict-park SHA) — [#776](https://github.com/trail-openers/pi-rukas/issues/776) ([#779](https://github.com/trail-openers/pi-rukas/issues/779)) ([199d5fb](https://github.com/trail-openers/pi-rukas/commit/199d5fbe4c19c86ab004725843cb3814487bfdce))
* **work:** consolidation verifier rename+annotation false positive — [#744](https://github.com/trail-openers/pi-rukas/issues/744), [#778](https://github.com/trail-openers/pi-rukas/issues/778) ([#780](https://github.com/trail-openers/pi-rukas/issues/780)) ([c038134](https://github.com/trail-openers/pi-rukas/commit/c03813468f23a505be4fe1e77de85168f44df241))
* **work:** deliver the terminal driver line reliably and record single-issue outcomes ([6f6b577](https://github.com/trail-openers/pi-rukas/commit/6f6b577cc76d61b1ec8f4b3f0bf6d9e5be00595f))
* **work:** derive conventional PR titles from the issue ([3bf377c](https://github.com/trail-openers/pi-rukas/commit/3bf377c9a3dea13a85026c42c4489de674f52c4c))
* **work:** derive the consolidation commit subject from the issue ([5073dcf](https://github.com/trail-openers/pi-rukas/commit/5073dcfef3697c18f873cb547de8eabcc146696a))
* **work:** exempt a workstream's own declared file from its scope fence ([#790](https://github.com/trail-openers/pi-rukas/issues/790)) ([2a0fa6b](https://github.com/trail-openers/pi-rukas/commit/2a0fa6b829184ed348fcddb3e597e3edead2f5fd))
* **work:** give every develop dispatch an explicit worktree and block a dirty root early ([#806](https://github.com/trail-openers/pi-rukas/issues/806)) ([94c7f0a](https://github.com/trail-openers/pi-rukas/commit/94c7f0a435f1d54d0005df6b0574155f343d2bf6))
* **work:** record deferred worktree creation failure with git detail, park on dirty leftover ([#753](https://github.com/trail-openers/pi-rukas/issues/753)) ([#756](https://github.com/trail-openers/pi-rukas/issues/756)) ([7a3b866](https://github.com/trail-openers/pi-rukas/commit/7a3b8663c29b58dcc8ad1c6a72dded651b825a12))
* **work:** replay stacked workstream commits against their own base ([c216261](https://github.com/trail-openers/pi-rukas/commit/c216261fa683272feab55a257d8ff2f368a498b3)), closes [#794](https://github.com/trail-openers/pi-rukas/issues/794)
* **work:** report the real failing assertion and retry a shared flake once ([941424a](https://github.com/trail-openers/pi-rukas/commit/941424acae84d161c2b467157316900c9e7f5c8f))
* **work:** verified restore on consolidation abort — stop claiming a restore that did not happen ([#750](https://github.com/trail-openers/pi-rukas/issues/750)) ([#766](https://github.com/trail-openers/pi-rukas/issues/766)) ([a0093e3](https://github.com/trail-openers/pi-rukas/commit/a0093e39045c1ed58dee5988f865a99bb217e3ba))

## [0.12.57](https://github.com/trail-openers/pi-rukas/compare/v0.12.56...v0.12.57) (2026-09-16)


### Features

* **agents-md:** 7-section scaffold default — Context7 Protocol, answer-aware Testing Standards, size discipline ([#662](https://github.com/trail-openers/pi-rukas/issues/662)) ([db07670](https://github.com/trail-openers/pi-rukas/commit/db07670c0871032d4e8a55cb4e7a1c1e261c865c)), closes [#649](https://github.com/trail-openers/pi-rukas/issues/649)
* **agents-md:** add architecture-notes managed section ([#668](https://github.com/trail-openers/pi-rukas/issues/668)) ([#695](https://github.com/trail-openers/pi-rukas/issues/695)) ([fccf4f1](https://github.com/trail-openers/pi-rukas/commit/fccf4f139748088224591638cb36dcbd7299db8a))
* **agents-md:** close the [#697](https://github.com/trail-openers/pi-rukas/issues/697) chicken-and-egg UX gap (create-path bullets, 5th interview question, issue-list pre-pass) ([#698](https://github.com/trail-openers/pi-rukas/issues/698)) ([6450705](https://github.com/trail-openers/pi-rukas/commit/6450705eb5599803142e338f6dff501d7f91ea00))
* **agents-md:** consolidate issue-659 B1 workstreams (ledger provenance, code-style, agentOverride/refresh, churn-loop fix) ([#663](https://github.com/trail-openers/pi-rukas/issues/663)) ([8d62ab2](https://github.com/trail-openers/pi-rukas/commit/8d62ab28b64063da20e32d231fe3ba0620d3caa8)), closes [#659](https://github.com/trail-openers/pi-rukas/issues/659)
* **agents-md:** M2 heading-based section detection, one-pass migration strip, zero marker bytes ([#690](https://github.com/trail-openers/pi-rukas/issues/690)) ([f035bf4](https://github.com/trail-openers/pi-rukas/commit/f035bf40cb1f4ef56df5a5edfec2d90fb3701263))
* **agents-md:** move decision-ledger to git-tracked sidecar ([#680](https://github.com/trail-openers/pi-rukas/issues/680) M1) ([#688](https://github.com/trail-openers/pi-rukas/issues/688)) ([fb517eb](https://github.com/trail-openers/pi-rukas/commit/fb517eb53724e8ae08f43216be5b61f06c72706d))
* **agents-md:** wire agent-facts pre-pass data layer ([#660](https://github.com/trail-openers/pi-rukas/issues/660) B2) ([#666](https://github.com/trail-openers/pi-rukas/issues/666)) ([3891ab3](https://github.com/trail-openers/pi-rukas/commit/3891ab3f960298fe7c855598477818c7774b8656))
* **dispatch-deck:** interactive subagent UX — selectable deck, transcript viewer, human steer input ([#702](https://github.com/trail-openers/pi-rukas/issues/702)) ([2a57a4b](https://github.com/trail-openers/pi-rukas/commit/2a57a4bc3965e018fcb43be5f0c7742545f02760))
* **plan:** deterministic triage and gate defaults — precheck, draft validation, scoped round 2, no-gate chore/spike ([#642](https://github.com/trail-openers/pi-rukas/issues/642)) ([02656ca](https://github.com/trail-openers/pi-rukas/commit/02656ca10e862a1fba5ca6c61eac09542118f504))
* **plan:** trusted directive channels, spike/pin validation, duplicate-reversal vocabulary ([#648](https://github.com/trail-openers/pi-rukas/issues/648)) ([df5fd4e](https://github.com/trail-openers/pi-rukas/commit/df5fd4e658ccadb050dede9dfbdfa03627905275))
* **prompt:** narrow /start explore contract to synthesis-only tier ([#718](https://github.com/trail-openers/pi-rukas/issues/718)) ([9168476](https://github.com/trail-openers/pi-rukas/commit/91684762ea8da04c692ea3b44495bc451d35e3e6))
* **research:** [#655](https://github.com/trail-openers/pi-rukas/issues/655) measure develop-to-plan convergence and AC drift ([#737](https://github.com/trail-openers/pi-rukas/issues/737)) ([47086f4](https://github.com/trail-openers/pi-rukas/commit/47086f45e5ec0ff0dc014fefe46d1464f615ef48))
* **research:** compile the deterministic spine — start_research_driver with verification, artifact and provenance ([#643](https://github.com/trail-openers/pi-rukas/issues/643)) ([895250b](https://github.com/trail-openers/pi-rukas/commit/895250b968c6111a6ccd50e7c7104d1aecdad610))
* **research:** deep and adoption tiers — scoped entailment pass and the OSS decision memo ([#644](https://github.com/trail-openers/pi-rukas/issues/644)) ([aab2615](https://github.com/trail-openers/pi-rukas/commit/aab2615eb81a7997d3ca822dfec74143cd430ca6))
* **work:** [#679](https://github.com/trail-openers/pi-rukas/issues/679) fanout-decomposition — depends-on ordering, deferred worktrees, falsily-green gate, plan-quality rules ([#687](https://github.com/trail-openers/pi-rukas/issues/687)) ([f6bad22](https://github.com/trail-openers/pi-rukas/commit/f6bad225f453a97f346d4f096bdb04e011a06c3f))
* **work:** consolidated develop-time verify — [#669](https://github.com/trail-openers/pi-rukas/issues/669) ([#685](https://github.com/trail-openers/pi-rukas/issues/685)) ([65e535c](https://github.com/trail-openers/pi-rukas/commit/65e535c89f2e7d8818f8be2b0ab62794ae0ecaaa))
* **work:** end-of-develop converge gate — cross-check diff against plan deliverables (P2) ([#759](https://github.com/trail-openers/pi-rukas/issues/759)) ([4480455](https://github.com/trail-openers/pi-rukas/commit/4480455676a61537648487efa37ff7ebdc6bb788))
* **work:** event-log observability — park reason, step round, orphan sweep ([#657](https://github.com/trail-openers/pi-rukas/issues/657)) ([#738](https://github.com/trail-openers/pi-rukas/issues/738)) ([5a3f863](https://github.com/trail-openers/pi-rukas/commit/5a3f8633d7009d3ee4cef0ca4d915c91a2371f9d))
* **work:** mechanize the four lens-fix integration sub-shapes ([#706](https://github.com/trail-openers/pi-rukas/issues/706)) ([c8f43d8](https://github.com/trail-openers/pi-rukas/commit/c8f43d860c36b465b8feefcfc8a98058866e652c))
* **work:** pre-dispatch group-overlap gate serializes predicted path conflicts ([#683](https://github.com/trail-openers/pi-rukas/issues/683)) ([e7625c3](https://github.com/trail-openers/pi-rukas/commit/e7625c3eac5eee8a5fb5bc5bc781e53c45753b2d))
* **work:** resolve verify-cmd once per workstream and thread into develop prompt ([#751](https://github.com/trail-openers/pi-rukas/issues/751)) ([#757](https://github.com/trail-openers/pi-rukas/issues/757)) ([fe69f77](https://github.com/trail-openers/pi-rukas/commit/fe69f7774097912fc84514ecff36a9c860cdaf4b))


### Bug Fixes

* **commands:** sticky preamble names start_research_driver — close the hand-rolled research fan-out gap ([#646](https://github.com/trail-openers/pi-rukas/issues/646)) ([209dedb](https://github.com/trail-openers/pi-rukas/commit/209dedb83c5cf90728dd2745e6b8af2cc4858a20))
* **deck:** remove per-job Text rows — SelectList is the sole per-job surface ([#755](https://github.com/trail-openers/pi-rukas/issues/755)) ([4b20ca3](https://github.com/trail-openers/pi-rukas/commit/4b20ca30edccae8cf87a17e3a313a04f3f14e503))
* **devcontainer:** make glab install architecture-neutral, close prerequisite-drift blind spot ([#661](https://github.com/trail-openers/pi-rukas/issues/661)) ([6e90ef7](https://github.com/trail-openers/pi-rukas/commit/6e90ef78e5fcfb225d00d500df9922d10a1b5939)), closes [#645](https://github.com/trail-openers/pi-rukas/issues/645)
* **devcontainer:** pin pi-mcp-adapter@2.32.1 — stop npm-12 EALLOWREMOTE image builds ([#719](https://github.com/trail-openers/pi-rukas/issues/719)) ([61c26f5](https://github.com/trail-openers/pi-rukas/commit/61c26f52e916ae9bcad426ec62071db6713c2e97))
* **dispatch-deck:** collapse dual widgets into a single composite key ([#729](https://github.com/trail-openers/pi-rukas/issues/729)) ([#734](https://github.com/trail-openers/pi-rukas/issues/734)) ([eb873c4](https://github.com/trail-openers/pi-rukas/commit/eb873c468cffe1cb2581b9852fa429f9f1f88055))
* **plan:** clip sub-issue text, never structure ([#673](https://github.com/trail-openers/pi-rukas/issues/673)) ([d6f2427](https://github.com/trail-openers/pi-rukas/commit/d6f2427d08d7a27e5215680c058dd9349125a812))
* **plan:** CRITICAL-only terminal rule for the /plan gap gate ([#637](https://github.com/trail-openers/pi-rukas/issues/637)) ([12ed01f](https://github.com/trail-openers/pi-rukas/commit/12ed01f728187077f0b1ced0385379425091cf55))
* **plan:** deterministic body budget — specs must fit the forge ([#658](https://github.com/trail-openers/pi-rukas/issues/658)) ([5e2b09f](https://github.com/trail-openers/pi-rukas/commit/5e2b09f79e1265150a7969c3b15764892ce346a4))
* **plan:** directive-block grammar — terminators, fences, no mid-prose hijack ([#670](https://github.com/trail-openers/pi-rukas/issues/670)) ([9f85fa2](https://github.com/trail-openers/pi-rukas/commit/9f85fa21777254c5a06595ca8c247dcaf9fc3321))
* **plan:** disclosure and delivery defects from the vipune fixture run — visible halts, clipped context, working writeback, honest duplicate parse, 30-min bound ([#647](https://github.com/trail-openers/pi-rukas/issues/647)) ([6b2e019](https://github.com/trail-openers/pi-rukas/commit/6b2e01954521581c6eac81df9a083eca0aa22843))
* **plan:** gap gate fails closed on an unparseable review ([#650](https://github.com/trail-openers/pi-rukas/issues/650)) ([50c6241](https://github.com/trail-openers/pi-rukas/commit/50c624111947204bda19176589bb5b6d7c914bdd))
* **plan:** operator context survives into child prompts ([#675](https://github.com/trail-openers/pi-rukas/issues/675)) ([81f9652](https://github.com/trail-openers/pi-rukas/commit/81f9652f97b6b81d4ab5c21c352c313bcc411736))
* **plan:** reconcile epic sub-issues across angles and write resolutions back ([#640](https://github.com/trail-openers/pi-rukas/issues/640)) ([e4135c4](https://github.com/trail-openers/pi-rukas/commit/e4135c420a11512801a6b2260991039568401bbb))
* **plan:** remove invalid --json from forge create commands; route gap-gate cap at zero CRITICAL/HIGH ([#635](https://github.com/trail-openers/pi-rukas/issues/635)) ([b7ce3eb](https://github.com/trail-openers/pi-rukas/commit/b7ce3eb650f88b77d58a6e309b7cbd7cace5bf1e))
* **plan:** structured tool-call output replaces prose line-splitting ([#633](https://github.com/trail-openers/pi-rukas/issues/633)) ([5f45f57](https://github.com/trail-openers/pi-rukas/commit/5f45f57f4fb84cdce2af1d5168129444a2012264))
* **plan:** writeback splice boundary, provenance marker, edit-verb guard ([#671](https://github.com/trail-openers/pi-rukas/issues/671)) ([3236719](https://github.com/trail-openers/pi-rukas/commit/32367193d0de655035f07c550c9abeb4843c7d60))
* **spawn:** prevent interactive git from hanging agent children ([#700](https://github.com/trail-openers/pi-rukas/issues/700)) ([88638da](https://github.com/trail-openers/pi-rukas/commit/88638da459ca11b4a7bd8027feab6a35813b12bf))
* **work:** /start — permission-safe state check; refused sources reported, not narrated ([#740](https://github.com/trail-openers/pi-rukas/issues/740)) ([568ab15](https://github.com/trail-openers/pi-rukas/commit/568ab158ee068736d549c17b28f5c99b49b14c09))
* **work:** a merge hold reaches its declared handoff — cap routing before the terminal short-circuit ([#651](https://github.com/trail-openers/pi-rukas/issues/651)) ([305fe40](https://github.com/trail-openers/pi-rukas/commit/305fe40dda9d97ed6d94e9e024282cfa35b578e4))
* **work:** attribute verify-cmd evidence tails and fix commandAvailable PATH propagation ([#726](https://github.com/trail-openers/pi-rukas/issues/726)) ([01a1afd](https://github.com/trail-openers/pi-rukas/commit/01a1afdacd23eacb62c2ce3c09883f4e9a21184a))
* **work:** clear same-issue worktree residue on --restart ([#735](https://github.com/trail-openers/pi-rukas/issues/735)) ([d34365b](https://github.com/trail-openers/pi-rukas/commit/d34365b4b48e0e2f19529d50d2064b50b48147b4))
* **work:** correct develop-step scope/fanout gate derivation ([#672](https://github.com/trail-openers/pi-rukas/issues/672)) ([#684](https://github.com/trail-openers/pi-rukas/issues/684)) ([a6ed511](https://github.com/trail-openers/pi-rukas/commit/a6ed5111299042895b09b1fc6c7816cd3f8e7c04))
* **work:** detect and fix partial consolidation of multi-commit workstreams ([#728](https://github.com/trail-openers/pi-rukas/issues/728)) ([#733](https://github.com/trail-openers/pi-rukas/issues/733)) ([76e89d9](https://github.com/trail-openers/pi-rukas/commit/76e89d99489adb942f4fc94ea07fa09d17490706))
* **work:** handoff robustness — worktree consolidation + forge post retry ([#674](https://github.com/trail-openers/pi-rukas/issues/674)) ([#686](https://github.com/trail-openers/pi-rukas/issues/686)) ([e5b13fe](https://github.com/trail-openers/pi-rukas/commit/e5b13fe00162b6ef95dddc87e2dd8947e3f2e382))
* **work:** merge-evidence gate — drop unsupported isRequired, tag tooling failures distinctly ([#748](https://github.com/trail-openers/pi-rukas/issues/748)) ([ac498fd](https://github.com/trail-openers/pi-rukas/commit/ac498fda2e748694c7b237cf16b843ddd36996a4))
* **work:** offload-spec recovery at the explore/intent-parse seam ([#694](https://github.com/trail-openers/pi-rukas/issues/694)) ([453eedc](https://github.com/trail-openers/pi-rukas/commit/453eedcb6a389526db38f8785742a0944909afe5))
* **work:** plan corrective prompt — prior conflicts are historical, do not re-verify ([#657](https://github.com/trail-openers/pi-rukas/issues/657)) ([#739](https://github.com/trail-openers/pi-rukas/issues/739)) ([148b98d](https://github.com/trail-openers/pi-rukas/commit/148b98d22be8a7232a9e956a882f4c26a476f58b))
* **work:** re-entry idempotence at the mechanized seams ([#652](https://github.com/trail-openers/pi-rukas/issues/652)) ([f550f66](https://github.com/trail-openers/pi-rukas/commit/f550f66f0ba856b6c7dbbfcad71a9df634afdf09))
* **work:** recalibrate develop fanout gate to count undeclared files only ([#724](https://github.com/trail-openers/pi-rukas/issues/724)) ([#732](https://github.com/trail-openers/pi-rukas/issues/732)) ([063547a](https://github.com/trail-openers/pi-rukas/commit/063547a6e842d86379517274da7e3a85345a4688))
* **work:** stop consolidated verify false-positing on cross-declared outOfScope fences ([#725](https://github.com/trail-openers/pi-rukas/issues/725)) ([#731](https://github.com/trail-openers/pi-rukas/issues/731)) ([eada75e](https://github.com/trail-openers/pi-rukas/commit/eada75e86ec97869491f3398fdba386fe5398b1a))


### Performance Improvements

* **plan:** collapse the serial dispatch tax — one investigate barrier, bounded children, per-phase timings ([#641](https://github.com/trail-openers/pi-rukas/issues/641)) ([56f3b0a](https://github.com/trail-openers/pi-rukas/commit/56f3b0ad4cf2be7d23ce1a8c0d2e85a9c725daa3))

## [0.12.56](https://github.com/trail-openers/pi-rukas/compare/v0.12.55...v0.12.56) (2026-09-08)


### Features

* **forge:** add forge detection module for dual-forge support ([#616](https://github.com/trail-openers/pi-rukas/issues/616)) ([afb6097](https://github.com/trail-openers/pi-rukas/commit/afb6097585294cfca51d790b3405b264e5602ac0)), closes [#609](https://github.com/trail-openers/pi-rukas/issues/609)
* **forge:** add glab guard and permission patterns ([#617](https://github.com/trail-openers/pi-rukas/issues/617)) ([22dd0c3](https://github.com/trail-openers/pi-rukas/commit/22dd0c3faba641f13c2b7a6a4cd9e00c0b80edd3)), closes [#611](https://github.com/trail-openers/pi-rukas/issues/611)
* **forge:** forge adapter layer (forge.ts) ([#619](https://github.com/trail-openers/pi-rukas/issues/619)) ([c27957c](https://github.com/trail-openers/pi-rukas/commit/c27957ca287099df8315d0cad338137da214998f)), closes [#610](https://github.com/trail-openers/pi-rukas/issues/610)
* **rename:** atomic identity rename pi-ensemble → pi-rukas ([#628](https://github.com/trail-openers/pi-rukas/issues/628)) ([9e84be1](https://github.com/trail-openers/pi-rukas/commit/9e84be1f411f9f1aedc21bef8cc79b99d144ea92))


### Bug Fixes

* **plan:** gap-gate parser treats absence summaries as literal gaps ([#632](https://github.com/trail-openers/pi-rukas/issues/632)) ([83aa0dd](https://github.com/trail-openers/pi-rukas/commit/83aa0ddf0909f6c23efddf3df377a4e8dabf8d7c))
* **work:** developer commit doctrine + safety net ([#625](https://github.com/trail-openers/pi-rukas/issues/625)) ([b8af99d](https://github.com/trail-openers/pi-rukas/commit/b8af99deac753c4bb9bbccc12be4c9aa332a0537))
* **work:** restore intent verdict from spec artifact with strict validation ([#603](https://github.com/trail-openers/pi-rukas/issues/603)) ([bdaf15e](https://github.com/trail-openers/pi-rukas/commit/bdaf15e58fbbc7570cc3098935af273b34a0eb1f))

## [0.12.55](https://github.com/randomm/pi-ensemble/compare/v0.12.54...v0.12.55) (2026-08-31)


### Features

* **dispatch:** resume interrupted provider turns from checkpoint ([#595](https://github.com/randomm/pi-ensemble/issues/595)) ([5c9f4ca](https://github.com/randomm/pi-ensemble/commit/5c9f4ca70af4a3699b0782b3a9d49ca575dfb046))
* **permissions:** mode-independent PM bash allowlist guard ([#601](https://github.com/randomm/pi-ensemble/issues/601)) ([b316f3e](https://github.com/randomm/pi-ensemble/commit/b316f3e8c158f13c811c45b557f454189d92017f))
* **plan:** compiled plan driver that gates issue creation behind /plan ([#599](https://github.com/randomm/pi-ensemble/issues/599)) ([a62d402](https://github.com/randomm/pi-ensemble/commit/a62d402f3f94048209c7408145f6c2851f522182)), closes [#598](https://github.com/randomm/pi-ensemble/issues/598)
* **pm:** strip edit/write via setActiveTools when PM mode is active ([#593](https://github.com/randomm/pi-ensemble/issues/593)) ([4d98efd](https://github.com/randomm/pi-ensemble/commit/4d98efde7706ce33bea9fb8e9b4f52d6d2811210))
* **work:** seam escalation + invariant guard memory ([#280](https://github.com/randomm/pi-ensemble/issues/280)) ([#585](https://github.com/randomm/pi-ensemble/issues/585)) ([c2fa545](https://github.com/randomm/pi-ensemble/commit/c2fa5453fbb4d419b1fcdfae60186622aa26383e))


### Bug Fixes

* **work:** guard handoff delivery against re-send + driver-event envelope ([#580](https://github.com/randomm/pi-ensemble/issues/580)) ([#596](https://github.com/randomm/pi-ensemble/issues/596)) ([5330c2a](https://github.com/randomm/pi-ensemble/commit/5330c2a987cef4e66f0a0fa389be92ca0f07183a))
* **work:** strengthen anti-polling language in start_work_driver ([#586](https://github.com/randomm/pi-ensemble/issues/586)) ([3cba355](https://github.com/randomm/pi-ensemble/commit/3cba3555d16b08e782923360632ffffe5cf90617))

## [0.12.54](https://github.com/randomm/pi-ensemble/compare/v0.12.53...v0.12.54) (2026-08-29)


### Bug Fixes

* **install:** pin the Pi CLI to a minimum version across all install surfaces ([#581](https://github.com/randomm/pi-ensemble/issues/581)) ([e830272](https://github.com/randomm/pi-ensemble/commit/e830272ebf6a3f2328b0122b61be945db61ba851))
* **smoke-tests:** widen test-pi-shape-live to cover toolCall and tool_execution_start shapes ([#579](https://github.com/randomm/pi-ensemble/issues/579)) ([b5fa327](https://github.com/randomm/pi-ensemble/commit/b5fa327b3cc745083b3799182b87e16845f4b1be)), closes [#319](https://github.com/randomm/pi-ensemble/issues/319)
* **test:** update test-worktree-stale-restart.ts for fromRef parameter ([#584](https://github.com/randomm/pi-ensemble/issues/584)) ([c5f9ac5](https://github.com/randomm/pi-ensemble/commit/c5f9ac55e164e730072d0af2a663de128fe23fb1))
* **work:** prevent cross-group file ownership conflicts ([#571](https://github.com/randomm/pi-ensemble/issues/571)) ([#583](https://github.com/randomm/pi-ensemble/issues/583)) ([5c7f3d0](https://github.com/randomm/pi-ensemble/commit/5c7f3d0063774981f0b0dc4c8c7290210e95bfdc))

## [0.12.53](https://github.com/randomm/pi-ensemble/compare/v0.12.52...v0.12.53) (2026-08-28)


### Features

* **deck:** per-cycle cost roll-up with cache hit rate ([#538](https://github.com/randomm/pi-ensemble/issues/538)) ([173d46e](https://github.com/randomm/pi-ensemble/commit/173d46e4a2ef00e1da4843adee8463d226aa9a5b))
* **ops:** add irreversibility and post-condition doctrine to ops prompt ([#565](https://github.com/randomm/pi-ensemble/issues/565)) ([569d8a0](https://github.com/randomm/pi-ensemble/commit/569d8a0fdeaeffa64b470bdfd2633c0ac918372f)), closes [#344](https://github.com/randomm/pi-ensemble/issues/344)
* **prompts:** gate issue creation on PM role with doctrine canary ([#529](https://github.com/randomm/pi-ensemble/issues/529)) ([723e875](https://github.com/randomm/pi-ensemble/commit/723e87591a4d9297f857906c74d3e33859cfebdb))
* **test:** ratchet against deleted test blocks ([#563](https://github.com/randomm/pi-ensemble/issues/563)) ([c8f5676](https://github.com/randomm/pi-ensemble/commit/c8f56767a3c62d59d2528dc7419a411776736284))
* **work:** capability-preserving dispatch caps — loop detector, steer seam, typed cap causes ([#544](https://github.com/randomm/pi-ensemble/issues/544)) ([cbb2f5a](https://github.com/randomm/pi-ensemble/commit/cbb2f5ae4f6f5a5801a8c933f02782f068c4ebc1))
* **work:** clean up stale worktrees and build artifacts at run end ([#560](https://github.com/randomm/pi-ensemble/issues/560)) ([a5ff182](https://github.com/randomm/pi-ensemble/commit/a5ff182de3d19c8d5552fdeccd5b8f4f6ea3c715))
* **work:** consolidation gate — subsumption-aware verdict, both-sides report ([#541](https://github.com/randomm/pi-ensemble/issues/541)) ([d092d02](https://github.com/randomm/pi-ensemble/commit/d092d0257cafcdeb7e703de1dc081bacf27b1534))
* **work:** persist lens findings, per-lens timing, and surface in PR ([#456](https://github.com/randomm/pi-ensemble/issues/456)) ([#561](https://github.com/randomm/pi-ensemble/issues/561)) ([bc16697](https://github.com/randomm/pi-ensemble/commit/bc16697a51f0f3adffa349a45a87d1fe9e4cbaf5))
* **work:** revert MAX_PARALLEL_GROUPS_DEFAULT to 3 ([#547](https://github.com/randomm/pi-ensemble/issues/547)) ([#556](https://github.com/randomm/pi-ensemble/issues/556)) ([9791171](https://github.com/randomm/pi-ensemble/commit/9791171d9c9246dbf234494dc6f5b54bd2286816))
* **work:** scope-fanout gate — fail develop verification on declared-path violations ([#576](https://github.com/randomm/pi-ensemble/issues/576)) ([ef2a57c](https://github.com/randomm/pi-ensemble/commit/ef2a57c69e9c4faef9f6e24b5c6783d4bd8082e7))
* **work:** validate state-file discriminants at read; name unknown steps in the loop ([#533](https://github.com/randomm/pi-ensemble/issues/533)) ([#537](https://github.com/randomm/pi-ensemble/issues/537)) ([ef690d3](https://github.com/randomm/pi-ensemble/commit/ef690d33cab82abe4479c48638140c8ebea17c74))


### Bug Fixes

* **adversarial:** enforce wall-clock budget in phase retry loop ([#357](https://github.com/randomm/pi-ensemble/issues/357)) ([#557](https://github.com/randomm/pi-ensemble/issues/557)) ([cf04954](https://github.com/randomm/pi-ensemble/commit/cf04954009362eadf563eb0fc64b27002edbce51))
* **agents:** remove ops blanket gh api grant, add explicit PR mutations ([#341](https://github.com/randomm/pi-ensemble/issues/341)) ([#567](https://github.com/randomm/pi-ensemble/issues/567)) ([fec2579](https://github.com/randomm/pi-ensemble/commit/fec25795b794c65096ce36fa2b37c81a93a70a30))
* **dispatch:** prevent PM async status polling loops ([#553](https://github.com/randomm/pi-ensemble/issues/553)) ([1f7a0ff](https://github.com/randomm/pi-ensemble/commit/1f7a0ff72b9f958753e829035d43b10a987f0130))
* **dispatch:** tag possible mid-stream truncation and nudge long runs ([#555](https://github.com/randomm/pi-ensemble/issues/555)) ([d1b2813](https://github.com/randomm/pi-ensemble/commit/d1b2813ad1cf22e69c26185cb26653d5619c0ef3))
* **modules:** developer.md bug-fix TDD ritual - failing test… ([#549](https://github.com/randomm/pi-ensemble/issues/549)) ([32ef469](https://github.com/randomm/pi-ensemble/commit/32ef469eeba829fce32c8c1fac68c55d25b7bfc0))
* **modules:** replace command-substitution and piped recipes in ops CI + issue-fallback doctrine ([#343](https://github.com/randomm/pi-ensemble/issues/343)) ([#575](https://github.com/randomm/pi-ensemble/issues/575)) ([e0956c0](https://github.com/randomm/pi-ensemble/commit/e0956c094b0f41fde506e70d73eb734acc0604bf))
* **ops:** ground CI branch selection and fallback staging fences ([#564](https://github.com/randomm/pi-ensemble/issues/564)) ([dbe8373](https://github.com/randomm/pi-ensemble/commit/dbe83735caee6916609b982176c074d93842b4a1))
* **ops:** resolve lens findings — qualitative rationale, explicit terminal state ([#344](https://github.com/randomm/pi-ensemble/issues/344)) ([#568](https://github.com/randomm/pi-ensemble/issues/568)) ([d0cac87](https://github.com/randomm/pi-ensemble/commit/d0cac871e1e7fc1e34cbafba6c89c34546c66861))
* **test:** isolate model-picker test from the real ensemble-models.json ([#569](https://github.com/randomm/pi-ensemble/issues/569)) ([b097efd](https://github.com/randomm/pi-ensemble/commit/b097efd1b97d08f2ed43153edf02fd45d742d9b9))
* **test:** pin the fanout mode-derivation assertion to an explicit cap ([#548](https://github.com/randomm/pi-ensemble/issues/548)) ([bba1499](https://github.com/randomm/pi-ensemble/commit/bba1499f2f06a7836235b8b3f2f7e6eb638e0da2))
* **work:** branch-step diagnostics — trace the ops-fallback… ([#558](https://github.com/randomm/pi-ensemble/issues/558)) ([8b226a5](https://github.com/randomm/pi-ensemble/commit/8b226a54e58b1c7e0977de52b3688eb6243b07bf))
* **work:** carry assumptions and adversarial findings through commit-pr fallback ([#455](https://github.com/randomm/pi-ensemble/issues/455)) ([#562](https://github.com/randomm/pi-ensemble/issues/562)) ([99aea28](https://github.com/randomm/pi-ensemble/commit/99aea28c055340a043c7c6b248e71c374f8c3097))
* **work:** commit-pr fallback cause, dirty-preflight plumb, untracked-dirt handoff truth ([#542](https://github.com/randomm/pi-ensemble/issues/542)) ([7fb03d9](https://github.com/randomm/pi-ensemble/commit/7fb03d9be759f4f460b2fbe97c4c8a6f467b9ca5))
* **work:** honor proceed-with-assumptions unless a load-bearing claim is contradicted ([#577](https://github.com/randomm/pi-ensemble/issues/577)) ([f2e6316](https://github.com/randomm/pi-ensemble/commit/f2e6316540fb00a1473865820728dd6dbf8b6d31)), closes [#574](https://github.com/randomm/pi-ensemble/issues/574)
* **work:** post-merge verification transient failure returns success-with-warning-note ([#551](https://github.com/randomm/pi-ensemble/issues/551)) ([24ff952](https://github.com/randomm/pi-ensemble/commit/24ff952f7c0c0fc8c783d3383a3a43ede1928e28))
* **work:** provision worktrees — commit the hook, survive failed fetch ([#535](https://github.com/randomm/pi-ensemble/issues/535)) ([d4ce76f](https://github.com/randomm/pi-ensemble/commit/d4ce76f0175f8c0a4a06f479edf31c72952a75c8))
* **work:** recover stale same-issue worktrees at branch setup ([#552](https://github.com/randomm/pi-ensemble/issues/552)) ([56342d0](https://github.com/randomm/pi-ensemble/commit/56342d0f7b71f4671f202738ebc93b05f4153cbf))

## [0.12.52](https://github.com/randomm/pi-ensemble/compare/v0.12.51...v0.12.52) (2026-08-23)


### Features

* **agents-md:** idempotent AGENTS.md command with pure renderer and marker-safe splice ([#524](https://github.com/randomm/pi-ensemble/issues/524)) ([7b47907](https://github.com/randomm/pi-ensemble/commit/7b479074b0c145325dd6365c9876befc3a394f4e))


### Bug Fixes

* **agents-md:** wire agents_md_run tool for host-repo delivery + brownfield wrap ([#527](https://github.com/randomm/pi-ensemble/issues/527)) ([f2c86da](https://github.com/randomm/pi-ensemble/commit/f2c86dafc4cfd3857eddbfdb96c18316bd6ce5e1)), closes [#526](https://github.com/randomm/pi-ensemble/issues/526)

## [0.12.51](https://github.com/randomm/pi-ensemble/compare/v0.12.50...v0.12.51) (2026-08-23)


### Bug Fixes

* **#504:** replace process.env.X = undefined with delete for bun 1.4 compat ([#520](https://github.com/randomm/pi-ensemble/issues/520)) ([2ab483b](https://github.com/randomm/pi-ensemble/commit/2ab483b450eb391a19a7cc7edbdfd4de1e5ff780)), closes [#504](https://github.com/randomm/pi-ensemble/issues/504)

## [0.12.50](https://github.com/randomm/pi-ensemble/compare/v0.12.49...v0.12.50) (2026-08-22)


### Bug Fixes

* **#492:** classify lens-fix-not-integrated cause with git evidence ([#516](https://github.com/randomm/pi-ensemble/issues/516)) ([8045f88](https://github.com/randomm/pi-ensemble/commit/8045f88f483c534753cc17779edcba074593ce61)), closes [#492](https://github.com/randomm/pi-ensemble/issues/492)
* **#499:** handoff recovery commands stage untracked files before diffing ([#514](https://github.com/randomm/pi-ensemble/issues/514)) ([5e16ed8](https://github.com/randomm/pi-ensemble/commit/5e16ed867365fbce1786f6602847a765c695fe3c)), closes [#499](https://github.com/randomm/pi-ensemble/issues/499)

## [0.12.49](https://github.com/randomm/pi-ensemble/compare/v0.12.48...v0.12.49) (2026-08-22)


### Bug Fixes

* **#508:** doctrine no longer prescribes issue-number-in-scope commit headers ([#510](https://github.com/randomm/pi-ensemble/issues/510)) ([50a713e](https://github.com/randomm/pi-ensemble/commit/50a713e90a1376f61667deb86b4ce2d3c4745d1b)), closes [#508](https://github.com/randomm/pi-ensemble/issues/508)
* **work-driver:** a failed commit-pr fallback leaves repoRoot conflicted ([#509](https://github.com/randomm/pi-ensemble/issues/509)) ([34c90ad](https://github.com/randomm/pi-ensemble/commit/34c90ad0f7de5af2749befd750805ae358b48f40))
* **work-driver:** grouping rule R4 joins on a scope tag that nearly ever ([#511](https://github.com/randomm/pi-ensemble/issues/511)) ([9424871](https://github.com/randomm/pi-ensemble/commit/94248718c85fceb1a5cd51e23c9429d09191c240))

## [0.12.48](https://github.com/randomm/pi-ensemble/compare/v0.12.47...v0.12.48) (2026-08-21)


### Bug Fixes

* **#485,#486:** record the adversarial gate's outcome faithfully and retry infra failures per workstream ([#495](https://github.com/randomm/pi-ensemble/issues/495)) ([023917f](https://github.com/randomm/pi-ensemble/commit/023917f3e6cd00e73dca39b8de772df7f2a2c7cb))

## [0.12.47](https://github.com/randomm/pi-ensemble/compare/v0.12.46...v0.12.47) (2026-08-21)


### Bug Fixes

* **#502:** stamp the model config by content hash, not mtime and size ([#503](https://github.com/randomm/pi-ensemble/issues/503)) ([19b5e68](https://github.com/randomm/pi-ensemble/commit/19b5e682f73c2baceb0d7ae15cd87b6eec33bda1))

## [0.12.46](https://github.com/randomm/pi-ensemble/compare/v0.12.45...v0.12.46) (2026-08-20)


### Bug Fixes

* **#475:** refuse the worktree pre-remove when it would destroy unrecoverable work ([#497](https://github.com/randomm/pi-ensemble/issues/497)) ([b77b0e5](https://github.com/randomm/pi-ensemble/commit/b77b0e590eac3356cf699d8345a438486bca847c))
* **#481:** provision nested dependency directories, and stop reporting empty ones as linked ([#494](https://github.com/randomm/pi-ensemble/issues/494)) ([24bf1de](https://github.com/randomm/pi-ensemble/commit/24bf1dec0e6342e7f65bdd00f2d58d5e9800341e))
* **#483:** keep a test and its subject in the same workstream ([#496](https://github.com/randomm/pi-ensemble/issues/496)) ([5500b99](https://github.com/randomm/pi-ensemble/commit/5500b99d8294390d769710893a5e198dd3e1a511))

## [0.12.45](https://github.com/randomm/pi-ensemble/compare/v0.12.44...v0.12.45) (2026-08-19)


### Bug Fixes

* **work-driver:** un-gate restoreCheckout on production merge ([#480](https://github.com/randomm/pi-ensemble/issues/480)) ([6d2f4e7](https://github.com/randomm/pi-ensemble/commit/6d2f4e73e955b8479366b0082b2114648f469e1b))

## [0.12.44](https://github.com/randomm/pi-ensemble/compare/v0.12.43...v0.12.44) (2026-08-14)


### Bug Fixes

* **#700:** retry the issue-body fetch, with a per-attempt deadline ([#471](https://github.com/randomm/pi-ensemble/issues/471)) ([180c94d](https://github.com/randomm/pi-ensemble/commit/180c94d0b988d90a74c70ccf4c57fbe5c8c8c686))
* **review:** route a non-critical round cap to ci instead of parking ([#474](https://github.com/randomm/pi-ensemble/issues/474)) ([d1a9304](https://github.com/randomm/pi-ensemble/commit/d1a93042ac31eff88a489975149a02e213506393))
* **work-driver:** bound the handoff dispatch, fall back to in-process gh ([#472](https://github.com/randomm/pi-ensemble/issues/472)) ([d045e7a](https://github.com/randomm/pi-ensemble/commit/d045e7acd0dd90ff05f9c538865dc700b86e1b36))
* **work-driver:** make the develop speculative explore opt-in ([#470](https://github.com/randomm/pi-ensemble/issues/470)) ([13c1deb](https://github.com/randomm/pi-ensemble/commit/13c1deb62b477e6897a84d93a971037c379fa7d6))

## [0.12.43](https://github.com/randomm/pi-ensemble/compare/v0.12.42...v0.12.43) (2026-08-13)


### Features

* make an inactivity kill diagnosable instead of tuning it ([#469](https://github.com/randomm/pi-ensemble/issues/469)) ([549c066](https://github.com/randomm/pi-ensemble/commit/549c06625e0bb4b1f6842715184bca65e269df05))
* refuse working-tree-discarding git inside subagents ([#467](https://github.com/randomm/pi-ensemble/issues/467)) ([14a57a2](https://github.com/randomm/pi-ensemble/commit/14a57a2423f72545488d511f5653dbed7029c07b))


### Bug Fixes

* a comma inside a parenthetical is not a list separator ([#465](https://github.com/randomm/pi-ensemble/issues/465)) ([4c50a93](https://github.com/randomm/pi-ensemble/commit/4c50a93cd932f106d1f51b6c855694c4e2c58e86))
* let the review gate pass, and stop reviewing a branch that never moved ([#462](https://github.com/randomm/pi-ensemble/issues/462)) ([3e8c2f4](https://github.com/randomm/pi-ensemble/commit/3e8c2f4849ed8001b4fc1b6557f385e4dfe2a047))
* stop staging our own worktree scaffolding into the PR ([#461](https://github.com/randomm/pi-ensemble/issues/461)) ([359803d](https://github.com/randomm/pi-ensemble/commit/359803d9b7cac80d7873239592c5f30a25138fcc))
* the handoff prints what the review found, and admits our own kills ([#463](https://github.com/randomm/pi-ensemble/issues/463)) ([a126dac](https://github.com/randomm/pi-ensemble/commit/a126dac0c4caa933e31135d164f85e83a83a01b2))
* the queue stops reporting live cycles as parked ([#466](https://github.com/randomm/pi-ensemble/issues/466)) ([af8d35d](https://github.com/randomm/pi-ensemble/commit/af8d35d20ca2f5cf1dbdbee36adbea7d9f7befaa))
* the size ratchet measures the whole repo, and is proven to fail ([#468](https://github.com/randomm/pi-ensemble/issues/468)) ([6c7a092](https://github.com/randomm/pi-ensemble/commit/6c7a0925920e2ee70b992539b09ca9dd3a83fe84))

## [0.12.42](https://github.com/randomm/pi-ensemble/compare/v0.12.41...v0.12.42) (2026-08-13)


### Features

* unblock workstream parallelism — spawn cap, integration correctness, verify-before-push ([#459](https://github.com/randomm/pi-ensemble/issues/459)) ([0137cac](https://github.com/randomm/pi-ensemble/commit/0137cac10b3aa9df024c205db7cb6a946ceeee80))

## [0.12.41](https://github.com/randomm/pi-ensemble/compare/v0.12.40...v0.12.41) (2026-08-13)


### Bug Fixes

* **work-driver:** stop parking work the resolver approved; serialise cycles ([#457](https://github.com/randomm/pi-ensemble/issues/457)) ([9f247c9](https://github.com/randomm/pi-ensemble/commit/9f247c93f81e6f5c7b423ec09f702e6132501c64))

## [0.12.40](https://github.com/randomm/pi-ensemble/compare/v0.12.39...v0.12.40) (2026-08-12)


### Bug Fixes

* **work-driver:** provision worktrees, catch path collisions at plan time ([#448](https://github.com/randomm/pi-ensemble/issues/448)) ([95078fe](https://github.com/randomm/pi-ensemble/commit/95078fea0e34b4f384e5ec4d7c38eb53eba76a9f))

## [0.12.39](https://github.com/randomm/pi-ensemble/compare/v0.12.38...v0.12.39) (2026-08-12)


### Bug Fixes

* **work-driver:** gates that could not fail, plus merge-target integrity ([#443](https://github.com/randomm/pi-ensemble/issues/443)) ([b8e2318](https://github.com/randomm/pi-ensemble/commit/b8e23184aad38c07894e9903be7146a05f4be447))

## [0.12.38](https://github.com/randomm/pi-ensemble/compare/v0.12.37...v0.12.38) (2026-08-12)


### Bug Fixes

* **work-driver:** four gates that could corrupt main ([#441](https://github.com/randomm/pi-ensemble/issues/441)) ([080e97c](https://github.com/randomm/pi-ensemble/commit/080e97c89d8dd38569b3e579ca826f7e415fa548))

## [0.12.37](https://github.com/randomm/pi-ensemble/compare/v0.12.36...v0.12.37) (2026-08-12)


### Bug Fixes

* **#664:** the adversarial gate rejected code its own reviewer approved ([#439](https://github.com/randomm/pi-ensemble/issues/439)) ([fa90728](https://github.com/randomm/pi-ensemble/commit/fa90728557edfa1f858921900ebb5ab782d98a17))

## [0.12.36](https://github.com/randomm/pi-ensemble/compare/v0.12.35...v0.12.36) (2026-08-12)


### Bug Fixes

* **#408:** PM could not actually call the tools it was given ([#437](https://github.com/randomm/pi-ensemble/issues/437)) ([c1df78a](https://github.com/randomm/pi-ensemble/commit/c1df78a867e3ef2208c3cb7fd2387e5750abcd8a))

## [0.12.35](https://github.com/randomm/pi-ensemble/compare/v0.12.34...v0.12.35) (2026-08-12)


### Bug Fixes

* respect provider backoffs and report real dispatch outcomes ([#435](https://github.com/randomm/pi-ensemble/issues/435)) ([7851701](https://github.com/randomm/pi-ensemble/commit/7851701931219203e487c29d92a3371067203c15))

## [0.12.34](https://github.com/randomm/pi-ensemble/compare/v0.12.33...v0.12.34) (2026-08-12)


### Bug Fixes

* **#432:** transient failures were terminal — three defects, all measured ([#433](https://github.com/randomm/pi-ensemble/issues/433)) ([084edeb](https://github.com/randomm/pi-ensemble/commit/084edeb3efcb6af109149ea9ece7bcb63bffe505)), closes [#432](https://github.com/randomm/pi-ensemble/issues/432)

## [0.12.33](https://github.com/randomm/pi-ensemble/compare/v0.12.32...v0.12.33) (2026-08-11)


### Bug Fixes

* **#429:** the prompt tree taught commands the roles are denied, and the write doctrine never shipped ([#430](https://github.com/randomm/pi-ensemble/issues/430)) ([f63e2e8](https://github.com/randomm/pi-ensemble/commit/f63e2e8a31994a13d8a33fcad0732f11aba1ef58)), closes [#429](https://github.com/randomm/pi-ensemble/issues/429)

## [0.12.32](https://github.com/randomm/pi-ensemble/compare/v0.12.31...v0.12.32) (2026-08-11)


### Features

* **#422:** the develop step reads memory, on a rule measured against the real corpus ([#428](https://github.com/randomm/pi-ensemble/issues/428)) ([fa4dd91](https://github.com/randomm/pi-ensemble/commit/fa4dd9171446952e1a0b37f8e9b764339f8fbdd7)), closes [#422](https://github.com/randomm/pi-ensemble/issues/422)
* **#422:** the driver writes what it already knows, and we can tell whether it helps ([#426](https://github.com/randomm/pi-ensemble/issues/426)) ([fee532f](https://github.com/randomm/pi-ensemble/commit/fee532fde0b9918c09dd515b3d724014e5af375a)), closes [#422](https://github.com/randomm/pi-ensemble/issues/422)

## [0.12.31](https://github.com/randomm/pi-ensemble/compare/v0.12.30...v0.12.31) (2026-08-11)


### Bug Fixes

* **#423:** no agent rewrites a memory in place, and the seam cannot die unnoticed ([#424](https://github.com/randomm/pi-ensemble/issues/424)) ([41bb29c](https://github.com/randomm/pi-ensemble/commit/41bb29c2936e210351681cd5b5e5350abde154e7)), closes [#423](https://github.com/randomm/pi-ensemble/issues/423)

## [0.12.30](https://github.com/randomm/pi-ensemble/compare/v0.12.29...v0.12.30) (2026-08-11)


### Features

* **#420:** close the vipune read/write loop and resolve staleness after retrieval ([#421](https://github.com/randomm/pi-ensemble/issues/421)) ([273fdd1](https://github.com/randomm/pi-ensemble/commit/273fdd14ec03ba3cf0224a7affeb7710b0d36ca9)), closes [#420](https://github.com/randomm/pi-ensemble/issues/420)


### Bug Fixes

* **#417:** the calibrated vipune seam was unreachable while a broken invocation ran daily ([#418](https://github.com/randomm/pi-ensemble/issues/418)) ([9df187a](https://github.com/randomm/pi-ensemble/commit/9df187a1e6aa75b59ec281e3ce3ca2f5c8b8395a)), closes [#417](https://github.com/randomm/pi-ensemble/issues/417)

## [0.12.29](https://github.com/randomm/pi-ensemble/compare/v0.12.28...v0.12.29) (2026-08-10)


### Features

* **review:** catch false claims in a diff — evidence supply + claim-scan ([#415](https://github.com/randomm/pi-ensemble/issues/415)) ([2280e85](https://github.com/randomm/pi-ensemble/commit/2280e856b569ec1287351343cd3a7258f75654d1))

## [0.12.28](https://github.com/randomm/pi-ensemble/compare/v0.12.27...v0.12.28) (2026-08-09)


### Features

* **#407:** resolve merge authority by asking the documents, not regexing them ([#412](https://github.com/randomm/pi-ensemble/issues/412)) ([603d611](https://github.com/randomm/pi-ensemble/commit/603d6112e63b2b4ffcbc217409366ce18e2ada68)), closes [#407](https://github.com/randomm/pi-ensemble/issues/407)


### Bug Fixes

* **#406:** a cycle can no longer grant itself merge authority ([#410](https://github.com/randomm/pi-ensemble/issues/410)) ([22127ea](https://github.com/randomm/pi-ensemble/commit/22127ea1655654c9ef0f4c1dba047167cc8bd496)), closes [#406](https://github.com/randomm/pi-ensemble/issues/406)
* **#408:** a marker that fails to parse must not produce a confident wrong answer ([#413](https://github.com/randomm/pi-ensemble/issues/413)) ([72143e3](https://github.com/randomm/pi-ensemble/commit/72143e329de930e6d262caf9d22fe9a6c51f58b9)), closes [#408](https://github.com/randomm/pi-ensemble/issues/408)

## [0.12.27](https://github.com/randomm/pi-ensemble/compare/v0.12.26...v0.12.27) (2026-08-09)


### Bug Fixes

* **#404:** a park the resolver declared is never overridden ([#405](https://github.com/randomm/pi-ensemble/issues/405)) ([97fbc2d](https://github.com/randomm/pi-ensemble/commit/97fbc2d9602f62c0cc99e9bf260b49c68f614b02)), closes [#404](https://github.com/randomm/pi-ensemble/issues/404)

## [0.12.26](https://github.com/randomm/pi-ensemble/compare/v0.12.25...v0.12.26) (2026-08-08)


### Bug Fixes

* **#337:** release PRs authenticate with RELEASE_PAT so CI actually runs ([#402](https://github.com/randomm/pi-ensemble/issues/402)) ([5cf77d4](https://github.com/randomm/pi-ensemble/commit/5cf77d43d7f7ff396e8643542794fcd9a453c9b6)), closes [#337](https://github.com/randomm/pi-ensemble/issues/337)

## [0.12.25](https://github.com/randomm/pi-ensemble/compare/v0.12.24...v0.12.25) (2026-08-08)


### Bug Fixes

* **#397:** one verdict protocol, and a complete spec is not "underspecified" ([#399](https://github.com/randomm/pi-ensemble/issues/399)) ([079f8e3](https://github.com/randomm/pi-ensemble/commit/079f8e35c9b2132d90fbb82323685ecc8226fbe8)), closes [#397](https://github.com/randomm/pi-ensemble/issues/397)
* **#398:** intent-park stops inheriting a handoff written for a timeout ([#400](https://github.com/randomm/pi-ensemble/issues/400)) ([5ecbe74](https://github.com/randomm/pi-ensemble/commit/5ecbe74e644055b69ee790e472e993613fd30afe)), closes [#398](https://github.com/randomm/pi-ensemble/issues/398)

## [0.12.24](https://github.com/randomm/pi-ensemble/compare/v0.12.23...v0.12.24) (2026-08-07)


### Features

* **#279:** verify-full tier + type-widening scan (and the hollow tests that hid four bugs) ([#375](https://github.com/randomm/pi-ensemble/issues/375)) ([5151f08](https://github.com/randomm/pi-ensemble/commit/5151f08c6e5d6c412571b9d485223f09e42e3ee6))
* **#287:** repoRoot is never a dev tree — always-worktree isolation ([#365](https://github.com/randomm/pi-ensemble/issues/365)) ([2217c33](https://github.com/randomm/pi-ensemble/commit/2217c33a807fdc21ab664541bba6faf0364d1c63)), closes [#287](https://github.com/randomm/pi-ensemble/issues/287)
* **#288:** multi-cycle observability — widget, scrollback, /work-status ([#373](https://github.com/randomm/pi-ensemble/issues/373)) ([f28f6a1](https://github.com/randomm/pi-ensemble/commit/f28f6a1e90c82e44d28c04f7134734cbca75a97d)), closes [#288](https://github.com/randomm/pi-ensemble/issues/288)
* **#289:** bounded parallel group pool — parallelism on by default ([#374](https://github.com/randomm/pi-ensemble/issues/374)) ([dacdaae](https://github.com/randomm/pi-ensemble/commit/dacdaae4181296332a2ac03004a7e22fcbe5274b)), closes [#289](https://github.com/randomm/pi-ensemble/issues/289)
* **#289:** integration lock — repoRoot mutations are serialised ([#372](https://github.com/randomm/pi-ensemble/issues/372)) ([7abb193](https://github.com/randomm/pi-ensemble/commit/7abb193bb4dfc9e29fc07826516ad3c90f405a85)), closes [#289](https://github.com/randomm/pi-ensemble/issues/289)
* **#290:** plan decomposition doctrine + workstream ceiling ([#370](https://github.com/randomm/pi-ensemble/issues/370)) ([8f63c53](https://github.com/randomm/pi-ensemble/commit/8f63c5380dd1ace42941c94327c454df9dccd668)), closes [#290](https://github.com/randomm/pi-ensemble/issues/290)
* **#323:** mechanize merge + restore checkout ([#354](https://github.com/randomm/pi-ensemble/issues/354)) ([f2e62af](https://github.com/randomm/pi-ensemble/commit/f2e62af7971fc4068fa623a7a2584f096d170d80))
* **#378:** resolve intent from any spec, then proceed, assume, or park ([#379](https://github.com/randomm/pi-ensemble/issues/379)) ([db806b1](https://github.com/randomm/pi-ensemble/commit/db806b120049c527f0365ae31ac19b6db19eb6f6)), closes [#378](https://github.com/randomm/pi-ensemble/issues/378)
* **#380:** merging requires explicit authority and executed evidence ([#381](https://github.com/randomm/pi-ensemble/issues/381)) ([075bd1c](https://github.com/randomm/pi-ensemble/commit/075bd1cf0b7c01bf415c77499b1da8df667cf78d)), closes [#380](https://github.com/randomm/pi-ensemble/issues/380)
* **#382:** a crash mid-cycle no longer loses the work silently ([#383](https://github.com/randomm/pi-ensemble/issues/383)) ([1f5f97e](https://github.com/randomm/pi-ensemble/commit/1f5f97e9af0a6454294bd80e98e297823e98fb03)), closes [#382](https://github.com/randomm/pi-ensemble/issues/382)
* **#388:** tell the operator when a cycle needs them ([#389](https://github.com/randomm/pi-ensemble/issues/389)) ([8030d39](https://github.com/randomm/pi-ensemble/commit/8030d3900927923f4f2f0d3dda971000451f1069)), closes [#388](https://github.com/randomm/pi-ensemble/issues/388)
* **#390:** /start reads what /work left behind ([#392](https://github.com/randomm/pi-ensemble/issues/392)) ([2a667c8](https://github.com/randomm/pi-ensemble/commit/2a667c84c3d4cbbeeeb59b68150d7888c2a088c6)), closes [#390](https://github.com/randomm/pi-ensemble/issues/390)
* **#394:** the vipune seam, calibrated on measurement not documentation ([#396](https://github.com/randomm/pi-ensemble/issues/396)) ([e995771](https://github.com/randomm/pi-ensemble/commit/e9957713cc77916ae704ded91c500584135b4d46)), closes [#394](https://github.com/randomm/pi-ensemble/issues/394)
* **concurrency:** global spawn semaphore + jittered lens retry ([#371](https://github.com/randomm/pi-ensemble/issues/371)) ([e015ccb](https://github.com/randomm/pi-ensemble/commit/e015ccba6fa9384fd7a2cdef261226e69e1fcd62))


### Bug Fixes

* **#360:** command handlers honour ctx.cwd, not process.cwd() ([#361](https://github.com/randomm/pi-ensemble/issues/361)) ([9f8fc40](https://github.com/randomm/pi-ensemble/commit/9f8fc4033661acdb27371b5234c55074e19bab4b)), closes [#360](https://github.com/randomm/pi-ensemble/issues/360)
* **#362:** halt at the branch step when an open PR already covers the issue ([#363](https://github.com/randomm/pi-ensemble/issues/363)) ([970b068](https://github.com/randomm/pi-ensemble/commit/970b06806a9e2bffe289739bd39799efd00ee9a3)), closes [#362](https://github.com/randomm/pi-ensemble/issues/362)
* **#366:** classify 429s by the delay the provider actually requested ([#367](https://github.com/randomm/pi-ensemble/issues/367)) ([7e5402c](https://github.com/randomm/pi-ensemble/commit/7e5402c7fc703107a3c0f704e11d199ed1ef6e6c)), closes [#366](https://github.com/randomm/pi-ensemble/issues/366)
* **#368:** a failed group parks and the queue continues ([#369](https://github.com/randomm/pi-ensemble/issues/369)) ([f227a77](https://github.com/randomm/pi-ensemble/commit/f227a77922857b2ad8dc58c2d7ae5dde8b06d98e)), closes [#368](https://github.com/randomm/pi-ensemble/issues/368)
* **#376:** four grouping rules were dead on real issues ([#377](https://github.com/randomm/pi-ensemble/issues/377)) ([fc46581](https://github.com/randomm/pi-ensemble/commit/fc46581f8cc198b55a57851546d6d1dfadb577ad)), closes [#376](https://github.com/randomm/pi-ensemble/issues/376)
* **#384:** the six-pass review no longer approves on absent evidence ([#385](https://github.com/randomm/pi-ensemble/issues/385)) ([3a30a70](https://github.com/randomm/pi-ensemble/commit/3a30a70abefb9512fe65de16ed71175fec473b99)), closes [#384](https://github.com/randomm/pi-ensemble/issues/384)
* **#386:** a recovered provider failure no longer halts the whole queue ([#387](https://github.com/randomm/pi-ensemble/issues/387)) ([32e5c12](https://github.com/randomm/pi-ensemble/commit/32e5c1270637b1e0250235e86544daa085c957e5)), closes [#386](https://github.com/randomm/pi-ensemble/issues/386)
* **lens:** review output cites AGENTS.md Step 7, which does not exist in ([#346](https://github.com/randomm/pi-ensemble/issues/346)) ([a54f747](https://github.com/randomm/pi-ensemble/commit/a54f7479ba4a39d6a7ce44aacb54a72334838505)), closes [#327](https://github.com/randomm/pi-ensemble/issues/327)
* **smoke-tests:** lens-review has no injection seam — five offline tests ([#348](https://github.com/randomm/pi-ensemble/issues/348)) ([70dceac](https://github.com/randomm/pi-ensemble/commit/70dceacae46825c4f08aef01ba7ad19cd3d326cd))
* **spawn:** --exclude-tools is never passed to children — [#238](https://github.com/randomm/pi-ensemble/issues/238)'s reviewe ([#350](https://github.com/randomm/pi-ensemble/issues/350)) ([7d15a0d](https://github.com/randomm/pi-ensemble/commit/7d15a0d6a830b6c9155b1d6e21c60213656bddd4))
* **work-driver:** branchName recorded from LLM ops reply, not verified a ([#352](https://github.com/randomm/pi-ensemble/issues/352)) ([6cca39d](https://github.com/randomm/pi-ensemble/commit/6cca39d2cb4a4041050a3d412310416556d457c2))

## [0.12.23](https://github.com/randomm/pi-ensemble/compare/v0.12.22...v0.12.23) (2026-08-04)


### Bug Fixes

* **smoke-tests:** offline gate stack cannot pass in a fresh worktree — h ([a84a09d](https://github.com/randomm/pi-ensemble/commit/a84a09dbe16d72395235c6f1e560c70f330706ad))
* **smoke-tests:** offline gate stack cannot pass in a fresh worktree — h ([8385776](https://github.com/randomm/pi-ensemble/commit/83857762cf8e5f1e493a7639db8b1205fd025437)), closes [#318](https://github.com/randomm/pi-ensemble/issues/318)
* **work-driver:** R3 SPLIT detection matches the bare word 'independent' ([#336](https://github.com/randomm/pi-ensemble/issues/336)) ([5444e78](https://github.com/randomm/pi-ensemble/commit/5444e78cb0255fb26954804a344048eaf254d568)), closes [#312](https://github.com/randomm/pi-ensemble/issues/312)
* **work-driver:** R4 subsystem-tag matcher is unanchored — incidental br ([#335](https://github.com/randomm/pi-ensemble/issues/335)) ([9b4ec7b](https://github.com/randomm/pi-ensemble/commit/9b4ec7b6786d02f6b4d1c04e42150b361df02df0)), closes [#282](https://github.com/randomm/pi-ensemble/issues/282)

## [0.12.22](https://github.com/randomm/pi-ensemble/compare/v0.12.21...v0.12.22) (2026-07-31)


### Bug Fixes

* **work-driver:** classify failures by cause — retry depth, operator taxonomy, and install defaults ([#314](https://github.com/randomm/pi-ensemble/issues/314)) ([b909152](https://github.com/randomm/pi-ensemble/commit/b909152c80c2b99faffa6361fb435eccbe0fb45a))

## [0.12.21](https://github.com/randomm/pi-ensemble/compare/v0.12.20...v0.12.21) (2026-07-30)


### Features

* **work-driver:** deterministic develop gates — skipped-test ratchet + product smoke command ([#303](https://github.com/randomm/pi-ensemble/issues/303)) ([c5d5391](https://github.com/randomm/pi-ensemble/commit/c5d53913d957956da1d9ca0e1a650240b925d862))


### Bug Fixes

* **work-driver:** commit lens-fix changes so the lens review loop can converge ([#310](https://github.com/randomm/pi-ensemble/issues/310)) ([2ff2c40](https://github.com/randomm/pi-ensemble/commit/2ff2c405a0d7fc3214a5deeeae10bd4a0d0666d9))

## [0.12.20](https://github.com/randomm/pi-ensemble/compare/v0.12.19...v0.12.20) (2026-07-29)


### Bug Fixes

* **spawn:** reliability overhaul — timeout retune, transient retries, honest failure telemetry ([#301](https://github.com/randomm/pi-ensemble/issues/301)) ([a41090a](https://github.com/randomm/pi-ensemble/commit/a41090a72c7b56007eb108fe103fec6fdb112159)), closes [#295](https://github.com/randomm/pi-ensemble/issues/295) [#296](https://github.com/randomm/pi-ensemble/issues/296) [#297](https://github.com/randomm/pi-ensemble/issues/297) [#298](https://github.com/randomm/pi-ensemble/issues/298) [#299](https://github.com/randomm/pi-ensemble/issues/299) [#300](https://github.com/randomm/pi-ensemble/issues/300)

## [0.12.19](https://github.com/randomm/pi-ensemble/compare/v0.12.18...v0.12.19) (2026-07-25)


### Features

* **work-driver:** mechanized commit-pr — driver-executed consolidation, commit, push, PR creation ([#274](https://github.com/randomm/pi-ensemble/issues/274)) ([12ab67c](https://github.com/randomm/pi-ensemble/commit/12ab67c3ead714d3c60cb834c1595247a7e41fc2))

## [0.12.18](https://github.com/randomm/pi-ensemble/compare/v0.12.17...v0.12.18) (2026-07-25)


### Bug Fixes

* **work-driver:** harden outcome-verification gates (R1 note-suppression, R6 verify-cmd precedence, R4 integration tests) ([#272](https://github.com/randomm/pi-ensemble/issues/272)) ([b2a543e](https://github.com/randomm/pi-ensemble/commit/b2a543e82c023430151c7615cb9d56b0a302272a))

## [0.12.17](https://github.com/randomm/pi-ensemble/compare/v0.12.16...v0.12.17) (2026-07-24)


### Features

* **work-driver:** driver-side outcome-verification gates (executed evidence, not transcripts) ([#270](https://github.com/randomm/pi-ensemble/issues/270)) ([003fb46](https://github.com/randomm/pi-ensemble/commit/003fb46d411a0bc3517afbb93ffe42d18648c18e))

## [0.12.16](https://github.com/randomm/pi-ensemble/compare/v0.12.15...v0.12.16) (2026-07-16)


### Features

* **work-driver:** deterministic multi-issue grouping analysis at /work entry point ([#265](https://github.com/randomm/pi-ensemble/issues/265)) ([4a61140](https://github.com/randomm/pi-ensemble/commit/4a61140b027840d18c3cb90b3bcd7a1b74560bb3))

## [0.12.15](https://github.com/randomm/pi-ensemble/compare/v0.12.14...v0.12.15) (2026-07-12)


### Bug Fixes

* **work-driver:** ci step 30-min timeout + /work N M P runs sequential single-issue cycles ([#260](https://github.com/randomm/pi-ensemble/issues/260)) ([21e9543](https://github.com/randomm/pi-ensemble/commit/21e9543478ccd3dd020235fb98f4dd1f0207eb07))

## [0.12.14](https://github.com/randomm/pi-ensemble/compare/v0.12.13...v0.12.14) (2026-07-06)


### Bug Fixes

* **work-driver:** commit-pr consolidates ALL workstream worktrees (N&gt;1 convergence) ([#253](https://github.com/randomm/pi-ensemble/issues/253)) ([97a00ca](https://github.com/randomm/pi-ensemble/commit/97a00ca61f1559e6a5c7453df2d672b4f250d48e))

## [0.12.13](https://github.com/randomm/pi-ensemble/compare/v0.12.12...v0.12.13) (2026-06-26)


### Bug Fixes

* **work-driver:** inline issue body in explore prompt (eliminate PR3 Pattern 1 race) ([#251](https://github.com/randomm/pi-ensemble/issues/251)) ([082dd9d](https://github.com/randomm/pi-ensemble/commit/082dd9d31fac56a4c87ebada0c4fe5c98565fe02))

## [0.12.12](https://github.com/randomm/pi-ensemble/compare/v0.12.11...v0.12.12) (2026-06-26)


### Bug Fixes

* **work-driver:** add /work --restart + clear notify on terminal-state re-entry + step-back-aware handoff recovery ([#249](https://github.com/randomm/pi-ensemble/issues/249)) ([40aadd4](https://github.com/randomm/pi-ensemble/commit/40aadd4556534e033ebc1318c4cd435acd6624cd))

## [0.12.11](https://github.com/randomm/pi-ensemble/compare/v0.12.10...v0.12.11) (2026-06-26)


### Bug Fixes

* **work-driver:** lens-review uses merge-base diff + develop prompt threads active issues + halt on empty issue bodies ([#247](https://github.com/randomm/pi-ensemble/issues/247)) ([98b58b8](https://github.com/randomm/pi-ensemble/commit/98b58b8e4758689ee6977d7b0b1f68c77bf2f813))

## [0.12.10](https://github.com/randomm/pi-ensemble/compare/v0.12.9...v0.12.10) (2026-06-25)


### Bug Fixes

* **work-driver:** execute merge step + multi-issue /work with per-issue verdict routing ([#245](https://github.com/randomm/pi-ensemble/issues/245)) ([e27a8d4](https://github.com/randomm/pi-ensemble/commit/e27a8d4ce911ed60ae01a1d4f3e6a9a683d5bf72))

## [0.12.9](https://github.com/randomm/pi-ensemble/compare/v0.12.8...v0.12.9) (2026-06-24)


### Features

* **work:** compile /work into a deterministic driver (Option C v1) ([#239](https://github.com/randomm/pi-ensemble/issues/239)) ([93443b6](https://github.com/randomm/pi-ensemble/commit/93443b682bcef5eab427c29a0e467300864b3716))

## [0.12.8](https://github.com/randomm/pi-ensemble/compare/v0.12.7...v0.12.8) (2026-06-24)


### Features

* **deck:** bypass Pi's 10-row widget cap via setWidget factory form ([#232](https://github.com/randomm/pi-ensemble/issues/232)) ([1860775](https://github.com/randomm/pi-ensemble/commit/1860775d14eb69c0c87806a0834cb8122acfe803))
* **doctrine:** cap-hits produce structured handoff artifact, not user-block ([#233](https://github.com/randomm/pi-ensemble/issues/233)) ([38ac291](https://github.com/randomm/pi-ensemble/commit/38ac291838d3f3e5b772fd11647dce5a470df703))
* **doctrine:** plumbing — subagents surface structural decisions to PM mid-dispatch ([#234](https://github.com/randomm/pi-ensemble/issues/234)) ([59b70d2](https://github.com/randomm/pi-ensemble/commit/59b70d214e913d702d52bb3b25fb96cde5323ee2))
* **doctrine:** PM step-back via [@explore](https://github.com/explore) when cap-hit findings cluster around a theme ([#235](https://github.com/randomm/pi-ensemble/issues/235)) ([f95fa5c](https://github.com/randomm/pi-ensemble/commit/f95fa5c220266fc43d7210bc68ba1a715cd63a80))
* **spawn:** per-role tool-gating for reviewer subagents (Option A of determinism plan) ([#238](https://github.com/randomm/pi-ensemble/issues/238)) ([b7a1172](https://github.com/randomm/pi-ensemble/commit/b7a1172fa9d9ad3c031ef936e4951781f0a12ee2))


### Bug Fixes

* **#210:** support macOS bash in launcher ([#211](https://github.com/randomm/pi-ensemble/issues/211)) ([85c7117](https://github.com/randomm/pi-ensemble/commit/85c7117576b1b037101396b09f0bbf58aeca2a8a))
* **sandbox:** allow parallel-web-cli postinstall so binary downloads ([#243](https://github.com/randomm/pi-ensemble/issues/243)) ([00f5d61](https://github.com/randomm/pi-ensemble/commit/00f5d614f14c9bf1a978965e7afbe03f3b82b6d5))
* **sandbox:** block DOCKER_HOST from host-env forward — Colima users couldn't spawn sibling containers ([#231](https://github.com/randomm/pi-ensemble/issues/231)) ([6912ca3](https://github.com/randomm/pi-ensemble/commit/6912ca31fdda1480b5211736632fb7e5e1e61c1b))
* **sandbox:** forward all host env vars (less blocklist) — fix .pi/mcp.json env-refs ([#228](https://github.com/randomm/pi-ensemble/issues/228)) ([05ac264](https://github.com/randomm/pi-ensemble/commit/05ac2642709fd51c9396aa24c515051cd6def46e))
* **sandbox:** make docker socket + SSH default-on (transparent to user) ([#220](https://github.com/randomm/pi-ensemble/issues/220)) ([0f2f8ae](https://github.com/randomm/pi-ensemble/commit/0f2f8ae06a2e122e469cd08c674e47a5bab2bced))
* **sandbox:** NUL-separated env parsing + TTY repair after container exit ([#229](https://github.com/randomm/pi-ensemble/issues/229)) ([3a4e842](https://github.com/randomm/pi-ensemble/commit/3a4e8420c8c992e616494e47cb1fd8042a96e843))
* **sandbox:** NUL-separated IPC between build_* and run_container ([#230](https://github.com/randomm/pi-ensemble/issues/230)) ([8ff2332](https://github.com/randomm/pi-ensemble/commit/8ff233227589132acc643147324566c9ba1038f3))
* **sandbox:** unset broken SSH_AUTH_SOCK so SSH falls back to ~/.ssh/ keys ([#227](https://github.com/randomm/pi-ensemble/issues/227)) ([3748b3c](https://github.com/randomm/pi-ensemble/commit/3748b3cde9b47a232806d0f27029e32d1ad898a6))
* **spawn:** surface provider HTTP timeouts as FAILED-PROVIDER-ERROR + tight retry defaults ([#236](https://github.com/randomm/pi-ensemble/issues/236)) ([546e19f](https://github.com/randomm/pi-ensemble/commit/546e19fbcb1544354c05da3b7dc0a42ad7b15066))

## [0.12.7](https://github.com/randomm/pi-ensemble/compare/v0.12.6...v0.12.7) (2026-06-16)


### Features

* adopt codebase-memory-mcp; deprecate lievo + colgrep across the doctrine ([#191](https://github.com/randomm/pi-ensemble/issues/191)) ([4fe1cb7](https://github.com/randomm/pi-ensemble/commit/4fe1cb7f5b49f6239bb6e371b470d6a69b9e0a64))
* **ci:** publish sandbox image to GHCR; install.sh pulls instead of builds ([#219](https://github.com/randomm/pi-ensemble/issues/219)) ([a0ceb91](https://github.com/randomm/pi-ensemble/commit/a0ceb91da51cf04c78ebae38208a3c848da5a3f2))
* dispatch_peek/steer transparently handle adversarial_loop jobIds ([#186](https://github.com/randomm/pi-ensemble/issues/186)) ([5082e85](https://github.com/randomm/pi-ensemble/commit/5082e859728678127f701396c0d24d4d10299b3d))
* extend permission-guard into subagents (per-role allowlist applies universally) ([#187](https://github.com/randomm/pi-ensemble/issues/187)) ([56bcd6a](https://github.com/randomm/pi-ensemble/commit/56bcd6a7728ada2ae7b34e39e3a2791d6ba60f3d))
* **sandbox:** --add-host plumbing so tailnet/LAN hostnames resolve inside container ([#204](https://github.com/randomm/pi-ensemble/issues/204)) ([aad53cb](https://github.com/randomm/pi-ensemble/commit/aad53cb46691b716dcd92059f3d2a903b23c4175))
* **sandbox:** docker-out-of-docker support for docker-based MCP servers ([#216](https://github.com/randomm/pi-ensemble/issues/216)) ([bcf3be2](https://github.com/randomm/pi-ensemble/commit/bcf3be2921efe49ebf10c2a89f2847c46773db88))
* **sandbox:** drag-and-drop images + PM image-path guidance + /ensemble-model EROFS fix ([#213](https://github.com/randomm/pi-ensemble/issues/213)) ([88d423c](https://github.com/randomm/pi-ensemble/commit/88d423cdea2d5376e94e361883bbe99d0326549a))
* **sandbox:** install parallel-cli in image + scrub PM's ghost-MCP web-search refs ([#218](https://github.com/randomm/pi-ensemble/issues/218)) ([5a47955](https://github.com/randomm/pi-ensemble/commit/5a47955719a337675d3e0f8120601da21a478693))
* **sandbox:** pi-ensemble Dockerized runtime — strip permissions, container fence is the trust boundary ([#200](https://github.com/randomm/pi-ensemble/issues/200)) ([8bab38a](https://github.com/randomm/pi-ensemble/commit/8bab38a4c45f6cedfeb116f68d8faf1156b1970f))
* **vipune:** bundle skill/vipune/ + upgrade modules to richer 5-type taxonomy ([#184](https://github.com/randomm/pi-ensemble/issues/184)) ([44a29fe](https://github.com/randomm/pi-ensemble/commit/44a29fe5516d586e3eb02b4ec72b123a5c42a3b7))


### Bug Fixes

* bound spawn buffers + bash catch-all ask (parent OOM + permission regression) ([#188](https://github.com/randomm/pi-ensemble/issues/188)) ([986989d](https://github.com/randomm/pi-ensemble/commit/986989d897eabad05b889f87baaa83cdb9c0eb98))
* install.sh wires codebase-memory-mcp; expand read-side bash baseline; fix repo_path doctrine ([#196](https://github.com/randomm/pi-ensemble/issues/196)) ([29f03cd](https://github.com/randomm/pi-ensemble/commit/29f03cdc030401e59798381bd387f34c97851a8f))
* **perms:** injection-vector bash falls through to ask, not hard-deny ([#189](https://github.com/randomm/pi-ensemble/issues/189)) ([2c48364](https://github.com/randomm/pi-ensemble/commit/2c4836494a87752a740f84e4a9b4c9474f1b7887))
* **perms:** strip per-call gating from interactive host mode — symmetric with sandbox ([#215](https://github.com/randomm/pi-ensemble/issues/215)) ([1860272](https://github.com/randomm/pi-ensemble/commit/18602727f3a8a24af5ffd6059078f53e28c83604))
* **perms:** subagent overlays + spec.cwd threading + assertive code-search doctrine ([#192](https://github.com/randomm/pi-ensemble/issues/192)) ([4f520de](https://github.com/randomm/pi-ensemble/commit/4f520dea1bd53e7e525b8e8e588e4b1ba9d6a8f2))
* **prompts:** hoist tool/permission section + add reminders footer per literature ([#190](https://github.com/randomm/pi-ensemble/issues/190)) ([96cb0ff](https://github.com/randomm/pi-ensemble/commit/96cb0ff715180c00730071ccc003e493536037e8))
* **prompts:** stop PM from emitting &lt;tool_use name="vipune"&gt; — clean up MCP inventory ([#214](https://github.com/randomm/pi-ensemble/issues/214)) ([d60344a](https://github.com/randomm/pi-ensemble/commit/d60344a2c486b7007892debd1bb2fabcd62c30ab))
* **sandbox:** align session buckets between host and sandbox + docs refresh ([#212](https://github.com/randomm/pi-ensemble/issues/212)) ([189162f](https://github.com/randomm/pi-ensemble/commit/189162fc59e595decf81722f1178c9c0a49cb09a))
* **sandbox:** bake fd+rg into image, forward gh token, named-volume fallback for vipune ([#203](https://github.com/randomm/pi-ensemble/issues/203)) ([0411b5a](https://github.com/randomm/pi-ensemble/commit/0411b5a642989ae501970c1bb4a9ec7a8dab24ab))
* **sandbox:** bind-mount models.json, pattern-forward LLM keys, pre-fetch vipune embedding model ([#205](https://github.com/randomm/pi-ensemble/issues/205)) ([93a7946](https://github.com/randomm/pi-ensemble/commit/93a7946453a41711f9bcacdab39dc6e82bfd0f88))
* **sandbox:** bind-mount Pi sessions dir so \`pi-ensemble -r\` resumes previous sandbox sessions ([#206](https://github.com/randomm/pi-ensemble/issues/206)) ([2f1c811](https://github.com/randomm/pi-ensemble/commit/2f1c81193e4d2b724b9e579fd9951a1540f81f3c))
* **sandbox:** PATH-relative `command:` in mcp.json so host config works inside container ([#202](https://github.com/randomm/pi-ensemble/issues/202)) ([8488119](https://github.com/randomm/pi-ensemble/commit/8488119e0a1cd9c2c98cb2710af348465316fbde))
* **wrapper:** allow concurrent pi-ensemble sessions in the same project ([#217](https://github.com/randomm/pi-ensemble/issues/217)) ([af364b4](https://github.com/randomm/pi-ensemble/commit/af364b4aec5171fdd22019d4568b5b9c7a87b59d))

## [0.12.6](https://github.com/randomm/pi-ensemble/compare/v0.12.5...v0.12.6) (2026-06-09)


### Features

* **model-picker:** interactive SelectList replaces text-input prompts ([#176](https://github.com/randomm/pi-ensemble/issues/176)) ([5841560](https://github.com/randomm/pi-ensemble/commit/584156097efc632f4c3f7079dfa50b9aa56cf2c7))
* **plan:** multi-phase spec-driven ticket creation with adversarial gap gate ([#181](https://github.com/randomm/pi-ensemble/issues/181)) ([0c0e309](https://github.com/randomm/pi-ensemble/commit/0c0e3092e472cbc6525cf312c2ced1329b3b6557))


### Bug Fixes

* **#176:** drop Container wrapper that swallows all input incl. Ctrl-C ([#178](https://github.com/randomm/pi-ensemble/issues/178)) ([e4376cf](https://github.com/randomm/pi-ensemble/commit/e4376cfe27c18eb5a54421a9b5f6cd48e90391cd))
* **list-models:** Pi 0.78 writes --list-models to stderr, not stdout ([#179](https://github.com/randomm/pi-ensemble/issues/179)) ([5b5e042](https://github.com/randomm/pi-ensemble/commit/5b5e042ca07fb0cfadc0fc9cb38b7e255e56a47c))

## [0.12.5](https://github.com/randomm/pi-ensemble/compare/v0.12.4...v0.12.5) (2026-06-08)


### Features

* **models:** route subagents through custom OpenAI-compatible providers ([#174](https://github.com/randomm/pi-ensemble/issues/174)) ([1fa57ee](https://github.com/randomm/pi-ensemble/commit/1fa57ee5ad60cbf812e4dcc521b51e2aba130e81))

## [0.12.4](https://github.com/randomm/pi-ensemble/compare/v0.12.3...v0.12.4) (2026-06-05)


### Features

* **#153:** dispatch_steer — PM-callable mid-flight course correction ([#156](https://github.com/randomm/pi-ensemble/issues/156)) ([99e36bb](https://github.com/randomm/pi-ensemble/commit/99e36bbea96e6425d375c9e4d204fdb3bb39ab1a))
* **#168:** ask-by-default for unknown tools (MCP discovery UX) ([#169](https://github.com/randomm/pi-ensemble/issues/169)) ([bc6d785](https://github.com/randomm/pi-ensemble/commit/bc6d785b233aaeb94d119e67cfeee8f4f6067a55))
* **#23:** session autosave to vipune on quit (opt-in) ([#164](https://github.com/randomm/pi-ensemble/issues/164)) ([4158c52](https://github.com/randomm/pi-ensemble/commit/4158c525e9164df93941b39f7b1981bc87063088))
* **#4:** check_review_cap — extension-state wall-clock cap for Step 7 fix loop ([#162](https://github.com/randomm/pi-ensemble/issues/162)) ([591757a](https://github.com/randomm/pi-ensemble/commit/591757a7428c6f304e9243fb1ee5b31ce21f102a))

## [0.12.3](https://github.com/randomm/pi-ensemble/compare/v0.12.2...v0.12.3) (2026-06-01)


### Features

* **#117:** live dispatch deck — footer status for in-flight subagents ([#122](https://github.com/randomm/pi-ensemble/issues/122)) ([79abef2](https://github.com/randomm/pi-ensemble/commit/79abef24257833618549636910ca7d91e2af73d3))
* **#118:** lifecycle scrollback entries for dispatch transitions ([#124](https://github.com/randomm/pi-ensemble/issues/124)) ([73dbebc](https://github.com/randomm/pi-ensemble/commit/73dbebcbd294a81ade1844342a6c1d62acf36590))
* **#21:** dispatch_peek tool — PM-callable subagent introspection ([#125](https://github.com/randomm/pi-ensemble/issues/125)) ([1c67bd4](https://github.com/randomm/pi-ensemble/commit/1c67bd47d9aa74f7d9d12dc8fbf4a7a78c1ce004))

## [0.12.2](https://github.com/randomm/pi-ensemble/compare/v0.12.1...v0.12.2) (2026-05-29)


### Bug Fixes

* **spawn:** bump subagent timeout to 30min, drop lens-review 10min override ([#115](https://github.com/randomm/pi-ensemble/issues/115)) ([a39e490](https://github.com/randomm/pi-ensemble/commit/a39e490c279cac19c7cff2ffe1fb1a59c7e73f4b)), closes [#114](https://github.com/randomm/pi-ensemble/issues/114)

## [0.12.1](https://github.com/randomm/pi-ensemble/compare/v0.12.0...v0.12.1) (2026-05-29)


### Bug Fixes

* **permissions:** /start step 4 PM-direct read-only gh pr/run; drop ops dispatch dependency ([#103](https://github.com/randomm/pi-ensemble/issues/103)) ([846dcd9](https://github.com/randomm/pi-ensemble/commit/846dcd95a31d0fedf524c5580b78e824c5f8e3fe)), closes [#102](https://github.com/randomm/pi-ensemble/issues/102)
* **permissions:** clean ghost issue/pr/ci grants, PM tickets via bare gh, /start $(pwd) injection ([#100](https://github.com/randomm/pi-ensemble/issues/100)) ([d99a93a](https://github.com/randomm/pi-ensemble/commit/d99a93a14c61e8e121e39f30571263019658500c)), closes [#99](https://github.com/randomm/pi-ensemble/issues/99)
* **permissions:** injection-vector check ignores content inside quoted args ([#109](https://github.com/randomm/pi-ensemble/issues/109)) ([b89f79c](https://github.com/randomm/pi-ensemble/commit/b89f79cd42633861fc626558ae365eb8a01a0598)), closes [#108](https://github.com/randomm/pi-ensemble/issues/108)
* **permissions:** PM allowed bare \`git diff\` — adversarial_loop needs raw diff as input ([#113](https://github.com/randomm/pi-ensemble/issues/113)) ([194c202](https://github.com/randomm/pi-ensemble/commit/194c2023f245190c507fd74f67ede05618e189ce)), closes [#112](https://github.com/randomm/pi-ensemble/issues/112)
* **prompts:** strengthen subagent output contract — never empty turn, ~300-line cap ([#107](https://github.com/randomm/pi-ensemble/issues/107)) ([b5ebf98](https://github.com/randomm/pi-ensemble/commit/b5ebf9887af07a4812ad01c70dfd226263a4c51c)), closes [#106](https://github.com/randomm/pi-ensemble/issues/106)
* **prompts:** tell agent Pi's bash captures stderr (no 2&gt;&1 needed) + `(no output)` ≠ failure ([#111](https://github.com/randomm/pi-ensemble/issues/111)) ([69399ca](https://github.com/randomm/pi-ensemble/commit/69399ca3ccde0e250bfa2caab999a1a055f19223)), closes [#110](https://github.com/randomm/pi-ensemble/issues/110)

## [0.12.0](https://github.com/randomm/pi-ensemble/compare/v0.11.0...v0.12.0) (2026-05-29)


### ⚠ BREAKING CHANGES

* **dispatch:** strip agent-controlled model override from dispatch tools ([#93](https://github.com/randomm/pi-ensemble/issues/93))

### Features

* **spawn:** auto-forward installed Pi extensions to subagents ([#89](https://github.com/randomm/pi-ensemble/issues/89)) ([db7d596](https://github.com/randomm/pi-ensemble/commit/db7d59633f10efe02f2def16e811a0790917dd14)), closes [#88](https://github.com/randomm/pi-ensemble/issues/88)


### Bug Fixes

* **ci:** bump feat: to PATCH instead of MINOR while pre-1.0 ([#95](https://github.com/randomm/pi-ensemble/issues/95)) ([3354d55](https://github.com/randomm/pi-ensemble/commit/3354d5506eb649d56375c1caa360047c8d88ca05)), closes [#94](https://github.com/randomm/pi-ensemble/issues/94)
* **dispatch:** strip agent-controlled model override from dispatch tools ([#93](https://github.com/randomm/pi-ensemble/issues/93)) ([4d646e5](https://github.com/randomm/pi-ensemble/commit/4d646e561389b9c5a5be6c8efa922ab0e95a9cd1)), closes [#92](https://github.com/randomm/pi-ensemble/issues/92)
* **permissions:** allow bare git reads for PM, drop redundant oo variants ([#97](https://github.com/randomm/pi-ensemble/issues/97)) ([ca77a15](https://github.com/randomm/pi-ensemble/commit/ca77a15fd68283d92b60bf1c2f155d45401c447f)), closes [#96](https://github.com/randomm/pi-ensemble/issues/96)

## [0.11.0](https://github.com/randomm/pi-ensemble/compare/v0.10.1...v0.11.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **work:** pair_watch tool removed. Workflows that called pair_watch directly must switch to dispatch_specialist (role: developer) followed by adversarial_loop on the resulting diff. The /work slash command already does this. Pre-1.0 alpha; no deprecation shim.

### Features

* **#24:** delegate /start context gathering to explore subagent ([#40](https://github.com/randomm/pi-ensemble/issues/40)) ([adf4ffc](https://github.com/randomm/pi-ensemble/commit/adf4ffc3981f5ebc99aa4ddfb0a170691386ac30))
* **#45-47:** per-host MCP server support ([#48](https://github.com/randomm/pi-ensemble/issues/48)) ([19e704b](https://github.com/randomm/pi-ensemble/commit/19e704b82731e7bcaf419c3e88b1a93db783b782))
* **#49:** unified layered permission system with interactive onboarding ([#53](https://github.com/randomm/pi-ensemble/issues/53)) ([ddda31b](https://github.com/randomm/pi-ensemble/commit/ddda31b75318b436330a39000843d19952a96bcf))
* **#54,#55:** pattern-based bash decision caching + AGENTS.md MEDIUM+ rule ([#56](https://github.com/randomm/pi-ensemble/issues/56)) ([faf0e18](https://github.com/randomm/pi-ensemble/commit/faf0e18c9a2f0636326d656e381f81da0524e730))
* async dispatch pivot + adapter architecture + PM safety + branch hygiene ([#20](https://github.com/randomm/pi-ensemble/issues/20)) ([0c6af0c](https://github.com/randomm/pi-ensemble/commit/0c6af0cf97fbf7a89957c1126a2fa12b868a60b9))
* **audit:** finalize docs and smoke coverage ([#57](https://github.com/randomm/pi-ensemble/issues/57)) ([85bbccf](https://github.com/randomm/pi-ensemble/commit/85bbccf54f38aa5d6ebad89dfe7cc691d96d3cb5))
* **deps:** switch context7 integration from MCP to ctx7 CLI ([58b7a6d](https://github.com/randomm/pi-ensemble/commit/58b7a6d7e6ca17ac68353719e257b05c92f06a1f))
* **epic#31:** add /audit slash command for standards-first repo inspection ([#42](https://github.com/randomm/pi-ensemble/issues/42)) ([f4c4db2](https://github.com/randomm/pi-ensemble/commit/f4c4db2794796729205aef812bb2c57f5d5215c8))
* **observability:** stream live subagent progress via onUpdate ([857be5c](https://github.com/randomm/pi-ensemble/commit/857be5c5b006b77f63fa50d99beab8419c3b52dc))
* **pair-watch:** live asymmetric pair-coding gate replaces developer + adversarial_loop ([#27](https://github.com/randomm/pi-ensemble/issues/27)) ([4add3a5](https://github.com/randomm/pi-ensemble/commit/4add3a551d2a27ed4c39dc94868c4bf875b901b0))
* **runs:** auto-prune to keep last N batches on disk ([7cdcba9](https://github.com/randomm/pi-ensemble/commit/7cdcba9e941904213cb8da228f8171290cad8c9d))
* **work:** remove pair_watch — restore developer + adversarial_loop gate ([#65](https://github.com/randomm/pi-ensemble/issues/65)) ([#70](https://github.com/randomm/pi-ensemble/issues/70)) ([84b5290](https://github.com/randomm/pi-ensemble/commit/84b529055a5458cd8d888c261c7c19ed9600482c))


### Bug Fixes

* **#63:** harden bash wildcard permission caching ([#64](https://github.com/randomm/pi-ensemble/issues/64)) ([ec4804b](https://github.com/randomm/pi-ensemble/commit/ec4804ba23b66067252bd899e3a60ba870ab58e4))
* **build:** use explicit arithmetic instead of post-increment ([44050d7](https://github.com/randomm/pi-ensemble/commit/44050d7fa694536936f0f3e91a67144cd4944089))
* **ci:** make test-runs tolerate missing ensemble-runs dir ([9859cc0](https://github.com/randomm/pi-ensemble/commit/9859cc074d14c46b86179b1e54f129d068ed45d9))
* **permissions:** correct agents.json path resolution — root cause of prompt fatigue ([#83](https://github.com/randomm/pi-ensemble/issues/83)) ([#84](https://github.com/randomm/pi-ensemble/issues/84)) ([467e3a0](https://github.com/randomm/pi-ensemble/commit/467e3a0b584469daefdb9a4e1f99e191b3155b03))
* **permissions:** grant pi-ensemble's own dispatch tools in agents.json ([#85](https://github.com/randomm/pi-ensemble/issues/85)) ([#86](https://github.com/randomm/pi-ensemble/issues/86)) ([9bd34b4](https://github.com/randomm/pi-ensemble/commit/9bd34b4a1da447d19d50b90b5a07031e96112bad))
* **permissions:** use nested allowlist, transparent quoted args, cache cleanup ([#75](https://github.com/randomm/pi-ensemble/issues/75)) ([#81](https://github.com/randomm/pi-ensemble/issues/81)) ([aa809a0](https://github.com/randomm/pi-ensemble/commit/aa809a01fb24520bcb28ae316d82d1464a88e145))
* **release:** use plain v0.x.y tag format instead of monorepo prefix ([8deaf3e](https://github.com/randomm/pi-ensemble/commit/8deaf3e3ce9a012ec158444291a1a19bb105df76))
* **runs:** paginate batch list so it fits the screen ([00d974a](https://github.com/randomm/pi-ensemble/commit/00d974a0d5182c3f512d8d9b93fd0b03860f0e15))
* **security:** enable Dependabot for npm + github-actions ([09c9c8c](https://github.com/randomm/pi-ensemble/commit/09c9c8c2eb8b119b9d309049bbcb3fb528ea24a2))
* **spawn:** cap child wall-clock and propagate Esc cancellation ([2d42a7d](https://github.com/randomm/pi-ensemble/commit/2d42a7d4fbd3f1fe04d4ca327cac33a8d4764f97))

## [0.10.1](https://github.com/randomm/pi-ensemble/compare/v0.10.0...v0.10.1) (2026-05-28)


### Bug Fixes

* **permissions:** correct agents.json path resolution — root cause of prompt fatigue ([#83](https://github.com/randomm/pi-ensemble/issues/83)) ([#84](https://github.com/randomm/pi-ensemble/issues/84)) ([467e3a0](https://github.com/randomm/pi-ensemble/commit/467e3a0b584469daefdb9a4e1f99e191b3155b03))

## [0.10.0](https://github.com/randomm/pi-ensemble/compare/v0.9.0...v0.10.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **work:** pair_watch tool removed. Workflows that called pair_watch directly must switch to dispatch_specialist (role: developer) followed by adversarial_loop on the resulting diff. The /work slash command already does this. Pre-1.0 alpha; no deprecation shim.

### Features

* **#24:** delegate /start context gathering to explore subagent ([#40](https://github.com/randomm/pi-ensemble/issues/40)) ([adf4ffc](https://github.com/randomm/pi-ensemble/commit/adf4ffc3981f5ebc99aa4ddfb0a170691386ac30))
* **#45-47:** per-host MCP server support ([#48](https://github.com/randomm/pi-ensemble/issues/48)) ([19e704b](https://github.com/randomm/pi-ensemble/commit/19e704b82731e7bcaf419c3e88b1a93db783b782))
* **#49:** unified layered permission system with interactive onboarding ([#53](https://github.com/randomm/pi-ensemble/issues/53)) ([ddda31b](https://github.com/randomm/pi-ensemble/commit/ddda31b75318b436330a39000843d19952a96bcf))
* **#54,#55:** pattern-based bash decision caching + AGENTS.md MEDIUM+ rule ([#56](https://github.com/randomm/pi-ensemble/issues/56)) ([faf0e18](https://github.com/randomm/pi-ensemble/commit/faf0e18c9a2f0636326d656e381f81da0524e730))
* async dispatch pivot + adapter architecture + PM safety + branch hygiene ([#20](https://github.com/randomm/pi-ensemble/issues/20)) ([0c6af0c](https://github.com/randomm/pi-ensemble/commit/0c6af0cf97fbf7a89957c1126a2fa12b868a60b9))
* **audit:** finalize docs and smoke coverage ([#57](https://github.com/randomm/pi-ensemble/issues/57)) ([85bbccf](https://github.com/randomm/pi-ensemble/commit/85bbccf54f38aa5d6ebad89dfe7cc691d96d3cb5))
* **deps:** switch context7 integration from MCP to ctx7 CLI ([58b7a6d](https://github.com/randomm/pi-ensemble/commit/58b7a6d7e6ca17ac68353719e257b05c92f06a1f))
* **epic#31:** add /audit slash command for standards-first repo inspection ([#42](https://github.com/randomm/pi-ensemble/issues/42)) ([f4c4db2](https://github.com/randomm/pi-ensemble/commit/f4c4db2794796729205aef812bb2c57f5d5215c8))
* **observability:** stream live subagent progress via onUpdate ([857be5c](https://github.com/randomm/pi-ensemble/commit/857be5c5b006b77f63fa50d99beab8419c3b52dc))
* **pair-watch:** live asymmetric pair-coding gate replaces developer + adversarial_loop ([#27](https://github.com/randomm/pi-ensemble/issues/27)) ([4add3a5](https://github.com/randomm/pi-ensemble/commit/4add3a551d2a27ed4c39dc94868c4bf875b901b0))
* **runs:** auto-prune to keep last N batches on disk ([7cdcba9](https://github.com/randomm/pi-ensemble/commit/7cdcba9e941904213cb8da228f8171290cad8c9d))
* **work:** remove pair_watch — restore developer + adversarial_loop gate ([#65](https://github.com/randomm/pi-ensemble/issues/65)) ([#70](https://github.com/randomm/pi-ensemble/issues/70)) ([84b5290](https://github.com/randomm/pi-ensemble/commit/84b529055a5458cd8d888c261c7c19ed9600482c))


### Bug Fixes

* **#63:** harden bash wildcard permission caching ([#64](https://github.com/randomm/pi-ensemble/issues/64)) ([ec4804b](https://github.com/randomm/pi-ensemble/commit/ec4804ba23b66067252bd899e3a60ba870ab58e4))
* **build:** use explicit arithmetic instead of post-increment ([44050d7](https://github.com/randomm/pi-ensemble/commit/44050d7fa694536936f0f3e91a67144cd4944089))
* **ci:** make test-runs tolerate missing ensemble-runs dir ([9859cc0](https://github.com/randomm/pi-ensemble/commit/9859cc074d14c46b86179b1e54f129d068ed45d9))
* **release:** use plain v0.x.y tag format instead of monorepo prefix ([8deaf3e](https://github.com/randomm/pi-ensemble/commit/8deaf3e3ce9a012ec158444291a1a19bb105df76))
* **runs:** paginate batch list so it fits the screen ([00d974a](https://github.com/randomm/pi-ensemble/commit/00d974a0d5182c3f512d8d9b93fd0b03860f0e15))
* **security:** enable Dependabot for npm + github-actions ([09c9c8c](https://github.com/randomm/pi-ensemble/commit/09c9c8c2eb8b119b9d309049bbcb3fb528ea24a2))
* **spawn:** cap child wall-clock and propagate Esc cancellation ([2d42a7d](https://github.com/randomm/pi-ensemble/commit/2d42a7d4fbd3f1fe04d4ca327cac33a8d4764f97))

## [0.9.0](https://github.com/randomm/pi-ensemble/compare/v0.8.0...v0.9.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **work:** pair_watch tool removed. Workflows that called pair_watch directly must switch to dispatch_specialist (role: developer) followed by adversarial_loop on the resulting diff. The /work slash command already does this. Pre-1.0 alpha; no deprecation shim.

### Features

* **work:** remove pair_watch — restore developer + adversarial_loop gate ([#65](https://github.com/randomm/pi-ensemble/issues/65)) ([#70](https://github.com/randomm/pi-ensemble/issues/70)) ([84b5290](https://github.com/randomm/pi-ensemble/commit/84b529055a5458cd8d888c261c7c19ed9600482c))


### Bug Fixes

* **#63:** harden bash wildcard permission caching ([#64](https://github.com/randomm/pi-ensemble/issues/64)) ([ec4804b](https://github.com/randomm/pi-ensemble/commit/ec4804ba23b66067252bd899e3a60ba870ab58e4))

## [0.8.0](https://github.com/randomm/pi-ensemble/compare/v0.7.0...v0.8.0) (2026-05-27)


### Features

* **audit:** finalize docs and smoke coverage ([#57](https://github.com/randomm/pi-ensemble/issues/57)) ([85bbccf](https://github.com/randomm/pi-ensemble/commit/85bbccf54f38aa5d6ebad89dfe7cc691d96d3cb5))

## [0.7.0](https://github.com/randomm/pi-ensemble/compare/v0.6.0...v0.7.0) (2026-05-27)


### Features

* **#45-47:** per-host MCP server support ([#48](https://github.com/randomm/pi-ensemble/issues/48)) ([19e704b](https://github.com/randomm/pi-ensemble/commit/19e704b82731e7bcaf419c3e88b1a93db783b782))
* **#49:** unified layered permission system with interactive onboarding ([#53](https://github.com/randomm/pi-ensemble/issues/53)) ([ddda31b](https://github.com/randomm/pi-ensemble/commit/ddda31b75318b436330a39000843d19952a96bcf))
* **#54,#55:** pattern-based bash decision caching + AGENTS.md MEDIUM+ rule ([#56](https://github.com/randomm/pi-ensemble/issues/56)) ([faf0e18](https://github.com/randomm/pi-ensemble/commit/faf0e18c9a2f0636326d656e381f81da0524e730))
* **epic#31:** add /audit slash command for standards-first repo inspection ([#42](https://github.com/randomm/pi-ensemble/issues/42)) ([f4c4db2](https://github.com/randomm/pi-ensemble/commit/f4c4db2794796729205aef812bb2c57f5d5215c8))

## [0.6.0](https://github.com/randomm/pi-ensemble/compare/v0.5.0...v0.6.0) (2026-05-26)


### Features

* **#24:** delegate /start context gathering to explore subagent ([#40](https://github.com/randomm/pi-ensemble/issues/40)) ([adf4ffc](https://github.com/randomm/pi-ensemble/commit/adf4ffc3981f5ebc99aa4ddfb0a170691386ac30))

## [0.5.0](https://github.com/randomm/pi-ensemble/compare/v0.4.0...v0.5.0) (2026-05-26)


### Features

* **pair-watch:** live asymmetric pair-coding gate replaces developer + adversarial_loop ([#27](https://github.com/randomm/pi-ensemble/issues/27)) ([4add3a5](https://github.com/randomm/pi-ensemble/commit/4add3a551d2a27ed4c39dc94868c4bf875b901b0))

## [0.4.0](https://github.com/randomm/pi-ensemble/compare/v0.3.0...v0.4.0) (2026-05-21)


### Features

* async dispatch pivot + adapter architecture + PM safety + branch hygiene ([#20](https://github.com/randomm/pi-ensemble/issues/20)) ([0c6af0c](https://github.com/randomm/pi-ensemble/commit/0c6af0cf97fbf7a89957c1126a2fa12b868a60b9))
* **runs:** auto-prune to keep last N batches on disk ([7cdcba9](https://github.com/randomm/pi-ensemble/commit/7cdcba9e941904213cb8da228f8171290cad8c9d))


### Bug Fixes

* **runs:** paginate batch list so it fits the screen ([00d974a](https://github.com/randomm/pi-ensemble/commit/00d974a0d5182c3f512d8d9b93fd0b03860f0e15))

## [0.3.0](https://github.com/randomm/pi-ensemble/compare/v0.2.0...v0.3.0) (2026-05-20)


### Features

* **observability:** stream live subagent progress via onUpdate ([857be5c](https://github.com/randomm/pi-ensemble/commit/857be5c5b006b77f63fa50d99beab8419c3b52dc))

## [0.2.0](https://github.com/randomm/pi-ensemble/compare/v0.1.2...v0.2.0) (2026-05-20)


### Features

* **deps:** switch context7 integration from MCP to ctx7 CLI ([58b7a6d](https://github.com/randomm/pi-ensemble/commit/58b7a6d7e6ca17ac68353719e257b05c92f06a1f))

## [0.1.2](https://github.com/randomm/pi-ensemble/compare/v0.1.1...v0.1.2) (2026-05-20)


### Bug Fixes

* **release:** use plain v0.x.y tag format instead of monorepo prefix ([8deaf3e](https://github.com/randomm/pi-ensemble/commit/8deaf3e3ce9a012ec158444291a1a19bb105df76))
* **security:** enable Dependabot for npm + github-actions ([09c9c8c](https://github.com/randomm/pi-ensemble/commit/09c9c8c2eb8b119b9d309049bbcb3fb528ea24a2))

## [0.1.1](https://github.com/randomm/pi-ensemble/compare/v0.1.0...v0.1.1) (2026-05-20)

### Bug Fixes

* **ci:** make test-runs tolerate missing ensemble-runs dir ([9859cc0](https://github.com/randomm/pi-ensemble/commit/9859cc074d14c46b86179b1e54f129d068ed45d9))
* **spawn:** cap child wall-clock and propagate Esc cancellation ([2d42a7d](https://github.com/randomm/pi-ensemble/commit/2d42a7d4fbd3f1fe04d4ca327cac33a8d4764f97))

## [0.1.0] — 2026-05-19

Initial alpha release.

Tested against `pi` (`@earendil-works/pi-coding-agent`) **0.75.3**.

### Added

- **Five slash commands** for the project-manager workflow:
  `/start`, `/research`, `/plan`, `/work`, `/review`.
- **Three utility commands**: `/ensemble-debug` (config introspection),
  `/ensemble-model` (interactive per-role model picker, persisted to
  `~/.pi/agent/ensemble-models.json`), `/runs` (browse subagent transcripts).
- **Six specialist roles** with separate system prompts assembled from
  `agents-base/` + `modules/` + `manifests/`: project-manager, developer,
  ops, explore, adversarial-developer, code-review-specialist.
- **Parallel dispatch** — `dispatch_specialist` and `dispatch_parallel` tools
  spawn role-pinned child Pi processes via `Promise.all`. Up to 10 concurrent.
- **Adversarial gate** — mandatory `adversarial_loop` tool runs up to 3 rounds
  of adversarial review + developer fix before code can be committed.
- **Six-pass code review** — `dispatch_lens_review` tool fans out one
  `code-review-specialist` per lens (SECURITY, ERROR_HANDLING, TYPE_SAFETY,
  PERFORMANCE, ARCHITECTURE, SIMPLICITY), each pinned to its lens-specific
  skill via `--skill <path>`. Findings come back as schema-validated
  `report_finding` tool calls; the parent deduplicates by `(path, line, title)`,
  applies precedence (SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE >
  ARCHITECTURE > SIMPLICITY), and computes a verdict
  (APPROVED / ISSUES_FOUND / CRITICAL_ISSUES_FOUND).
- **Per-child transcripts** persisted to
  `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>[-<tag>].json`. Replay with
  `pi --session <path>` or browse via `/runs`.
- **Model resolution** with five-layer priority: per-call override → saved
  per-role config → saved all-subagents config → `PI_ENSEMBLE_MODEL_<ROLE>`
  env var → `PI_ENSEMBLE_SUBAGENT_MODEL` env var → Pi default.
- **19 bundled skills** under `skill/` covering Python, Rust, Rails,
  React/React-Native, Go, shell, Postgres, devops, doc-maturity, the six
  code-review lenses, and more. Symlinked into `~/.pi/agent/skills/` at
  install time.
- **Modular prompt build** via `build.sh` — 28 reusable modules under
  `modules/` compose into six per-role system prompts. Single source of
  truth for vipune doctrine, output standards, async-task discipline,
  worktree workflow, quality gates, etc.

### Known limitations

- No per-role tool allowlists yet — specialists inherit Pi's default
  permissions. Use a sandbox repo until comfortable with how the model
  behaves. Tracked as a post-launch issue (planned integration:
  `@randomm/pi-permissions`).
- Worktree management uses raw `git worktree …` calls. Migration to the
  safer `@randomm/pi-worktree` programmatic API is planned.
- Six-pass review has no per-lens retry. If a lens fails to spawn or
  returns non-zero, that lens contributes zero findings but does not block
  the verdict.

[0.1.0]: https://github.com/randomm/pi-ensemble/releases/tag/v0.1.0
