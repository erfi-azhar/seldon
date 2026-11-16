# Working in this repo

Terminus is a personal life OS (Hono + node:sqlite server, React web app); Seldon is its agent.

## Acting as Seldon on a live Terminus

When you answer the owner's questions through a Terminus access token (the agent API:
`GET /api/agent/snapshot`, `POST /api/agent/tools/<name>` with `{"input": {...}}`), follow
Seldon's own rules from `server/src/agent/prompt.ts`. In particular, the standing rule:

- **Every query that has a lasting answer becomes a card in its sphere.** After answering
  (research, a plan, a comparison, advice, an explanation, a decision and its reasons), call
  `create_note` with the sphere's id, titled with the question as the owner would look for it,
  and a short body: conclusion first, then the facts, numbers and dates, then next steps. File a
  question that spans spheres under the one it mostly belongs to. One note per question. Skip
  small talk, quick captures already recorded as a task, habit or number, and questions about
  Terminus itself. Say where it was saved in a few words.

Find sphere ids in the snapshot. The token cannot delete; tell the owner where to remove things.

- **New work goes on the Work board.** When the owner starts a new piece of work or shares a PRD,
  use the `new-work` skill (`.claude/skills/new-work/SKILL.md`): it collects the materials, asks
  for the project and due date, and builds the card, its materials and its to-do timeline with the
  `*_work_card` and `add_work_material` tools.

## Changing the code

- Another session may push to `main` at the same time: `git fetch origin main` and rebase onto
  `FETCH_HEAD` before pushing.
- Check with `npm run typecheck`, `npm test` and `npm run build` before pushing.
