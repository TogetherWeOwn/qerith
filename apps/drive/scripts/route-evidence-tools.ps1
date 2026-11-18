param([Parameter(Mandatory)][ValidateSet('Initialize', 'Acquire', 'Protect')][string]$Phase)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or !$env:ImageOS -or !$env:ImageVersion -or
    $env:GITHUB_REPOSITORY -cne 'TogetherWeOwn/qerith' -or
    ($env:GITHUB_EVENT_NAME -cne 'pull_request' -and
      !($env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch' -and $env:GITHUB_REF -ceq 'refs/heads/main')) -or
    !$env:GITHUB_WORKSPACE -or !$env:RUNNER_TEMP -or !$env:GITHUB_ENV) {
  throw 'Route evidence tools require the admitted ephemeral GitHub-hosted Windows job'
}
if ($env:GITHUB_EVENT_NAME -ceq 'pull_request') {
  $event = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
  $head = $event.pull_request.head
  if ($head.repo.full_name -cne $env:GITHUB_REPOSITORY -or $head.repo.fork -ne $false -or
      $head.sha -cne $env:HARNESS_SHA) { throw 'Expected the admitted same-repository PR head' }
}

$paths = @{
  EVIDENCE = "$env:RUNNER_TEMP/drive-route-evidence"
  GUIDEPUP_SCREEN_READERS_PATH = "$env:RUNNER_TEMP/guidepup"
  FIREFOX_EXE = "$env:RUNNER_TEMP/pw-firefox/firefox/firefox.exe"
}
$evidence = $paths.EVIDENCE

function Get-VerifiedHead($Directory, $ExpectedSha) {
  $checkout = Join-Path $env:GITHUB_WORKSPACE $Directory
  if ($ExpectedSha -cnotmatch '^[0-9a-f]{40}$' -or !(Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
    throw "Expected exact $Directory checkout"
  }
  $head = git -C $checkout rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedSha) { throw "$Directory checkout mismatch" }
  return $head
}

if ($Phase -eq 'Initialize') {
  $harness = Get-VerifiedHead harness $env:HARNESS_SHA
  $source = $null
  if ($env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch') { $source = Get-VerifiedHead source $env:SOURCE_SHA }
  New-Item -ItemType Directory -Path $evidence | Out-Null
  @{ harness = $harness; source = $source; event = $env:GITHUB_EVENT_NAME;
     run = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; os = $env:RUNNER_OS;
     arch = $env:RUNNER_ARCH; image = $env:ImageOS; imageVersion = $env:ImageVersion;
     windows = [Environment]::OSVersion.VersionString } | ConvertTo-Json > "$evidence/provenance.json"
  foreach ($key in $paths.Keys) { "$key=$($paths[$key])" | Add-Content -LiteralPath $env:GITHUB_ENV -Encoding utf8 }
  return
}

if (!(Test-Path -LiteralPath "$evidence/provenance.json" -PathType Leaf)) { throw 'Initialize must run first' }
if ($Phase -eq 'Acquire') {
  $archives = @(
    @{ Name = 'nvda'; URL = 'https://github.com/guidepup/nvda/releases/download/0.2.1-2026.3/guidepup-nvda-0.2.1-2026.3.zip';
       SHA = '508ba38e9a48f4534bfc7fb1fa2f08f2ae10550983a53f1272abbeb50b2d2e19';
       Destination = "$($paths.GUIDEPUP_SCREEN_READERS_PATH)/nvda/all/0.2.1-2026.3/extracted" },
    @{ Name = 'firefox'; URL = 'https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/firefox/1538/firefox-win64.zip';
       SHA = '051f993c915b6b89f4921c4f8d2d6c5ebed98c024ee7d1f6ad54edc427ae5a87';
       Destination = "$env:RUNNER_TEMP/pw-firefox" }
  )
  foreach ($archive in $archives) {
    $file = "$env:RUNNER_TEMP/$($archive.Name).zip"
    if ((Test-Path -LiteralPath $file) -or (Test-Path -LiteralPath $archive.Destination)) {
      throw "Archive path must be fresh for $($archive.Name)"
    }
    Invoke-WebRequest -Uri $archive.URL -OutFile $file -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $archive.SHA) { throw "Digest mismatch for $($archive.Name)" }
    Expand-Archive -LiteralPath $file -DestinationPath $archive.Destination
  }
  $nvda = (Get-Item -LiteralPath "$($archives[0].Destination)/nvda.exe").VersionInfo.ProductVersion
  $firefox = (Get-Item -LiteralPath $paths.FIREFOX_EXE).VersionInfo.ProductVersion
  if (!$nvda -or !$firefox) { throw 'Missing tool product version' }
  @{ NVDA = $nvda; firefox = $firefox; nvdaSHA256 = $archives[0].SHA;
     firefoxSHA256 = $archives[1].SHA } | ConvertTo-Json > "$evidence/tools.json"
  return
}

# IPv6 :: is unspecified, not a TCP destination. Preserve only IPv4/IPv6 loopback.
$nonLoopback = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$ruleName = 'QerithDriveBlockNonLoopbackNvdaRelay'
$expected = @{
  Name = $ruleName; Enabled = 'True'; Direction = 'Inbound'; Action = 'Block'; Profile = 'Any'
  PrimaryStatus = 'OK'; EnforcementStatus = 'Full'; EdgeTraversalPolicy = 'Block'
  Protocol = 'TCP'; LocalPort = '6837'; RemotePort = 'Any'; RemoteAddress = 'Any'
  LocalAddress = ($nonLoopback | Sort-Object) -join ','
  InterfaceAlias = 'Any'; InterfaceType = 'Any'; Program = 'Any'; Service = 'Any'
}

function Assert-RelayBoundary($Actual) {
  foreach ($field in $expected.Keys) {
    if ($Actual[$field] -ine $expected[$field]) { throw "NVDA relay boundary mismatch: $field" }
  }
}

# These controls alter only a synthetic readback, never the actual firewall.
Assert-RelayBoundary $expected
foreach ($field in 'LocalPort', 'LocalAddress') {
  $mock = $expected.Clone()
  $mock[$field] = if ($field -eq 'LocalPort') { '6838' } else { ($nonLoopback[0..1] | Sort-Object) -join ',' }
  try {
    Assert-RelayBoundary $mock
    throw "Synthetic bad $field passed"
  } catch {
    if ($_.Exception.Message -cne "NVDA relay boundary mismatch: $field") { throw }
  }
}

foreach ($serviceName in 'BFE', 'MpsSvc') {
  $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto') { throw "$serviceName must be running and enabled" }
}
$profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
if (($profiles.Name | Sort-Object) -join ',' -ne 'Domain,Private,Public' -or ($profiles | Where-Object {
  $_.Enabled -ne 'True' -or $_.DefaultInboundAction -eq 'Allow' -or
    $_.AllowInboundRules -eq 'False' -or $_.AllowLocalFirewallRules -eq 'False' -or
    ($_.DisabledInterfaceAliases | Where-Object { $_ -and $_ -ne 'NotConfigured' })
})) { throw 'NVDA relay requires effective firewall policy on all profiles and interfaces' }

# Ordinary allow rules cannot override an explicit block. Authenticated bypass rules can.
$bypass = Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Allow |
  Get-NetFirewallSecurityFilter | Where-Object { $_.OverrideBlockRules -eq 'True' }
if ($bypass) { throw 'ActiveStore contains an enabled inbound authenticated bypass rule' }

New-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -DisplayName $ruleName -Enabled True `
  -Direction Inbound -Action Block -Profile Any -Protocol TCP -LocalPort 6837 `
  -LocalAddress $nonLoopback -EdgeTraversalPolicy Block | Out-Null
$rule = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $ruleName)
if ($rule.Count -ne 1) { throw 'Expected exactly one named relay rule in ActiveStore' }
$actual = @{}
foreach ($field in 'Name', 'Enabled', 'Direction', 'Action', 'Profile', 'PrimaryStatus', 'EnforcementStatus', 'EdgeTraversalPolicy') {
  $actual[$field] = $rule[0].$field -join ','
}
$port = $rule[0] | Get-NetFirewallPortFilter
$address = $rule[0] | Get-NetFirewallAddressFilter
$app = $rule[0] | Get-NetFirewallApplicationFilter
if ($app.Package -and $app.Package -ne 'Any') { throw 'Unexpected package filter on relay block' }
$actual.Protocol = $port.Protocol -join ','
$actual.LocalPort = $port.LocalPort -join ','
$actual.RemotePort = $port.RemotePort -join ','
$actual.RemoteAddress = $address.RemoteAddress -join ','
$actual.LocalAddress = ($address.LocalAddress | Sort-Object) -join ','
$actual.InterfaceAlias = ($rule[0] | Get-NetFirewallInterfaceFilter).InterfaceAlias -join ','
$actual.InterfaceType = ($rule[0] | Get-NetFirewallInterfaceTypeFilter).InterfaceType -join ','
$actual.Program = $app.Program -join ','
$actual.Service = ($rule[0] | Get-NetFirewallServiceFilter).Service -join ','
Assert-RelayBoundary $actual

# No removal: the hosted VM's destruction is the end of this protection window.
@{ policyStore = 'ActiveStore'; rule = $actual; profiles = @($profiles.Name);
   syntheticWrongPortRejected = $true; syntheticMissingIPv6Rejected = $true } |
  ConvertTo-Json -Depth 4 > "$evidence/relay.json"
