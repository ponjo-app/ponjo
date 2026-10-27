@echo off
rem Runs a buddy on Claude Code (docs/agent-config.md): the prompt on stdin,
rem the doc's copy in the working folder, the reply on stdout. Yours to change.
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
:run
call claude -p --permission-mode acceptEdits --no-session-persistence %MODEL% %ADD%
exit /b %errorlevel%
