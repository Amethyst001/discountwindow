<#
  make-scan.ps1 — renders a proof-of-delivery as a *raster only*, i.e. a photograph of a piece of
  paper with no text layer anywhere in the file. The app's text reader cannot see a word of it; only
  a vision pass can. Used to prove the vision pre-pass rather than claim it.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-scan.ps1 -Out temp/scan.jpg
#>
param(
  [string]$Out = 'temp/scanned-pod.jpg',
  [double]$Angle = 1.7,
  [string]$Ref = 'A-1052',
  [string]$Tracking = '774120098765',
  [string]$Po = 'PO-88460'
)

Add-Type -AssemblyName System.Drawing

$W = 900
$H = 1280
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Paper
$paper = [System.Drawing.Brushes]::White
$g.Clear([System.Drawing.Color]::FromArgb(255, 246, 242, 232))

$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 22, 18))
$grey = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 96, 92, 84))
$rule = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 120, 116, 108), 1)

function PickFont([string]$name, [single]$size) {
  try {
    $f = New-Object System.Drawing.Font $name, $size
    if ($f.Name -like $name) { return $f }
    $f.Dispose()
  } catch { }
  return (New-Object System.Drawing.Font ([System.Drawing.FontFamily]::GenericMonospace, $size))
}

$mono = PickFont 'Consolas' 20
$head = PickFont 'Georgia' 22
$small = PickFont 'Consolas' 15
$script = PickFont 'Ink Free' 32

# Everything below is drawn on a rotated layer so the "photo" is not square to the camera.
$state = $g.Save()
$g.TranslateTransform([float]($W / 2), [float]($H / 2))
$g.RotateTransform([float]$Angle)
$g.TranslateTransform([float](-$W / 2), [float](-$H / 2))

# The receipt sheet itself
$g.FillRectangle($paper, 60, 70, 780, 1080)
$g.DrawRectangle($rule, 60, 70, 780, 1080)

$g.DrawString('NORTHWIND FREIGHT  -  PROOF OF DELIVERY', $head, $ink, 92, 104)
$g.DrawLine($rule, 92, 152, 812, 152)

$lines = @(
  'Doc type:  bill of lading / delivery receipt',
  'Carrier:   FedEx',
  "Tracking number: $Tracking",
  'Status:    DELIVERED',
  'Delivered on: 2026-10-27 at 14:05',
  'Consignee: Halcyon Retail Group',
  'Ship to:   4400 Congress Ave, Austin TX 78701',
  "Customer PO: $Po",
  "Reference: INV $Ref",
  'Pieces: 3   Weight: 412 lb'
)
$y = 176
foreach ($l in $lines) {
  $g.DrawString($l, $mono, $ink, 92, $y)
  $y += 38
}

$g.DrawString('SIGNED BY (print):', $small, $grey, 92, ($y + 26))
$g.DrawString('R. OKONKO', $mono, $ink, 330, ($y + 18))
$g.DrawString('Signature:', $small, $grey, 92, ($y + 96))
$g.DrawString('R. Okonko', $script, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 26, 42, 122))), 240, ($y + 74))
$g.DrawLine($rule, 240, ($y + 136), 700, ($y + 136))
$g.DrawString('Signature captured on device. Retain 90 days.', $small, $grey, 92, ($y + 156))

# Carrier stamp, rotated against the sheet
$stampState = $g.Save()
$g.TranslateTransform(640, 900)
$g.RotateTransform(-11)
$stampPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 32, 68, 150), 3)
$stampBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 32, 68, 150))
$g.DrawRectangle($stampPen, -140, -46, 280, 92)
$g.DrawString('RECEIVED', $head, $stampBrush, -110, -40)
$g.DrawString('2026 OCT 27  PM 2:11', $small, $stampBrush, -112, 14)
$g.Restore($stampState)

$g.Restore($state)

# Sensor noise and edge falloff, so it reads as a photo rather than a clean render
$rand = New-Object System.Random 20261027
for ($i = 0; $i -lt 26000; $i++) {
  $x = $rand.Next(0, $W)
  $yy = $rand.Next(0, $H)
  $a = 8 + $rand.Next(0, 16)
  $c = $rand.Next(0, 90)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, $c, $c, $c))), $x, $yy, 1, 1)
}
for ($band = 0; $band -lt 90; $band++) {
  $alpha = [int](7 * (90 - $band) / 12)
  $shade = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([Math]::Min(90, $alpha), 20, 18, 14))
  $g.FillRectangle($shade, 0, $band, $W, 1)
  $g.FillRectangle($shade, 0, $H - $band - 1, $W, 1)
  $g.FillRectangle($shade, $band, 0, 1, $H)
  $g.FillRectangle($shade, $W - $band - 1, 0, 1, $H)
  $shade.Dispose()
}
$g.Dispose()

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Host ("wrote {0} ({1} bytes, no text layer)" -f $Out, (Get-Item $Out).Length)
