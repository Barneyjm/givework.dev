# Givework Volunteer Agreement

**Version 2026-07-08 · DRAFT — pending review by counsel. Not yet legal advice
or a final contract.**

This is the agreement every volunteer accepts before non-public (internal or
sensitive) tasks unlock. Acceptance is recorded against your account
(`givework agree`), and a new version of this document re-gates everyone until
they re-accept. It is deliberately written in plain language.

## 1. What you are donating

You are donating **compute**: spare capacity on your own Claude subscription,
run through your own machine. You are not providing professional services to
Givework or to any nonprofit, you are not their employee, contractor, or agent,
and you have no direct relationship with the nonprofits whose tasks you run.

## 2. What Givework does with your output

Task results are submitted to the Givework platform, which reviews and delivers
them to nonprofits as **AI-generated drafts, as-is**. You make no warranty about
the output of your agent, and Givework presents it to nonprofits under its own
terms, not as your work product.

## 3. How you handle task data

Some tasks carry a nonprofit's internal or personal data (structured personal
identifiers are redacted before a task reaches you, but text can still be
sensitive). For every non-public task you check out, you agree to:

- **Use the data only to complete that task.** No other use, ever.
- **Not share it** with any person or service beyond the `claude -p` execution
  the runner performs.
- **Not deliberately retain it.** The runner deletes each task's Claude CLI
  session transcript automatically when the run finishes — don't disable or
  circumvent that cleanup, and delete any other local artifacts of a task when
  it completes.
- **Report incidents.** If task data is exposed — a compromised machine, an
  accidental paste, anything — email hello@givework.dev promptly.

## 4. Running tasks honestly

- Submit only genuine output from executing the task; never fabricate results
  or costs.
- Don't attempt to identify, contact, or solicit the nonprofits behind tasks.
- Don't probe, bypass, or test the platform's budget and trust controls except
  through responsible disclosure to hello@givework.dev.

## 5. Termination

You can stop volunteering at any time — walk away, nothing to cancel. Givework
can suspend or remove any account at its discretion (that's what protects the
nonprofits' data). Sections 3 and 4 survive for data you handled while active.

## 6. No warranty, no liability between you and nonprofits

Givework provides the platform as-is. You and Givework each acknowledge that
nonprofits are told outputs are unreviewed AI drafts requiring their own human
review before use, and that no volunteer owes any duty of care to any nonprofit
through this platform.
