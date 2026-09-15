# credman.ps1 - read/write ONE Windows Credential Manager generic credential under quoteproof/.
#
# PURE ASCII ON PURPOSE: a BOM-less .ps1 is read as ANSI by PowerShell 5.1.
#
# Adapted from empire-command\rh-agentic-desk\lib\credman.ps1, with its target discipline narrowed
# to this package's own namespace. A reader that could be aimed at any target would be a
# credential-reading tool, not a deploy component.
#
# SECRETS NEVER TRAVEL IN ARGV. Store reads the value from STDIN when stdin is redirected, and
# otherwise prompts with Read-Host -AsSecureString (no echo, no history). Probe and Store print a
# sha256 fingerprint (first 12 hex), never the value. Read writes the value to stdout with no
# newline, for a calling process to capture in memory.
#
# An S4U logon can make CredRead SUCCEED with a zero-length blob; present-but-empty is refused.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File credman.ps1 -Mode Probe  -Target quoteproof/deployer-4663
#   powershell -NoProfile -ExecutionPolicy Bypass -File credman.ps1 -Mode Store  -Target quoteproof/deployer-4663
#   powershell -NoProfile -ExecutionPolicy Bypass -File credman.ps1 -Mode Delete -Target quoteproof/deployer-4663
#
# Exit 0 = ok. Exit 2 = not found / empty. Exit 3 = API or usage error.

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Read','Probe','Store','Delete')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Target
)

$ErrorActionPreference = 'Stop'

if ($Target -notmatch '^quoteproof/[a-z0-9][a-z0-9-]{0,63}$') {
  [Console]::Error.WriteLine('REFUSED: -Target must match ^quoteproof/[a-z0-9][a-z0-9-]{0,63}$ - this reader will not touch any other target.')
  exit 3
}

Add-Type -Namespace QuoteproofCredMan -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags;
  public uint Type;
  public IntPtr TargetName;
  public IntPtr Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize;
  public IntPtr CredentialBlob;
  public uint Persist;
  public uint AttributeCount;
  public IntPtr Attributes;
  public IntPtr TargetAlias;
  public IntPtr UserName;
}
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredDeleteW(string target, uint type, uint flags);
[DllImport("advapi32.dll", SetLastError=false)]
public static extern void CredFree(IntPtr buffer);
'@ | Out-Null

$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2

function Get-Secret {
  param([string]$t)
  $ptr = [IntPtr]::Zero
  $ok = [QuoteproofCredMan.Native]::CredReadW($t, $CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if (-not $ok) { return $null }
  try {
    $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][QuoteproofCredMan.Native+CREDENTIAL])
    if ($c.CredentialBlobSize -eq 0 -or $c.CredentialBlob -eq [IntPtr]::Zero) { return '' }
    $bytes = New-Object byte[] $c.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
    return [System.Text.Encoding]::Unicode.GetString($bytes)
  } finally {
    [QuoteproofCredMan.Native]::CredFree($ptr)
  }
}

function Get-Fingerprint {
  param([string]$v)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($v))
  return (($h | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0,12)
}

switch ($Mode) {
  'Probe' {
    $v = Get-Secret $Target
    if ($null -eq $v) { [Console]::Out.Write('MISSING'); exit 2 }
    if ($v.Length -eq 0) { [Console]::Out.Write('EMPTY'); exit 2 }
    [Console]::Out.Write("OK chars=$($v.Length) fp=$(Get-Fingerprint $v)")
    exit 0
  }
  'Read' {
    $v = Get-Secret $Target
    if ($null -eq $v -or $v.Length -eq 0) { exit 2 }
    [Console]::Out.Write($v)
    exit 0
  }
  'Store' {
    if ([Console]::IsInputRedirected) {
      $secret = [Console]::In.ReadToEnd()
      $secret = $secret -replace "`r", '' -replace "`n", ''
    } else {
      $ss = Read-Host -Prompt "Paste the value for $Target (input is hidden)" -AsSecureString
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
      try { $secret = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
      finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ([string]::IsNullOrWhiteSpace($secret)) { [Console]::Error.WriteLine('REFUSED: empty value - nothing was written.'); exit 3 }
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($secret)
    $blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
      [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      $cred = New-Object QuoteproofCredMan.Native+CREDENTIAL
      $cred.Type = $CRED_TYPE_GENERIC
      $cred.TargetName = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($Target)
      $cred.UserName  = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni('quoteproof')
      $cred.CredentialBlob = $blob
      $cred.CredentialBlobSize = $bytes.Length
      $cred.Persist = $CRED_PERSIST_LOCAL_MACHINE
      $ok = [QuoteproofCredMan.Native]::CredWriteW([ref]$cred, 0)
      [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($cred.TargetName)
      [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($cred.UserName)
      if (-not $ok) { [Console]::Error.WriteLine("CredWriteW failed, error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"); exit 3 }
    } finally {
      for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = 0 }
      [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
    }
    [Console]::Out.Write("STORED $Target fp=$(Get-Fingerprint $secret)")
    exit 0
  }
  'Delete' {
    $ok = [QuoteproofCredMan.Native]::CredDeleteW($Target, $CRED_TYPE_GENERIC, 0)
    if (-not $ok) { [Console]::Out.Write('MISSING'); exit 2 }
    [Console]::Out.Write("DELETED $Target"); exit 0
  }
}
