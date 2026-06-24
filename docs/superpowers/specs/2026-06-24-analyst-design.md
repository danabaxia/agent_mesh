 repo/innovation-assessment requests).

## Data flow

1. A request targets a repository or doc corpus ("assess what's novel about repo R").
2. The codebase-mode controller engages; the repo-tree resolver enumerates structure and selects load-bearing files.
3. The depth fetcher reads those files (raw, chunked), the coverage tracker logs what was actually read.
4. Extracted content is run through the provenance tagger → Demonstrated (code) vs. Claimed (docs).
5. The architecture characterizer builds the design picture from Demonstrated evidence.
6. For each candidate innovation, the novelty adversary fans out prior-art searches *to disprove*, returning a calibrated verdict + evidence.
7. The report synthesizer assembles the final cited document:
   - **Demonstrated characteristics** (with file citations)
   - **Project's own claims** (clearly marked unverified)
   - **Prior-art comparison** per candidate innovation
   - **Novelty assessment** with confidence levels (not bare assertions)
   - **Coverage & limits** (files unread, runtime-unobservable, private/dynamic content out of reach)
8. Output returned to the requester. The Analyst remains ask-only — it produces the assessment, implements nothing.

## Testing

Because this is a skill enhancement, tests validate the *process discipline*, not a fixed answer:

- **Depth over README:** on a target where the key mechanism lives in source (not the README), the run reads and cites the relevant source files, not just the landing page.
- **Coverage honesty:** the report's coverage section accurately lists read vs. unread files; a deliberately large/unread region is reported as a blind spot, not glossed over.
- **Claim-vs-evidence separation:** given a repo whose README overstates novelty beyond what the code shows, the output marks the overstated parts **Claimed** and does not assert them as fact (anti-framing regression test).
- **Novelty disproof:** for a candidate "innovation" that is actually common prior art, the novelty adversary finds the prior art and returns `actually-common` rather than echoing the claim.
- **Novelty confidence calibration:** assertions carry confidence levels; no bare "this is novel/first" without prior-art evidence.
- **Limit surfacing:** runtime/performance claims are reported as **unobservable**; a private/authenticated or JS-rendered target is flagged as out of reach, not hallucinated.
- **Fidelity:** large source files are chunked and read in full (truncation detected and handled), verified against a known multi-file fixture.
- **Composition:** the codebase mode coexists with standard `deep-research` runs (a non-repo research query still behaves as before).
- **Trigger accuracy:** the updated skill description activates codebase mode for repo/innovation-assessment requests and not for unrelated fact-finding.

## Out of scope

- **Executing, building, or running the codebase or its demos** — the Analyst is ask-only with no execution; runtime/empirical behavior remains unobservable and is reported as such, never assessed.
- **Private or authenticated repositories** — public web only; private targets need an authenticated path outside this skill.
- **Reliable reading of JS-rendered / dynamic file views** — flagged as a limitation, not solved here.
- **A definitive novelty verdict** — the skill produces a *confidence-calibrated, evidence-backed assessment*, explicitly not an authoritative "this is the first/only."
- **Local full-repo clone/index** — this works over public web fetch within ask-mode; standing up a cloned, fully-indexed analysis environment is a separate (likely do-mode) effort.
- **Changing the Analyst's mode or permissions** — no new write/execute capability; this strengthens reading and reasoning only.
- **Replacing human/maintainer judgment of innovation** — the output informs the mesh's discussion; it does not adjudicate.
- **Non-code artifact deep analysis beyond documents** (e.g. binaries, datasets, media) — text/code/doc corpora only.
