; Inno Setup (isteğe bağlı): önce build.bat ile dist\NEXUS üretilmiş olmalı.
[Setup]
AppName=NEXUS
AppVersion=1.0.0
DefaultDirName={autopf}\NEXUS
DefaultGroupName=NEXUS
OutputDir=..\dist
OutputBaseFilename=NEXUS-Kurulum
Compression=lzma2
SolidCompression=yes
SetupIconFile=nexus.ico
UninstallDisplayIcon={app}\NEXUS.exe
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest

[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Files]
Source: "..\dist\NEXUS\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\NEXUS"; Filename: "{app}\NEXUS.exe"
Name: "{autodesktop}\NEXUS"; Filename: "{app}\NEXUS.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Masaüstüne kısayol oluştur"

[Run]
Filename: "{app}\NEXUS.exe"; Description: "NEXUS'u başlat"; Flags: nowait postinstall skipifsilent
