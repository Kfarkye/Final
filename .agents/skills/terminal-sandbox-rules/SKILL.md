---
name: terminal-sandbox-rules
description: Essential rules for using the exec_command tool, including why shell operators (&&, |) fail and how to properly format commands.
---

# Terminal Sandbox Rules

When using the `exec_command` or `run_command` tool in this workspace, you are operating inside a restricted Node.js `execFile` sandbox. It does **not** run inside a standard bash shell by default.

Follow these rules to ensure your commands succeed:

1. **Never chain commands with `&&`, `||`, or `;`**
   - **Why:** `execFile` passes arguments directly to the binary. It treats `&&` as a literal string argument, which causes commands like `git` or `npm` to fail with syntax errors.
   - **What to do instead:** Run each command sequentially in separate tool calls. If you must run a complex script, write it to a temporary `.sh` script (or `.js` script) and execute the file.

2. **Never use pipes (`|`) or redirects (`>`)**
   - **Why:** Same as above. `grep` or file redirects will be treated as literal arguments by the executable.
   - **What to do instead:** Use dedicated tools (like `grep_search` or `write_file`) or write a `.sh` script and execute it.

3. **Always quote strings properly**
   - **Why:** If you run `git commit -m Fix issue with login`, the parser might split the arguments incorrectly. 
   - **What to do instead:** Always wrap strings in quotes: `git commit -m "Fix issue with login"`.

4. **Do not attempt to use `sh -c` or `bash -c` to bypass these rules**
   - **Why:** `sh` and `bash` are explicitly removed from the allowlist to prevent shell injection. They will immediately fail.

By following these rules, you will avoid unnecessary execution errors!
