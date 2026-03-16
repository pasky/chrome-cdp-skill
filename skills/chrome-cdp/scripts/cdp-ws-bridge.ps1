param(
  [Parameter(Mandatory = $true)]
  [string]$WsUrl
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-ErrorText {
  param([System.Exception]$Exception)
  $current = $Exception
  while ($current.InnerException) {
    $current = $current.InnerException
  }
  return $current.Message
}

$cts = [System.Threading.CancellationTokenSource]::new()
$ws = [System.Net.WebSockets.ClientWebSocket]::new()

try {
  $uri = [Uri]$WsUrl
  $null = $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult()
  [Console]::Error.WriteLine('READY')
} catch {
  [Console]::Error.WriteLine('ERROR: ' + (Get-ErrorText $_.Exception))
  exit 1
}

$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
$buffer = New-Object byte[] 65536
$builder = [System.Text.StringBuilder]::new()
$stdinTask = $stdin.ReadLineAsync()
$socketTask = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buffer), $cts.Token)
$stdinClosed = $false

try {
  while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -or
         $ws.State -eq [System.Net.WebSockets.WebSocketState]::CloseSent -or
         $ws.State -eq [System.Net.WebSockets.WebSocketState]::CloseReceived) {
    $tasks = if ($stdinClosed) { @($socketTask) } else { @($stdinTask, $socketTask) }
    $completedIndex = [System.Threading.Tasks.Task]::WaitAny($tasks)

    if (-not $stdinClosed -and $completedIndex -eq 0) {
      $line = $stdinTask.Result
      if ($null -eq $line) {
        $stdinClosed = $true
        try {
          if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -or $ws.State -eq [System.Net.WebSockets.WebSocketState]::CloseReceived) {
            $null = $ws.CloseOutputAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'stdin closed', [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
          }
        } catch {}
      } else {
        if ($line.Length -gt 0) {
          $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
          $segment = [System.ArraySegment[byte]]::new($bytes)
          $null = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
        }
        $stdinTask = $stdin.ReadLineAsync()
      }
      continue
    }

    $result = $socketTask.Result
    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
      break
    }

    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Text) {
      $null = $builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
      if ($result.EndOfMessage) {
        [Console]::Out.WriteLine($builder.ToString())
        [Console]::Out.Flush()
        $null = $builder.Clear()
      }
    }

    $socketTask = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buffer), $cts.Token)
  }
} catch {
  if (-not $cts.IsCancellationRequested) {
    [Console]::Error.WriteLine('ERROR: ' + (Get-ErrorText $_.Exception))
    exit 1
  }
} finally {
  $cts.Cancel()
  $stdin.Dispose()
  $ws.Dispose()
}
