# csc-personalise-shipping-patch.ps1 (revised)
# Patches src/pages/api/personalise.ts to apply £50 free P&P threshold with £4.95
# fallback to the shipping_rate. The file's indentation is one extra level deeper
# than I first assumed because it's wrapped in a try block — anchors corrected.
#
# Idempotent: safe to run multiple times.
#
# Run from project root:
#   cd C:\Users\chris\Projects\comicstripcanvas
#   .\csc-personalise-shipping-patch.ps1

$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'package.json') -or -not (Test-Path 'src')) {
    Write-Host 'ERROR: run this from the comicstripcanvas project root.' -ForegroundColor Red
    exit 1
}

$path = 'src\pages\api\personalise.ts'
if (-not (Test-Path $path)) {
    Write-Host "ERROR: file not found: $path" -ForegroundColor Red
    exit 1
}

# Read original file as UTF-8
$content = Get-Content -Path $path -Raw -Encoding UTF8

# Build old/new strings programmatically to avoid here-string indentation traps.
# Indent levels in this file: 6, 8, 10, 12, 14 spaces (one deeper than checkout.ts
# because everything is inside a try block).

$old_shipping = (
    "      shipping_options: [`r`n" +
    "        {`r`n" +
    "          shipping_rate_data: {`r`n" +
    "            type: 'fixed_amount',`r`n" +
    "            fixed_amount: { amount: 0, currency: 'gbp' },`r`n" +
    "            display_name: 'Free UK P&P',`r`n" +
    "            delivery_estimate: {`r`n" +
    "              minimum: { unit: 'business_day', value: 5 },`r`n" +
    "              maximum: { unit: 'business_day', value: 10 },`r`n" +
    "            },`r`n" +
    "          },`r`n" +
    "        },`r`n" +
    "      ],`r`n"
)

$new_shipping = (
    "      shipping_options: [`r`n" +
    "        {`r`n" +
    "          shipping_rate_data: {`r`n" +
    "            type: 'fixed_amount',`r`n" +
    "            fixed_amount: {`r`n" +
    "              amount: qualifiesForFreeShipping ? 0 : STANDARD_SHIPPING_PENCE,`r`n" +
    "              currency: 'gbp',`r`n" +
    "            },`r`n" +
    "            display_name: qualifiesForFreeShipping`r`n" +
    "              ? 'FREE UK delivery (orders over £50)'`r`n" +
    "              : 'Standard UK delivery',`r`n" +
    "            delivery_estimate: {`r`n" +
    "              minimum: { unit: 'business_day', value: 5 },`r`n" +
    "              maximum: { unit: 'business_day', value: 10 },`r`n" +
    "            },`r`n" +
    "          },`r`n" +
    "        },`r`n" +
    "      ],`r`n"
)

# Also try LF-only line endings in case the file uses Unix line endings
$old_shipping_lf = $old_shipping -replace "`r`n", "`n"
$new_shipping_lf = $new_shipping -replace "`r`n", "`n"

$changesApplied = 0
$alreadyDone = 0
$notFound = $false

# Idempotency check
if ($content.Contains('qualifiesForFreeShipping ? 0 : STANDARD_SHIPPING_PENCE')) {
    $alreadyDone++
    Write-Host "  SKIP (already done)  Apply conditional shipping rate" -ForegroundColor DarkGray
}
elseif ($content.Contains($old_shipping)) {
    $content = $content.Replace($old_shipping, $new_shipping)
    $changesApplied++
    Write-Host "  CHANGED              Apply conditional shipping rate (CRLF)" -ForegroundColor Green
}
elseif ($content.Contains($old_shipping_lf)) {
    $content = $content.Replace($old_shipping_lf, $new_shipping_lf)
    $changesApplied++
    Write-Host "  CHANGED              Apply conditional shipping rate (LF)" -ForegroundColor Green
}
else {
    $notFound = $true
    Write-Host "  MISS                 Apply conditional shipping rate" -ForegroundColor Yellow
}

if ($changesApplied -gt 0) {
    [System.IO.File]::WriteAllText((Resolve-Path $path), $content, [System.Text.UTF8Encoding]::new($false))
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "  Changes applied : $changesApplied"
Write-Host "  Already updated : $alreadyDone"
Write-Host "  Misses          : $(if ($notFound) {1} else {0})"

if ($notFound) {
    Write-Host ""
    Write-Host "Could not match the shipping_options block. The file may have been edited" -ForegroundColor Yellow
    Write-Host "since this script was written. Run the diagnostic command from the previous" -ForegroundColor Yellow
    Write-Host "chat turn and paste the output." -ForegroundColor Yellow
}

Write-Host ""
Write-Host 'Done. Review with: git diff src/pages/api/personalise.ts' -ForegroundColor Cyan
