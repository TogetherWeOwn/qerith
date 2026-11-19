$ErrorActionPreference = 'Stop'
$pr = gh api repos/TogetherWeOwn/qerith/pulls/183 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $pr.state -cne 'open' -or $pr.base.ref -cne 'main' -or
    $pr.head.repo.full_name -cne $env:GITHUB_REPOSITORY -or $pr.head.repo.fork -ne $false -or
    $pr.head.sha -cne $env:SOURCE_SHA) { throw 'My Drive product PR is not at its admitted head' }
