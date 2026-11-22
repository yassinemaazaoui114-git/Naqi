; Inno Setup recipe (T7.1): packs the folder made by build/make-installer.mjs into one installer.
; Installs for the current user only (no administrator password needed), into %LOCALAPPDATA%\Programs\Naqi.
; Its own AppId (old Naqi's installer used another one); the data folder is old Naqi's Naqi-data (T7.2).
#define AppName "Naqi"
#ifndef AppVersion
  #define AppVersion "6.0.0"
#endif
#ifndef SourceDir
  #error Run npm run installer instead of compiling this file directly
#endif

[Setup]
AppId={{4C7E2B19-93D5-4E0A-B6F1-2A8D5C3E7F40}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Yassine
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Naqi-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\Naqi.exe
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/normal
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=6

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\Naqi.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Naqi.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Naqi.exe"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The engine writes Python's cache files next to itself; remove the whole folder so nothing is left behind
Type: filesandordirs; Name: "{app}"
