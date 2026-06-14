' Runs the TV -> PC switcher with NO console window at all.
' Great for a taskbar/Start tile you tap and forget. Downside: if the
' token expired you get no visible error. Use TV-to-PC.cmd while testing.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
' This launcher lives in shortcuts/; run npm from the project root one level up.
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
' 0 = hidden window, False = don't wait for it to finish
sh.Run "cmd /c npm start", 0, False
