---
'tencil': minor
---

Add OMP as an agent: `--provider omp` runs `omp acp` in the project's folder with your own OMP settings and login. Setup finds `omp` on the PATH or in `~/.bun/bin` (`OMP_COMMAND` overrides it), and `--model` takes an omp model selector.

Stop initialization with an error when package installation fails instead of reporting that setup finished.
