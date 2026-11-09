Set sh = CreateObject("WScript.Shell")
node = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions\20.18.0\node-v20.18.0-win-x64\node.exe"
sh.CurrentDirectory = "d:\myshell"
sh.Run """" & node & """ node_modules\electron\cli.js .", 0, False
