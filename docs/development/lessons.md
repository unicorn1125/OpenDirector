# Development lessons

This record highlights risks identified from actual fixes. It does not imply that the same defects remain in the current code. Consult relevant lessons before a change and verify the current implementation and tests; the [validation guide](validation.md) defines commands and evidence requirements.

When implementing or reviewing a change, trace the affected behavior from its entry point to persisted state and side effects, and inspect related entry points for the same defect when relevant. Apply the checks that fit the change and record verification and remaining gaps as described in the validation guide.

When work exposes a consequential risk or a recurring problem, add a lesson or update an existing one with the trigger, failure, suggested check, and a verifiable issue, PR, or commit. Add evidence when a problem recurs. Move requirements proven durable in practice into the validation guide, and revise or remove outdated lessons. Do not count distinct defects as repetitions of the same problem, or add a lesson for every routine fix.

## Model capabilities and requests can diverge

- **Trigger:** Creating a generation node, configuring model capabilities, or constructing a provider request.
- **Lesson:** Defaults, reference slots, and request parameters can fail at different layers. Commit `f623fedd` corrected node defaults that did not match the adapter; `f9e358cf` filled the last-frame slot for models that support it; `1bafbbd6` corrected an integer duration sent to Ark as a float.
- **Check:** Trace representative input from the relevant UI or Agent entry point through backend validation to the provider request. Check that unsupported input does not create a job. Distinguish protocol mocks from real service evidence.

## Operations across boundaries can lose identity or context

- **Trigger:** Importing a project, referencing assets across conversation turns, or switching projects during a run.
- **Lesson:** Commit `e8c29c9b` fixed provenance and creation-order problems in a canvas archive round trip; `44857448` fixed asset context across turns; `00d8899c` fixed Agent runs stopping when switching projects. These are different defects, but each shows that the current display alone cannot establish state and context.
- **Check:** As relevant to the change, inspect persisted object identities, references, and execution inputs after conversion or recovery. Reopen the project or reconnect to the run when needed, and verify the actual result.

## Baseline failures still need tracking

- **Trigger:** A relevant test fails and comparison shows that it also fails on the baseline.
- **Lesson:** Commits `28d61dce` and `0a5630ac` each recorded the same generation test failing on the baseline. That historical record does not establish whether the test still fails today.
- **Check:** Record the versions and results used in the comparison. Link an existing issue or create one when appropriate. Report the check as failed; a baseline failure is not a pass.

## Shared browser lanes are not isolated by a fresh page alone

- **Trigger:** Adding a browser script to the nightly extended, production, or perf lane, or changing model setup, session leases, or preview serving.
- **Lesson:** Nightly runs many scripts against one creation server. The first-run welcome covers the canvas until every model kind exists, so a script that does not dismiss it fails when it is the first click on a fresh server. A script that opens whichever project sorts first can hit a lease still held by an earlier script. Fixture scripts that read `CREATION_WEB_URL` stay on the regular dev server unless the lane overrides it. `vite preview` does not serve `/src` or `/tests` modules.
- **Check:** Dismiss `opendirector.modelSetup.v1` before the first navigation, and open a project the script itself created when the server is already populated. Point assistant-fixture scripts at their own web URL, and keep `/src` or `/tests` imports out of the production lane. `npm run check:browser-manifest` checks the dismissal, the fixture URL, and those imports.

## Provider result URLs are an independent trust boundary

- **Trigger:** Accepting a cross-origin result URL from a configured model service.
- **Lesson:** [PR #210](https://github.com/ThinkFlowLab/OpenDirector/pull/210) added compatible image CDN downloads without provider credentials, but initially left arbitrary local and private hosts reachable. Credential isolation and bounded responses do not constrain the network destination.
- **Check:** Preserve explicitly configured local service origins; validate all DNS answers for unconfigured hosts, connect to a checked public IP while retaining the original Host and TLS identity, and revalidate every redirect. Cover local metadata addresses, IPv6, mixed DNS answers, redirect loops, and recovery without another model submission.
