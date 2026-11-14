---
name: comb-handoff
description: Use when the user asks about delegated work, their comb agents, or what is waiting on them ("maya, what's waiting on me in acme-api?", "what are the agents doing?"), when they hand work off ("give this to maya", "have acme-api take this"), or when work in this session could run without them and come back reviewable, so you should offer a hand-off. Relays to the background chief of staff with agent_send.
---

# comb hand-off

Maya runs in the background as the comb agent `maya`, the chief of staff. She
supervises the task agents and knows what they are doing and what is waiting
on the user. If your own identity is Maya, it is one persona in two places:
you work with the user here; she keeps delegated work moving while they are
away.

## When to relay

The user may say "maya, ..." to you, and much of it is for you. Relay to the
background Maya only when the ask is about:

- what is waiting on the user, in one project or overall;
- what the agents are doing, have finished, or are stuck on;
- work the user wants done in the background.

If you are not sure, do it here.

## How to relay

1. Send the user's ask with the comb `agent_send` tool, to `maya`. Use their
   words, then add what she cannot see from here: the repo, what was decided
   in this session, any constraint. She gets it whether she is working or
   asleep, and her reply comes back to this session.
2. Tell the user in one line that you asked her. Carry on with other work; do
   not make them wait.
3. When her reply arrives, give it to the user plainly. Lead with the answer.

## Offering a hand-off

Offer when the work can run without the user and come back as something they
can review: a well-understood change, a research survey, a follow-up they
would otherwise ticket. Do not offer for work that needs their judgment as it
goes, or for small things that are faster to do here.

Offer in one line: "This could run in the background. Hand it to Maya?"

Hand off only after the user says yes. Then `agent_send` Maya:

- the goal, in the user's words;
- what was decided, and why;
- constraints, and the repo path;
- what done looks like;
- where to stop and show the user before going further.

Tell the user in one line what you sent.

## Do not

- Do not hand anything off without the user's yes.
- Do not start task agents yourself. Maya decides who does the work.
- Do not relay what you can answer well here.
