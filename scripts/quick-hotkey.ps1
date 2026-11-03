# Ctrl+Alt+N anywhere opens WorkDesk quick add in a small app-style window. Runs hidden; started at logon by the "WorkDesk Hotkey" task.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Hot {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr h, uint a, uint b);
}
'@
$MOD_ALT = 1; $MOD_CONTROL = 2; $MOD_NOREPEAT = 0x4000
if (-not [Hot]::RegisterHotKey([IntPtr]::Zero, 1, $MOD_ALT -bor $MOD_CONTROL -bor $MOD_NOREPEAT, 0x4E)) { exit 1 }  # 0x4E = N
$url = 'http://localhost:4321/quick.html'
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
Add-Type -AssemblyName System.Windows.Forms
# Size and place of the quick-add window: edit these. $TOP is the fraction of the screen height from the top (0.25 = upper quarter).
$W = 620; $H = 190; $TOP = 0.25
# Own browser profile, so Edge does not reopen it at the size and place it remembers from last time.
$profileDir = Join-Path $env:LOCALAPPDATA 'WorkDesk' | Join-Path -ChildPath 'quick-profile'
$msg = New-Object Hot+MSG
while ([Hot]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) {
  if ($msg.m -eq 0x0312) {  # WM_HOTKEY
    if (Test-Path $edge) {
      $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
      $x = [int]($wa.Left + ($wa.Width - $W) / 2); $y = [int]($wa.Top + $wa.Height * $TOP)
      Start-Process $edge -ArgumentList "--app=$url", "--window-size=$W,$H", "--window-position=$x,$y", "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check'
    } else { Start-Process $url }
  }
}
