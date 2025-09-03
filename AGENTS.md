- - - # AGENTS.md

      ## Workflow

      - Outputs: **PLAN / PATCH / RUN / NOTE / ASK**.
      - Always start with **PLAN** and wait for human confirmation before **PATCH**.
      - Keep diffs minimal and include a clear rollback instruction.
      - **Only** run whitelisted commands (see **Commands**).

      ## Language / Output Language

      - Default output language: **Simplified Chinese (zh-CN)**.
      - Keep block names as `PLAN / PATCH / RUN / NOTE / ASK`, but the **content within each block must be in Chinese**.
      - **Do not translate** commands, code identifiers, or raw logs; when necessary, add a Chinese explanation beneath the original.
      - Commit messages follow Conventional Commits: `type(scope): Chinese summary` (optionally append an English translation at the end).
      - Switch to English only if the user explicitly requests it.
