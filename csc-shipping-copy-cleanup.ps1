# csc-shipping-copy-cleanup.ps1
# Applies the new "£50 free P&P threshold, otherwise £4.95" wording across all
# user-facing copy in the Comic Strip Canvas codebase. Idempotent: safe to run
# multiple times. Reports every change it makes and any expected line it can't
# find (so you'll know if a file has drifted since this script was written).
#
# Run from the project root:
#   cd C:\Users\chris\Projects\comicstripcanvas
#   .\csc-shipping-copy-cleanup.ps1

$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'package.json') -or -not (Test-Path 'src')) {
    Write-Host 'ERROR: run this from the comicstripcanvas project root.' -ForegroundColor Red
    exit 1
}

# Each edit: file path, old text (must match exactly, can be partial line), new text
$edits = @(
    @{
        file = 'src\components\PricingGrid.astro'
        old  = 'All prices include FREE P&P to UK mainland'
        new  = 'FREE P&P on UK mainland orders over £50, otherwise £4.95'
    },
    @{
        file = 'src\layouts\BaseLayout.astro'
        old  = "description = 'Comic Strip Canvas — UK-based pop culture wall art. Bold comic-book style canvas prints, framed prints, and posters. Personalised options available. Free UK P&P.',"
        new  = "description = 'Comic Strip Canvas — UK-based pop culture wall art. Bold comic-book style canvas prints, framed prints, and posters. Personalised options available. FREE UK P&P on orders over £50.',"
    },
    @{
        file = 'src\layouts\BaseLayout.astro'
        old  = '"text": "Currently we ship to mainland UK only, with free P&P included on all orders. We''re working on expanding to Europe and further afield — sign up to our newsletter to be notified when international shipping launches."'
        new  = '"text": "Currently we ship to UK mainland addresses only. FREE P&P on orders over £50, otherwise £4.95 flat-rate UK delivery. We''re working on expanding to Europe and further afield — sign up to our newsletter to be notified when international shipping launches."'
    },
    @{
        file = 'src\pages\store\comic-book-covers.astro'
        old  = 'Bold, vintage-style comic book cover art prints. Iconic figures reimagined as dramatic magazine cover stars. Canvas prints, framed prints & posters from £9.99. Free UK P&P.'
        new  = 'Bold, vintage-style comic book cover art prints. Iconic figures reimagined as dramatic magazine cover stars. Canvas prints, framed prints & posters from £9.99. FREE UK P&P on orders over £50.'
    },
    @{
        file = 'src\pages\store\comic-book-icons.astro'
        old  = 'Bold pop culture icon art prints. Legends from film, music and sport rendered in vivid comic book style. Canvas prints, framed prints & posters from £9.99. Free UK P&P.'
        new  = 'Bold pop culture icon art prints. Legends from film, music and sport rendered in vivid comic book style. Canvas prints, framed prints & posters from £9.99. FREE UK P&P on orders over £50.'
    },
    @{
        file = 'src\pages\store\comic-book-strips.astro'
        old  = 'Bold multi-panel comic strip wall art. Iconic scenes from film, music and sport rendered in vivid comic book style. Canvas prints, framed prints & posters from £9.99. Free UK P&P.'
        new  = 'Bold multi-panel comic strip wall art. Iconic scenes from film, music and sport rendered in vivid comic book style. Canvas prints, framed prints & posters from £9.99. FREE UK P&P on orders over £50.'
    },
    @{
        file = 'src\pages\store\index.astro'
        old  = 'Shop bold comic-book style canvas prints, framed prints & posters from £9.99. Free UK P&P. Browse all styles including personalised options.'
        new  = 'Shop bold comic-book style canvas prints, framed prints & posters from £9.99. FREE UK P&P on orders over £50. Browse all styles including personalised options.'
    },
    @{
        file = 'src\pages\store\personalised.astro'
        old  = 'Transform your photo into personalised comic art — Comic Book Covers, Icons, and Strips. Bespoke comic art, made to order in the UK. From £9.99. Free P&P.'
        new  = 'Transform your photo into personalised comic art — Comic Book Covers, Icons, and Strips. Bespoke comic art, made to order in the UK. From £9.99. FREE UK P&P on orders over £50.'
    },
    @{
        file = 'src\pages\store\personalised.astro'
        old  = "{ step: '04', label: 'It Arrives', desc: 'Printed and dispatched within 3–6 working days. Free P&P to UK mainland.' },"
        new  = "{ step: '04', label: 'It Arrives', desc: 'Printed and dispatched within 3–6 working days. FREE UK P&P on orders over £50, otherwise £4.95.' },"
    },
    @{
        file = 'src\pages\store\personalised.astro'
        old  = 'Poster prints start from £9.99. Canvas prints from £26.99. Personalisation fee: +£10 for Covers and Icons, +£25 for Strips. All orders include free P&P to UK mainland addresses.'
        new  = 'Poster prints start from £9.99. Canvas prints from £26.99. Personalisation fee: +£10 for Covers and Icons, +£25 for Strips. FREE UK P&P on orders over £50, otherwise £4.95 flat-rate UK delivery.'
    },
    @{
        file = 'src\pages\store\personalised.astro'
        old  = "a: 'We send your proof within 24–48 hours of receiving your order. Once you approve it, production and dispatch takes 3–6 working days. All orders include free P&P to UK mainland addresses.',"
        new  = "a: 'We send your proof within 24–48 hours of receiving your order. Once you approve it, production and dispatch takes 3–6 working days. FREE UK P&P on orders over £50, otherwise £4.95 flat-rate UK delivery.',"
    },
    @{
        file = 'src\pages\store\personalised.astro'
        old  = '"acceptedAnswer": { "@type": "Answer", "text": "We send your proof within 24–48 hours of receiving your order. Once you approve it, production and dispatch takes 3–6 working days. All orders include free P&P to UK mainland addresses." }'
        new  = '"acceptedAnswer": { "@type": "Answer", "text": "We send your proof within 24–48 hours of receiving your order. Once you approve it, production and dispatch takes 3–6 working days. FREE UK P&P on orders over £50, otherwise £4.95 flat-rate UK delivery." }'
    },
    @{
        file = 'src\pages\store\[slug].astro'
        old  = "{ icon: '🚚', text: 'Free UK P&P' },"
        new  = "{ icon: '🚚', text: 'FREE UK P&P over £50' },"
    },
    @{
        file = 'src\pages\index.astro'
        old  = 'description="Comic Strip Canvas — UK''s boldest comic-book style wall art. Canvas prints, framed prints & posters. Personalised options available. Free UK P&P."'
        new  = 'description="Comic Strip Canvas — UK''s boldest comic-book style wall art. Canvas prints, framed prints & posters. Personalised options available. FREE UK P&P on orders over £50."'
    },
    @{
        file = 'src\pages\index.astro'
        old  = '<span class="font-source text-gray-400 text-sm">Free UK P&P</span>'
        new  = '<span class="font-source text-gray-400 text-sm">FREE UK P&P over £50</span>'
    },
    @{
        file = 'src\pages\order-confirmation.astro'
        old  = 'Free UK P&P included.'
        new  = 'FREE UK P&P on orders over £50.'
    },
    @{
        file = 'src\pages\terms-and-conditions.astro'
        old  = 'All products are made to order. Prices are displayed in GBP and include VAT where applicable. We reserve the right to change prices at any time, but changes will not affect orders already placed. All prices for UK mainland orders include free postage and packaging.'
        new  = 'All products are made to order. Prices are displayed in GBP and include VAT where applicable. We reserve the right to change prices at any time, but changes will not affect orders already placed. UK mainland orders over £50 include free postage and packaging; orders under £50 are charged a £4.95 flat rate for standard UK delivery.'
    }
)

