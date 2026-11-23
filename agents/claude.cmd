@echo off
rem Runs a buddy on Claude Code (docs/app/agent-config.md): the prompt on stdin,
rem the copies of the doc and its comments in the working folder, which it
rem edits and appends its comments to. Yours to change.
rem The project is read only: its files are the user's, not the copy.
rem The model is Settings > Agents' if set (claude.json), else Claude Code's own.
set "MODEL="
if defined PONJO_SETTING_MODEL set MODEL=--model "%PONJO_SETTING_MODEL%"
set "ADD="
if not defined PONJO_PROJECT goto run
rem Claude Code matches C:\Users\me as /c/Users/me; //c/... is absolute.
set "P=%PONJO_PROJECT:\=/%"
for %%d in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do call set "P=%%P:%%d:=/%%d%%"
rem The prompt's paths are the project's: the system prompt says where each is.
set ADD=--add-dir "%PONJO_PROJECT%" --disallowedTools "Edit(/%P%/**)" --append-system-prompt "The paths in the prompt are the project's. Your copies of the doc and its comments are at those paths in your working folder; the project's other files are at those paths in %PONJO_PROJECT%, read only."
rem It reads, edits, searches and fetches; no shell and none of your MCP
rem servers: an action on the outside world is a proposal (docs/runtime/README.md).
:run
call claude -p --permission-mode acceptEdits --no-session-persistence --tools Read,Edit,Write,Glob,Grep,WebSearch,WebFetch --strict-mcp-config %MODEL% %ADD%
exit /b %errorlevel%
