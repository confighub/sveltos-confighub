# Blog

The supporting material for each post we publish about this work. A post lives on the blog; what
a reader needs in order to check it, understand it or run it lives here.

## Posts

| Folder | Post | Status |
| --- | --- | --- |
| [`2026-11-ai-chaos-in-production/`](2026-11-ai-chaos-in-production/) | [No human in the loop? Agents manage a Sveltos fleet in ConfigHub](https://confighub.com/blog/no-human-in-the-loop-agents-manage-a-sveltos-fleet-in-confighub-178205600338). Two AI agents on a Sveltos and ConfigHub fleet: three outages caused on purpose, including a nightly repave | Published 6 November 2026 |

## What every post folder holds

The same five things, with the same names, so a reader who has seen one knows where to look in
the next.

| File | What it is |
| --- | --- |
| `README.md` | What the post is, where it is published, and what is in the folder |
| `intro.md` | The whole story at a walking pace, written for someone who has read nothing else of ours. No jargon |
| `agent-guide.md` | Written for a reader's own AI agent: how to answer questions about the post, and how to reproduce its examples |
| `captions.md` | Each screenshot, where the image file lives, and what the reader should notice |
| `diagram.svg` and `diagram.png` | One diagram, in both an editable and a droppable form |
| `images/` | The screenshots themselves |

**A pack is self-contained.** Every image the post uses is copied into the post's own `images/`,
so the folder can be handed to anybody, or to another AI, and nothing it needs sits outside it.
`captions.md` records where each image came from, so the original run is still traceable. The
cost of this is two copies of each screenshot in the repository, and that is the right trade:
a pack with a dangling path is useless, and a duplicated image is merely duplicated.

## Adding a post

1. Copy [`_template/`](_template/) to `YYYY-MM-short-slug/`. Dated folders sort in publication
   order and the slug says what it is.
2. Fill in the five files. Each one is finished when a stranger could use it without asking a
   question.
3. Add a row to the table above.

Three rules the template exists to carry:

- **The reader can check everything.** Every number comes out of a recorded run, and the guide
  says which file and which lines.
- **Say what has not been done.** A step that was run by hand rather than by an agent, a view
  that is still a mock, a version that has moved on. These go in writing, not in a footnote.
- **No marketing.** These pages explain and reproduce. They do not sell.
