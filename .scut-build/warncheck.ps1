$ErrorActionPreference = 'Continue'
$studio = 'D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio'
$proj   = 'D:\22车队管理\一轮考核\视觉组\集成仿真环境测试\scut71-project'

$common = @(
  '-std=c11','-Wall','-Wextra'
)
$inc = @(
  ('-I' + (Join-Path $studio 'core\include')),
  ('-I' + (Join-Path $studio 'core\src')),
  ('-I' + $proj),
  ('-I' + (Join-Path $proj '.scut\gen')),
  ('-I' + (Join-Path $proj 'code'))
)
$src = Join-Path $studio 'backends\headless\scut_headless_main.c'

foreach ($mode in @(@('-O2','-DNDEBUG'), @('-g','-O0'))) {
  foreach ($cc in @(@('gcc', 'gcc'), @('clang', 'D:\TOOLS\llvm-mingw\bin\clang.exe'))) {
    $label = "$($cc[0]) $($mode -join ' ')"
    Write-Output "=============== $label ==============="
    $out = Join-Path $env:TEMP ("wc_" + $cc[0] + "_" + ($mode[0] -replace '[^a-zA-Z0-9]','') + ".o")
    $args = @($common + $mode + $inc + @('-c', $src, '-o', $out))
    $log = Join-Path $env:TEMP ("wc_" + $cc[0] + ".log")
    & $cc[1] @args 2>&1 | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
    $lines = (Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -match 'warning|error' })
    Write-Output "exit=$code  warning/error lines=$(@($lines).Count)"
    if (@($lines).Count -gt 0) { $lines | ForEach-Object { Write-Output "  $_" } }
    Write-Output ""
  }
}
