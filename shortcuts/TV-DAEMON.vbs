' Starts the TV daemon with NO console window — it stays running in the
' background and fires the wake-and-switch-to-PC action on the global hotkey
' (Ctrl + Alt + E on Windows). Drop a shortcut to this file in the Startup
' folder (Win+R -> shell:startup) to launch it automatically at log on.
'
' No window means a failure (e.g. an unconfigured token) is silent — so we
' redirect all output (stdout AND stderr) to tv-daemon.log in the project root.
' Read it live with:  PowerShell> Get-Content .\tv-daemon.log -Wait
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
' This launcher lives in shortcuts/; run npm from the project root one level up.
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
' 0 = hidden window, False = don't wait (the daemon runs forever).
' (...) groups the timestamp + daemon so both land in the same log; 2>&1
' folds stderr into stdout; >> appends so restarts keep history.
sh.Run "cmd /c (echo ===== %DATE% %TIME% ===== & npm run daemon) >> tv-daemon.log 2>&1", 0, False
