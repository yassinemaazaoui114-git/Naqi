"""Gives the installed Naqi.exe (Electron's program, renamed) Naqi's icon and name, so Windows shows "Naqi" with its
logo in Explorer, the taskbar and Task Manager instead of Electron's. Uses PyInstaller's own Windows helpers, so
nothing new is installed. Run by build/make-installer.mjs: py -3.12 build/exe_resources.py <exe> <ico> <version>
"""
import sys
import tempfile

from PyInstaller import config
from PyInstaller.utils.win32 import icon, versioninfo as v

exe, ico, version = sys.argv[1:4]
config.CONF["workpath"] = tempfile.gettempdir()   # CopyIcons expects to run inside a PyInstaller build
icon.CopyIcons(exe, ico)
nums = tuple(int(n) for n in (version.split(".") + ["0"] * 4)[:4])
strings = [("CompanyName", "Yassine"), ("FileDescription", "Naqi"), ("FileVersion", version),
           ("InternalName", "Naqi"), ("OriginalFilename", "Naqi.exe"), ("ProductName", "Naqi"),
           ("ProductVersion", version)]
info = v.VSVersionInfo(
    ffi=v.FixedFileInfo(filevers=nums, prodvers=nums),
    kids=[v.StringFileInfo([v.StringTable("040904B0", [v.StringStruct(k, s) for k, s in strings])]),
          v.VarFileInfo([v.VarStruct("Translation", [0x0409, 1200])])])
v.write_version_info_to_executable(exe, info)
print("icon and version set:", exe)
