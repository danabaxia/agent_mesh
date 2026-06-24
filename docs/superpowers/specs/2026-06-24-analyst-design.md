# Analyst Deep-Research: Codebase Understanding and Innovation Assessment — Design

**Date:** 2026-06-24
**Status:** Design (pending review)
**Closes:** #487

## Motivation

The Analyst's existing `deep-research` skill is optimised for public-web fact-finding. When asked to characterise a project's architecture or assess what is genuinely novel about a codebase, the current skill stops at README/documentation — missing the source-level evidence needed for calibrated, cited conclusions. Human reviewers, mesh peers, and maintainers frequently ask questions of the form "assess what's novel about repo R" or "characterise the design of library X" — questions that require reading actual source files, not just the landing page.

This spec adds a **codebase mode**: a structured sub-flow that enumerates and reads load-bearing source files, separates Demonstrated evidence (from code) from Claimed assertions (from docs), fans out adversarial prior-art searches per innovation candidate, and produces a confidence-calibrated, cited report with explicit coverage limits.

The Analyst remains **ask-only** throughout — no write or execution permissions are added. This strengthens reading and reasoning only.

## Goals

- **Depth over surface:** enumerate the repository tree; select and read load-bearing files, not just the README or landing page.
- **Demonstrated vs. Claimed:** every architectural characterisation is grounded in code with file citations (Demonstrated); documentation claims are preserved but explicitly labelled Claimed / unverified.
- **Adversarial novelty assessment:** for each candidate innovation, fan out web searches *to disprove* the claim, returning a calibrated verdict with confidence levels rather than echoing the project's self-assessment.
- **Honest coverage:** explicitly report what was read and what could not be reached; runtime/performance claims and private-repo content are surfaced as unobservable limits, never hallucinated.
- **Non-regression:** standard `deep-research` runs (web fact-finding, summarisation) are unaffected — codebase mode is an additive specialisation, not a replacement.

## Trigger

The skill description is updated to describe a two-path routing logic: requests that target the public web for fact-finding continue along the existing path; requests that target a repository or documentation corpus for architecture understanding or novelty evaluation engage codebase mode. Activation patterns include explicit repository analysis ("assess what's novel about project X"), architecture deep-dives ("characterise the design of library Y"), documentation corpus assessments, and general repo/innovation-assessment requests).

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
