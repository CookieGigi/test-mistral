# Static demo site

Assembled by `.github/workflows/deploy-pages.yml` and published to GitHub Pages:

```
/            →  index.html  (this landing page)
/loop/       →  webllm-agentic-loop  (minimal agentic loop, textarea = context)
/canvas/     →  webllm-agent-canvas  (The Canvas: agent that lives in the textarea)
```

Each subproject keeps its own build in `<subproject>/dist`; the workflow assembles
them under `gh-dist/` with `base: "./"` so both work at their subpaths.
