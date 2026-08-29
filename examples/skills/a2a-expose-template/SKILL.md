---
name: echo-status
description: Reply with this personality's current status when a trusted A2A peer asks for it. A starter template for exposing a skill to A2A peers — copy it, don't run it from here.
version: 1.0.0
author: ethosagent
tags: [a2a, template, example]
required_tools: []

ethos:
  # Flip to `true` to advertise this skill on the trusted-peer A2A card
  # (`ethos a2a identity`, `ethos a2a status`). Stays private (unset =
  # false) until an operator opts in — see the A2A how-to in docs/.
  #
  # Do NOT copy skills/framework/a2a-communicate or a2a-handle-inbound this
  # way instead of this template. Both declare `required_tools: [a2a_send]`,
  # which under A2A's fail-closed narrowing (plan T0.2) hands an inbound
  # peer's turn exactly one tool: the one that calls more agents.
  exposeToAgents: false
---

# Echo status

Use this skill when an authenticated A2A peer names `echo-status` in
`params.skill` and asks about this agent's current status or availability.

Reply with a short, plain-language status update — no more than a few
sentences. Do not reach for a tool this skill has not declared in
`required_tools` above: the runtime narrows this turn's toolset to exactly
that list (intersected with whatever the personality already allows — it
can never grant more than the personality's own toolset). If you copy this
template for a skill that genuinely needs a tool, add it to
`required_tools`; an empty list here is intentional for a pure status reply.

## How to use this template

1. Copy this whole directory into your personality's own skills directory:
   `~/.ethos/personalities/<your-personality-id>/skills/echo-status/`.
2. Rename it and edit `name`, `description`, and `required_tools` for your
   own use case.
3. Set `ethos.exposeToAgents: true` in the frontmatter above once you are
   ready for peers to see it on your trusted-peer card.
4. Run `ethos a2a status` to confirm the zero-skills warning has cleared.
