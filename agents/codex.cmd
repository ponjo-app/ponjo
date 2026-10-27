@echo off
rem Runs a buddy on Codex (docs/agent-config.md): the prompt on stdin, the
rem doc's copy in the working folder, the reply on stdout. Yours to change.
rem It reads the project without --add-dir, which would make it writable.
rem The model is Settings > Agents' if set (codex.json), else Codex's own.
set "MODEL="
if defined PONJO_SETTING_MODEL set MODEL=-m "%PONJO_SETTING_MODEL%"
rem The prompt's paths are the project's: in a project, the first instructions
rem say where each is, and the prompt follows them as Codex's stdin block.
set "TASK=-"
if defined PONJO_PROJECT set "TASK=The task is in the stdin block. Its paths are the project's: your copies of the doc and its comments are at those paths in your working folder, and the project's other files at those paths in %PONJO_PROJECT%, read only."
set "REPLY=%TEMP%\ponjo-reply-%RANDOM%.txt"
call codex exec --sandbox workspace-write --skip-git-repo-check %MODEL% --output-last-message "%REPLY%" "%TASK%" 1>&2
set "STATUS=%errorlevel%"
type "%REPLY%" 2>nul
del "%REPLY%" 2>nul
exit /b %STATUS%
