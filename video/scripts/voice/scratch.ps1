# Scratch narration for the animatic: Windows' own speech voice (no ElevenLabs characters), one WAV per scene, plus
# word start times from the synthesizer's progress events.
#   powershell -File scripts/voice/scratch.ps1 <scene id> "<text>" <out wav> <out json>
param([string]$id, [string]$text, [string]$wav, [string]$json)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice("Microsoft Zira Desktop")
$s.Rate = -1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($wav, $fmt)
$words = New-Object System.Collections.ArrayList
Register-ObjectEvent -InputObject $s -EventName SpeakProgress -SourceIdentifier "prog$id" -Action {
  $e = $EventArgs
  [void]$Event.MessageData.Add(@{ t = $e.AudioPosition.TotalSeconds; c = $e.CharacterPosition; n = $e.CharacterCount; w = $e.Text })
} -MessageData $words | Out-Null
$s.Speak($text)
Start-Sleep -Milliseconds 200
Unregister-Event -SourceIdentifier "prog$id"
$s.SetOutputToNull()
$s.Dispose()
@{ id = $id; text = $text; voice = "Microsoft Zira Desktop (scratch)"; words = $words } | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $json
