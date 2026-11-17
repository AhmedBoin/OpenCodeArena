# Arena — the old rounds design (superseded)

> **Status: historical.** The round-based design this file described is gone:
> no phases, no judge score table, no native delegation, no `compete`/`team`/
> `evolve`, no worktrees. The current design is
> [`field-design.md`](field-design.md); the continuous field replaced rounds in
> November 2026.

The intent that survived:

- the Orchestrator turns a request into a contract (objective, constraints,
  success criteria, verification command, non-goals);
- every agent works from its own angle and reports evidence, not opinion;
- the room is a real conversation you can join, with small messages and full
  proof behind a details toggle;
- a result is not accepted without evidence a command produced;
- the core stays host-free, so another harness needs one adapter;
- no changes to OpenCode's source, only public plugin surfaces.

What changed:

- the proof is now a single claim gate (verification + peer falsification +
  evidence) instead of a scored verdict;
- work is continuous, so an agent can ignore a message, ask a peer, or change
  its own mind;
- the Foreman is the master of the board, not a phase driver;
- delivery is safe-point by construction: orders steer, peer facts wait in an
  inbox.
