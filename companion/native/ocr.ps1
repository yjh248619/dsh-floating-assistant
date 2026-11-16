param([string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, [Type]$type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $language = New-Object Windows.Globalization.Language 'zh-Hans'
  $engine = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::TryCreateFromLanguage($language)
}
if ($null -eq $engine) {
  Write-Output 'NO_ENGINE'
  exit 2
}

$file = Await ([Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode,Windows.Foundation,ContentType=WindowsRuntime]::Read)) ([Windows.Storage.Streams.IRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

Write-Output '<<<TEXT>>>'
Write-Output $result.Text
Write-Output '<<<END>>>'
