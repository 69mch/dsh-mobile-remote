' run-hidden.vbs - launch a .ps1 with zero visible windows.
' Usage:  wscript.exe run-hidden.vbs "C:\full\path\to\script.ps1"
' Scheduled tasks DSHGatewayMonitor / DSHRemoteGateway use this wrapper so the
' interactive-session powershell never flashes a console ("little black window").
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 1
ps1 = WScript.Arguments(0)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
' 0 = SW_HIDE window, False = do not wait for the child to exit.
sh.Run cmd, 0, False
WScript.Quit 0
