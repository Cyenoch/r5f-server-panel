# 拖动 / 缩放窗口的 CPU 测量工具
#
# 用途：量「合成移动（SetWindowPos 风暴）」与「合成缩放」期间某个进程消耗的 CPU，
# 换算成「占一个逻辑核的百分比」与「每次事件的 CPU 毫秒」，并按线程拆出热点。
#
# 背景与实测数据见 docs/solid-gpui-notes.md 的「拖动 / 缩放窗口时 CPU 高」小节：
# 每次 WM_MOVE / WM_SIZE 都会经 gpui 的 bounds_changed() 触发整帧重绘，所以这个工具
# 同时用于「先量基线、改完再量一次」的对照。
#
#   pwsh -File scripts/measure-window-cpu.ps1 -AppPid <pid> -Mode idle   -Seconds 5
#   pwsh -File scripts/measure-window-cpu.ps1 -AppPid <pid> -Mode move   -Seconds 6 -Rate 60
#   pwsh -File scripts/measure-window-cpu.ps1 -AppPid <pid> -Mode resize -Seconds 6 -Rate 60
#
# 读法：pctOfOneCore 是与面板 Task Manager 无关的「单核占比」；cpuMs / (Seconds × Rate)
# 才是每次事件的成本（不同 Rate 之间才可比）。dwmCpuMs 用来排除合成器：它不动才说明
# 成本在被测进程自己身上。
param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [ValidateSet("idle", "move", "resize")][string]$Mode = "idle",
  [int]$Seconds = 6,
  [int]$Rate = 60
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class R5WindowCpu {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -Id $AppPid -ErrorAction Stop
$hwnd = [IntPtr]$proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "PID $AppPid 没有主窗口：换一个进程，或用 Get-Process <name> 里 MainWindowHandle 非零的那个" }

$cores = [Environment]::ProcessorCount
$dwm = Get-Process dwm -ErrorAction SilentlyContinue | Select-Object -First 1

function Get-Snapshot {
  $p = Get-Process -Id $AppPid
  $threads = @{}
  foreach ($thread in $p.Threads) { $threads[$thread.Id] = $thread.TotalProcessorTime.TotalMilliseconds }
  [pscustomobject]@{
    cpuMs = $p.TotalProcessorTime.TotalMilliseconds
    threads = $threads
    dwmMs = if ($dwm) { (Get-Process -Id $dwm.Id).TotalProcessorTime.TotalMilliseconds } else { 0 }
  }
}

$before = Get-Snapshot
$rect = New-Object R5WindowCpu+RECT
[void][R5WindowCpu]::GetWindowRect($hwnd, [ref]$rect)
$baseX = $rect.Left
$baseY = $rect.Top
$stepMs = [int](1000 / $Rate)
$events = $Seconds * $Rate

$start = Get-Date
for ($i = 0; $i -lt $events; $i++) {
  $phase = [Math]::Sin($i / 12.0)
  switch ($Mode) {
    # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE：只改位置，不惊动 Z 序与焦点
    "move" { [void][R5WindowCpu]::SetWindowPos($hwnd, [IntPtr]::Zero, $baseX + [int]($phase * 60), $baseY + [int]($phase * 30), 0, 0, 0x0001 -bor 0x0004 -bor 0x0010) }
    # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE：只改尺寸
    "resize" { [void][R5WindowCpu]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 1100 + [int]($phase * 90), 700 + [int]($phase * 60), 0x0002 -bor 0x0004 -bor 0x0010) }
    "idle" { }
  }
  Start-Sleep -Milliseconds $stepMs
}
$elapsedMs = ((Get-Date) - $start).TotalMilliseconds
$after = Get-Snapshot

$cpuMs = $after.cpuMs - $before.cpuMs
$top = @()
foreach ($id in $after.threads.Keys) {
  $delta = $after.threads[$id] - $before.threads[$id]
  if ($null -ne $delta -and $delta -gt 50) { $top += [pscustomobject]@{ tid = $id; cpuMs = [int]$delta } }
}
$top = $top | Sort-Object cpuMs -Descending | Select-Object -First 6

[pscustomobject]@{
  mode = $Mode
  events = $events
  elapsedMs = [int]$elapsedMs
  appCpuMs = [int]$cpuMs
  cpuMsPerEvent = [math]::Round($cpuMs / $events, 2)
  pctOfOneCore = [math]::Round($cpuMs / $elapsedMs * 100, 2)
  pctOfAllCores = [math]::Round($cpuMs / ($elapsedMs * $cores) * 100, 2)
  dwmCpuMs = [int]($after.dwmMs - $before.dwmMs)
} | Format-List
"热点线程（tid:cpuMs）：" + (($top | ForEach-Object { "$($_.tid):$($_.cpuMs)" }) -join "  ")
