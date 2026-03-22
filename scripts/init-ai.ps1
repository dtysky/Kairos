$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$IDEs = @(".cursor")
$Dirs = @("rules", "skills")

Write-Host "Initializing AI tools integration..."
Write-Host "  Platform: Windows"
Write-Host "  Root:     $Root"
Write-Host ""

foreach ($dir in @(".ai\rules", ".ai\skills")) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

foreach ($ide in $IDEs) {
    if (-not (Test-Path $ide)) {
        New-Item -ItemType Directory -Path $ide -Force | Out-Null
    }

    foreach ($dir in $Dirs) {
        $link = Join-Path $ide $dir
        $absTarget = Join-Path $Root ".ai" $dir

        if (Test-Path $link) {
            $existing = Get-Item $link -Force
            if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                if ($existing.Target -eq $absTarget) {
                    Write-Host "  ✓ $ide\$dir (already correct)"
                    continue
                }
                $existing.Delete()
            } else {
                Write-Host "  ⚠ $ide\$dir is a real directory, removing..."
                Remove-Item $link -Recurse -Force
            }
        }

        New-Item -ItemType Junction -Path $link -Target $absTarget | Out-Null
        Write-Host "  ✓ $ide\$dir → .ai\$dir"
    }
}

Write-Host ""
Write-Host "Done!"
