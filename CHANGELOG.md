# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
After v0.1.0, version bumps are driven automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/).

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

* adopt codebase-memory-mcp; deprecate meadow + colgrep across the doctrine ([#191](https://github.com/randomm/pi-ensemble/issues/191)) ([4fe1cb7](https://github.com/randomm/pi-ensemble/commit/4fe1cb7f5b49f6239bb6e371b470d6a69b9e0a64))
* **ci:** publish sandbox image to GHCR; install.sh pulls instead of builds ([#219](https://github.com/randomm/pi-ensemble/issues/219)) ([a0ceb91](https://github.com/randomm/pi-ensemble/commit/a0ceb91da51cf04c78ebae38208a3c848da5a3f2))
* dispatch_peek/steer transparently handle adversarial_loop jobIds ([#186](https://github.com/randomm/pi-ensemble/issues/186)) ([5082e85](https://github.com/randomm/pi-ensemble/commit/5082e859728678127f701396c0d24d4d10299b3d))
* extend permission-guard into subagents (per-role allowlist applies universally) ([#187](https://github.com/randomm/pi-ensemble/issues/187)) ([56bcd6a](https://github.com/randomm/pi-ensemble/commit/56bcd6a7728ada2ae7b34e39e3a2791d6ba60f3d))
* **sandbox:** --add-host plumbing so mesh network/LAN hostnames resolve inside container ([#204](https://github.com/randomm/pi-ensemble/issues/204)) ([aad53cb](https://github.com/randomm/pi-ensemble/commit/aad53cb46691b716dcd92059f3d2a903b23c4175))
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