$changesApplied = 0
$alreadyDone = 0
$notFound = @()
$missingFiles = @()

foreach ($edit in $edits) {
    $path = $edit.file

    if (-not (Test-Path $path)) {
        $missingFiles += $path
        continue
    }

    $content = Get-Content -Path $path -Raw -Encoding UTF8

    if ($content.Contains($edit.new)) {
        $alreadyDone++
        Write-Host "  SKIP (already done)  $path" -ForegroundColor DarkGray
        continue
    }

    if (-not $content.Contains($edit.old)) {
        $notFound += @{ file = $path; old = $edit.old }
        Write-Host "  MISS                 $path" -ForegroundColor Yellow
        continue
    }

    $newContent = $content.Replace($edit.old, $edit.new)

    # Write back without BOM, preserving the existing line endings the file already used
    [System.IO.File]::WriteAllText((Resolve-Path $path), $newContent, [System.Text.UTF8Encoding]::new($false))
    $changesApplied++
    Write-Host "  CHANGED              $path" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "  Changes applied : $changesApplied"
Write-Host "  Already updated : $alreadyDone"
Write-Host "  Misses          : $($notFound.Count)"
Write-Host "  Missing files   : $($missingFiles.Count)"

if ($missingFiles.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing files (script will skip these):" -ForegroundColor Yellow
    $missingFiles | ForEach-Object { Write-Host "  $_" }
}

if ($notFound.Count -gt 0) {
    Write-Host ""
    Write-Host "Files where the old text could not be matched exactly:" -ForegroundColor Yellow
    Write-Host "(this usually means the file has been edited since this script was written)" -ForegroundColor Yellow
    foreach ($miss in $notFound) {
        Write-Host ""
        Write-Host "  $($miss.file)" -ForegroundColor Yellow
        Write-Host "    looking for: $($miss.old.Substring(0, [Math]::Min(120, $miss.old.Length)))..."
    }
}

Write-Host ""
Write-Host "Sweep verification:" -ForegroundColor Cyan
Get-ChildItem -Path src -Recurse -Include *.astro,*.ts,*.tsx,*.jsx,*.md,*.mdx |
    Select-String -Pattern "[Ff]ree.{0,3}P&P|[Ff]ree.{0,3}[Pp]ostage|[Ff]ree.{0,3}[Dd]elivery|[Ff]ree.{0,3}[Ss]hipping" |
    Where-Object { $_.Path -notmatch "node_modules|\.astro\\|dist\\" } |
    Where-Object { $_.Line -notmatch "//|/\*|\*|FREE_SHIPPING_THRESHOLD|qualifiesForFreeShipping|amountToFreeShipping|over £50|free-shipping progress|FREE UK P&P over £50|FREE UK delivery|FREE P&P on" } |
    ForEach-Object { Write-Host "  STILL PRESENT: $($_.Path):$($_.LineNumber): $($_.Line.Trim())" -ForegroundColor Magenta }

Write-Host ""
Write-Host 'Done. Review with: git diff' -ForegroundColor Cyan
